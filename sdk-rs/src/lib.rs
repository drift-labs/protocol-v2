//! Drift SDK

use std::{collections::HashMap, sync::Arc};

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use constants::{state_account, PerpMarketConfig, SpotMarketConfig};
use drift_program::{
    controller::position::PositionDirection,
    math::constants::QUOTE_SPOT_MARKET_INDEX,
    state::{
        order_params::OrderParams,
        user::{MarketType, Order, OrderStatus, PerpPosition, SpotPosition, User},
    },
};
use futures_util::stream::StreamExt;
use solana_account_decoder::UiAccountEncoding;
use solana_client::{
    nonblocking::{pubsub_client::PubsubClient, rpc_client::RpcClient},
    rpc_config::RpcAccountInfoConfig,
};
pub use solana_sdk::pubkey::Pubkey;
use solana_sdk::{
    account::{Account, AccountSharedData, ReadableAccount},
    commitment_config::{CommitmentConfig, CommitmentLevel},
    instruction::{AccountMeta, Instruction},
    signature::{keypair_from_seed, Keypair, Signature},
    signer::Signer,
    transaction::Transaction,
};
use tokio::sync::{
    watch::{self, Receiver},
    RwLock,
};

pub mod constants;
pub mod types;
use types::*;
pub mod utils;

/// Drift Client API
///
/// Cheaply clonable
#[derive(Clone)]
pub struct DriftClient {
    backend: &'static DriftClientBackend,
}

impl DriftClient {
    pub async fn new(endpoint: &str) -> Result<Self, SdkError> {
        Ok(Self {
            backend: Box::leak(Box::new(DriftClientBackend::new(endpoint).await?)),
        })
    }
    /// Transparently subscribe to account updates for a given account/sub-account, enabling more efficient, cached queries.
    ///
    /// This does not return anything but allows subsequent queries to benefit.
    ///
    /// Useful for long-lived workloads expecting to query the same account frequently.
    ///
    /// In contrast, the default behaviour is to _always_ fetch the account data via network request which maybe better for ad-hoc workloads.
    pub async fn subscribe_account(&self, wallet: &Wallet) -> Result<(), SdkError> {
        self.backend.subscribe_account(wallet.user()).await
    }

    /// Get all the account's open orders
    pub async fn all_orders(&self, wallet: &Wallet) -> Result<Vec<Order>, SdkError> {
        let user = self.backend.get_account(wallet.user()).await?;

        Ok(user
            .orders
            .iter()
            .filter(|o| o.status == OrderStatus::Open)
            .copied()
            .collect())
    }

    /// Get all the account's active positions
    pub async fn all_positions(
        &self,
        wallet: &Wallet,
    ) -> Result<(Vec<SpotPosition>, Vec<PerpPosition>), SdkError> {
        let user = self.backend.get_account(wallet.user()).await?;

        Ok((
            user.spot_positions
                .iter()
                .filter(|s| !s.is_available())
                .copied()
                .collect(),
            user.perp_positions
                .iter()
                .filter(|p| !p.is_available())
                .copied()
                .collect(),
        ))
    }

    /// Get a perp position by market
    pub async fn perp_position(
        &self,
        wallet: &Wallet,
        market: MarketId,
    ) -> Result<Option<PerpPosition>, SdkError> {
        let user = self.backend.get_account(wallet.user()).await?;

        Ok(user
            .perp_positions
            .iter()
            .find(|p| p.market_index == market.index)
            .copied())
    }

    /// Get a spot position by market
    pub async fn spot_position(
        &self,
        wallet: &Wallet,
        market: MarketId,
    ) -> Result<Option<SpotPosition>, SdkError> {
        let user = self.backend.get_account(wallet.user()).await?;

        Ok(user
            .spot_positions
            .iter()
            .find(|p| p.market_index == market.index)
            .copied())
    }

    /// Get the user account data
    pub async fn get_account_data(&self, wallet: &Wallet) -> Result<User, SdkError> {
        self.backend.get_account(wallet.user()).await
    }

    /// Sign and send a tx to the network
    ///
    /// Returns the signature on success
    pub async fn sign_and_send(
        &self,
        wallet: &Wallet,
        tx: Transaction,
    ) -> Result<Signature, SdkError> {
        self.backend.sign_and_send(wallet, tx).await
    }
}

/// Provides the heavy-lifting and network facing features of the SDK
/// It is intended to be a singleton
pub struct DriftClientBackend {
    rpc_client: RpcClient,
    ws_client: PubsubClient,
    account_cache: RwLock<HashMap<Pubkey, Receiver<User>>>,
}

impl DriftClientBackend {
    const fn rpc_config() -> RpcAccountInfoConfig {
        RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64Zstd),
            data_slice: None,
            commitment: Some(CommitmentConfig {
                commitment: CommitmentLevel::Confirmed,
            }),
            min_context_slot: None,
        }
    }
    /// Initialize a new `DriftClientBackend`
    async fn new(endpoint: &str) -> Result<DriftClientBackend, SdkError> {
        let rpc_client = RpcClient::new(endpoint.to_string());

        let ws_url = if endpoint.starts_with("https://") {
            let uri = endpoint.strip_prefix("https://").unwrap();
            format!("wss://{}", uri)
        } else {
            let uri = endpoint.strip_prefix("http://").expect("valid http(s) URI");
            format!("ws://{}", uri)
        };

        let ws_client = PubsubClient::new(&ws_url).await?;

        Ok(Self {
            rpc_client,
            ws_client,
            account_cache: Default::default(),
        })
    }

    /// Setup a subscription for account/sub-account updates
    ///
    /// Provides event-driven updates and caching of the account data, reducing RPC calls for queries related to this account
    async fn subscribe_account(&'static self, account: &Pubkey) -> Result<(), SdkError> {
        // debug!(target: "drift", "using PDA: {}", &account_drift_pda);

        // scope the lock
        {
            let cache = self.account_cache.read().await;
            if cache.contains_key(account) {
                return Ok(());
            }
        }

        // fetch initial account data, stream only updates on changes
        let user: User = self.get_account(account).await?;
        let (tx, rx) = watch::channel(user);

        {
            let mut cache = self.account_cache.write().await;
            cache.insert(*account, rx);
        }

        // TODO: handle unsub
        let (mut account_stream, _unsub) = self
            .ws_client
            .account_subscribe(account, Some(Self::rpc_config()))
            .await?;

        tokio::spawn(async move {
            while let Some(response) = account_stream.next().await {
                let account_data = response
                    .value
                    .decode::<AccountSharedData>()
                    .expect("account");
                let mut data = account_data.data();
                let user = User::try_deserialize(&mut data).expect("ok");
                tx.send(user).expect("sent");
            }
        });

        Ok(())
    }

    /// Fetch drift account data (PDA) for `account`
    async fn get_account(&self, account: &Pubkey) -> Result<User, SdkError> {
        if let Some(rx) = self.account_cache.read().await.get(account) {
            Ok(*rx.borrow())
        } else {
            let account_data: Account = self.rpc_client.get_account(account).await?;
            User::try_deserialize(&mut account_data.data.as_ref())
                .map_err(|_err| SdkError::InvalidAccount)
        }
    }

    /// Sign and send a tx to the network
    ///
    /// Returns the signature on success
    pub async fn sign_and_send(
        &self,
        wallet: &Wallet,
        mut tx: Transaction,
    ) -> Result<Signature, SdkError> {
        let recent_block_hash = self.rpc_client.get_latest_blockhash().await?;
        tx.sign(&[wallet.authority_pair()], recent_block_hash);
        self.rpc_client
            .send_transaction(&tx)
            .await
            .map_err(|err| err.into())
    }
}

/// Composable Tx builder for Drift program
///
/// ```no_run
/// let tx = TransactionBuilder::new(wallet, user)
///     .cancel_all_orders()
///     .place_orders(..)
///     .build();
/// ```
///
pub struct TransactionBuilder<'a> {
    wallet: &'a Wallet,
    user: &'a User,
    ixs: Vec<Instruction>,
}

impl<'a> TransactionBuilder<'a> {
    pub fn new<'b, 'c>(wallet: &'b Wallet, user: &'b User) -> Self
    where
        'b: 'a,
        'c: 'a,
    {
        Self {
            wallet,
            user,
            ixs: Default::default(),
        }
    }
    /// Place new orders for account
    pub fn place_orders(mut self, orders: Vec<OrderParams>) -> Self {
        let readable_accounts: Vec<MarketId> = orders
            .iter()
            .map(|o| (o.market_index, o.market_type).into())
            .collect();

        let accounts = build_accounts(
            self.wallet.context(),
            drift_program::accounts::PlaceOrder {
                state: *state_account(),
                authority: self.wallet.authority(),
                user: *self.wallet.user(),
            },
            self.user,
            readable_accounts.as_ref(),
            &[],
        );

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift_program::instruction::PlaceOrders {
                params: orders,
            }),
        };

        self.ixs.push(ix);

        self
    }

    /// Cancel all orders for account
    pub fn cancel_all_orders(mut self) -> Self {
        let accounts = build_accounts(
            self.wallet.context(),
            drift_program::accounts::CancelOrder {
                state: *state_account(),
                authority: self.wallet.authority(),
                user: *self.wallet.user(),
            },
            self.user,
            &[],
            &[],
        );

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift_program::instruction::CancelOrders {
                market_index: None,
                market_type: None,
                direction: None,
            }),
        };
        self.ixs.push(ix);

        self
    }

    /// Cancel account's orders matching some criteria
    ///
    /// `market` - tuple of market ID and type (spot or perp)
    ///
    /// `direction` - long or short
    pub fn cancel_orders(
        mut self,
        market: (u16, MarketType),
        direction: Option<PositionDirection>,
    ) -> Self {
        let (idx, kind) = market;
        let accounts = build_accounts(
            self.wallet.context(),
            drift_program::accounts::CancelOrder {
                state: *state_account(),
                authority: self.wallet.authority(),
                user: *self.wallet.user(),
            },
            self.user,
            &[(idx, kind).into()],
            &[],
        );

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift_program::instruction::CancelOrders {
                market_index: Some(idx),
                market_type: Some(kind),
                direction,
            }),
        };
        self.ixs.push(ix);

        self
    }

    /// Cancel orders given ids
    pub fn cancel_orders_by_id(mut self, order_ids: Vec<u32>) -> Self {
        let accounts = build_accounts(
            self.wallet.context(),
            drift_program::accounts::CancelOrder {
                state: *state_account(),
                authority: self.wallet.authority(),
                user: *self.wallet.user(),
            },
            self.user,
            &[],
            &[],
        );

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift_program::instruction::CancelOrdersByIds {
                order_ids,
            }),
        };
        self.ixs.push(ix);

        self
    }

    /// Build the transaction ready for signing and sending
    pub fn build(self) -> Transaction {
        Transaction::new_with_payer(self.ixs.as_ref(), Some(&self.wallet.authority()))
    }
}

/// Builds a set of required accounts from a user's open positions and additional given accounts
///
/// `base_accounts` base anchor accounts
///
/// `user` Drift user account data
///
/// `markets_readable` IDs of markets to include as readable
///
/// `markets_writable` ` IDs of markets to include as writable (takes priority over readable)
///
/// # Panics
///  if the user has positions in an unknown market (i.e unsupported by the SDK)
fn build_accounts(
    context: Context,
    base_accounts: impl ToAccountMetas,
    user: &User,
    markets_readable: &[MarketId],
    markets_writable: &[MarketId],
) -> Vec<AccountMeta> {
    // the order of accounts returned must be instruction, oracles, spot, perps see (https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/instructions/optional_accounts.rs#L28)
    let mut seen = [0_u64; 2]; // [oracle, spot, perp]
    let mut accounts = Vec::<AccountType>::default();

    // add accounts to the ordered list
    let mut include_market = |market_index: u16, market_type: MarketType, writable: bool| {
        let index_bit = 1_u64 << market_index as u8;
        // always safe since market type is 0 or 1
        let seen_by_type = unsafe { seen.get_unchecked_mut(market_type as usize % 2) };
        if *seen_by_type & index_bit > 0 {
            return;
        }
        *seen_by_type |= index_bit;

        let (account, oracle) = match market_type {
            MarketType::Spot => {
                let SpotMarketConfig {
                    account, oracle, ..
                } = constants::spot_market_by_index(context, market_index);
                (
                    AccountType::Spot {
                        pubkey: *account,
                        writable,
                    },
                    oracle,
                )
            }
            MarketType::Perp => {
                let PerpMarketConfig {
                    account, oracle, ..
                } = constants::perp_market_by_index(context, market_index);
                (
                    AccountType::Perp {
                        pubkey: *account,
                        writable,
                    },
                    oracle,
                )
            }
        };
        if let Err(idx) = accounts.binary_search(&account) {
            accounts.insert(idx, account);
        }
        let oracle = AccountType::Oracle { pubkey: *oracle };
        if let Err(idx) = accounts.binary_search(&oracle) {
            accounts.insert(idx, oracle);
        }
    };

    for MarketId { index, kind } in markets_writable {
        include_market(*index, *kind, true);
    }

    for MarketId { index, kind } in markets_readable {
        include_market(*index, *kind, false);
    }

    // Drift program performs margin checks which requires reading user positions
    for p in user.spot_positions.iter().filter(|p| !p.is_available()) {
        include_market(p.market_index, MarketType::Spot, false);
    }
    for p in user.perp_positions.iter().filter(|p| !p.is_available()) {
        include_market(p.market_index, MarketType::Perp, false);
    }

    // always manually try to include the quote (USDC) market
    // TODO: this is not exactly the same semantics as the TS sdk
    include_market(QUOTE_SPOT_MARKET_INDEX, MarketType::Spot, false);

    let mut account_metas = base_accounts.to_account_metas(None);
    account_metas.extend(accounts.into_iter().map(Into::into));
    account_metas
}

/// Drift wallet
#[derive(Clone, Debug)]
pub struct Wallet {
    authority: Arc<Keypair>,
    user: Pubkey,
    stats: Pubkey,
    sub_account_id: u16,
    context: Context,
}

impl Wallet {
    /// Init wallet from a string that could be either a file path or the encoded key, uses default sub-account
    ///
    /// `context` - target deployed program/network
    pub fn try_from_str(context: Context, path_or_key: &str) -> Result<Self, String> {
        let authority =
            utils::load_keypair_multi_format(path_or_key).map_err(|_| "invalid key".to_string())?;
        Ok(Self::with_sub_account(context, authority, 0))
    }
    /// Init wallet from base58 encoded seed, uses default sub-account
    ///
    /// `context` - target deployed program/network
    ///
    /// # panics
    /// if the key is invalid
    pub fn from_seed_bs58(context: Context, seed: &str) -> Self {
        let authority: Keypair = Keypair::from_base58_string(seed);
        Self::with_sub_account(context, authority, 0)
    }
    /// Init wallet from seed bytes, uses default sub-account
    ///
    /// `context` - target deployed program/network
    pub fn from_seed(context: Context, seed: &[u8]) -> Result<Self, String> {
        let authority: Keypair = keypair_from_seed(seed).map_err(|err| err.to_string())?;
        Ok(Self::with_sub_account(context, authority, 0))
    }
    /// Init wallet with given sub-account
    ///
    /// `authority` keypair for tx signing
    /// `context` - target deployed program/network
    pub fn with_sub_account(context: Context, authority: Keypair, sub_account_id: u16) -> Self {
        Self {
            user: Wallet::derive_user_account(
                &authority.pubkey(),
                sub_account_id,
                &constants::PROGRAM_ID,
            ),
            stats: Wallet::derive_stats_account(&authority.pubkey(), &constants::PROGRAM_ID),
            authority: Arc::new(authority),
            sub_account_id,
            context,
        }
    }
    /// Calculate the address of a drift user account/sub-account
    pub fn derive_user_account(account: &Pubkey, sub_account_id: u16, program: &Pubkey) -> Pubkey {
        let (account_drift_pda, _seed) = Pubkey::find_program_address(
            &[
                &b"user"[..],
                account.as_ref(),
                &sub_account_id.to_le_bytes(),
            ],
            program,
        );
        account_drift_pda
    }
    /// Calculate the address of a drift stats account
    pub fn derive_stats_account(account: &Pubkey, program: &Pubkey) -> Pubkey {
        let (account_drift_pda, _seed) =
            Pubkey::find_program_address(&[&b"user_stats"[..], account.as_ref()], program);
        account_drift_pda
    }
    /// Return the wallet authority keypair
    pub(crate) fn authority_pair(&self) -> &Keypair {
        self.authority.as_ref()
    }
    /// Return the wallet authority address
    pub fn authority(&self) -> Pubkey {
        self.authority.pubkey()
    }
    /// Return the drift user address
    pub fn user(&self) -> &Pubkey {
        &self.user
    }
    /// Return the drift user stats address
    pub fn stats(&self) -> &Pubkey {
        &self.stats
    }
    /// Return the user sub-account index
    pub fn sub_account_id(&self) -> u16 {
        self.sub_account_id
    }
    /// Return the target network/chain context
    pub fn context(&self) -> Context {
        self.context
    }
}
