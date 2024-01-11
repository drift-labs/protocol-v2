//! Drift SDK

use std::{borrow::Cow, sync::Arc, time::Duration};

use anchor_lang::{AccountDeserialize, Discriminator, InstructionData, ToAccountMetas};
use drift_program::{
    controller::position::PositionDirection,
    math::constants::QUOTE_SPOT_MARKET_INDEX,
    state::{
        order_params::{ModifyOrderParams, OrderParams},
        perp_market::PerpMarket,
        spot_market::SpotMarket,
        user::{MarketType, Order, OrderStatus, PerpPosition, SpotPosition, User},
    },
};
use fnv::FnvHashMap;
use futures_util::{future::BoxFuture, FutureExt, StreamExt};
use solana_account_decoder::UiAccountEncoding;
use solana_client::{
    nonblocking::{pubsub_client::PubsubClient, rpc_client::RpcClient},
    rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    rpc_filter::{Memcmp, RpcFilterType},
};
use solana_sdk::{
    account::{Account, AccountSharedData},
    commitment_config::{CommitmentConfig, CommitmentLevel},
    compute_budget::ComputeBudgetInstruction,
    hash::Hash,
    instruction::{AccountMeta, Instruction},
    message::{
        v0::{self},
        Message, VersionedMessage,
    },
    signature::{keypair_from_seed, Keypair, Signature},
    signer::Signer,
    transaction::VersionedTransaction,
};
pub use solana_sdk::{address_lookup_table_account::AddressLookupTableAccount, pubkey::Pubkey};
use tokio::{
    select,
    sync::{
        watch::{self, Receiver},
        RwLock,
    },
    time::Instant,
};

use crate::constants::{
    derive_spot_market_account, market_lookup_table, state_account, MarketExt, ProgramData,
};

pub mod async_utils;
pub mod constants;
pub mod dlob;
pub mod event_subscriber;
pub mod types;
use types::*;
pub mod auction_subscriber;
pub mod memcmp;
pub mod utils;
pub mod websocket_program_account_subscriber;

/// Provides solana Account fetching API
pub trait AccountProvider: 'static + Sized + Send + Sync {
    // TODO: async fn when it stabilizes
    /// Return the Account information of `account`
    fn get_account(&self, account: Pubkey) -> BoxFuture<SdkResult<Account>>;
}

/// Account provider that always fetches from RPC
pub struct RpcAccountProvider {
    client: RpcClient,
}

impl RpcAccountProvider {
    pub fn new(endpoint: &str) -> Self {
        Self {
            client: RpcClient::new(endpoint.to_string()),
        }
    }
    async fn get_account_impl(&self, account: Pubkey) -> SdkResult<Account> {
        let account_data: Account = self.client.get_account(&account).await?;
        Ok(account_data)
    }
}

impl AccountProvider for RpcAccountProvider {
    fn get_account(&self, account: Pubkey) -> BoxFuture<SdkResult<Account>> {
        self.get_account_impl(account).boxed()
    }
}

/// Account provider using websocket subscriptions to receive and cache account updates
pub struct WsAccountProvider {
    rpc_client: Arc<RpcClient>,
    ws_client: Arc<PubsubClient>,
    /// map from account pubkey to (account data, last modified ts)
    account_cache: RwLock<FnvHashMap<Pubkey, Receiver<(Account, Instant)>>>,
}

impl WsAccountProvider {
    const RPC_CONFIG: RpcAccountInfoConfig = RpcAccountInfoConfig {
        encoding: Some(UiAccountEncoding::Base64Zstd),
        data_slice: None,
        commitment: Some(CommitmentConfig {
            commitment: CommitmentLevel::Confirmed,
        }),
        min_context_slot: None,
    };
    /// Create a new WsAccountProvider given an endpoint that serves both http(s) and ws(s)
    pub async fn new(url: &str) -> SdkResult<Self> {
        let ws_url = if url.starts_with("https://") {
            let uri = url.strip_prefix("https://").unwrap();
            format!("wss://{}", uri)
        } else {
            let uri = url.strip_prefix("http://").expect("valid http(s) URI");
            format!("ws://{}", uri)
        };

        let ws_client = PubsubClient::new(&ws_url).await?;

        Ok(Self {
            rpc_client: Arc::new(RpcClient::new(url.to_string())),
            ws_client: Arc::new(ws_client),
            account_cache: Default::default(),
        })
    }
    /// Subscribe to account updates via web-socket and polling
    fn subscribe_account(&self, account: Pubkey, tx: watch::Sender<(Account, Instant)>) {
        let ws_client_handle = Arc::clone(&self.ws_client);
        let rpc_client_handle = Arc::clone(&self.rpc_client);

        tokio::spawn(async move {
            let mut n_retries = 0;
            let mut backoff_s = 16;
            while n_retries < 3 {
                let result = ws_client_handle
                    .account_subscribe(&account, Some(Self::RPC_CONFIG))
                    .await;

                if result.is_err() {
                    tokio::time::sleep(Duration::from_secs(backoff_s)).await;
                    n_retries += 1;
                    backoff_s *= 2;
                    continue;
                } else {
                    backoff_s = 16;
                    n_retries = 0;
                }

                let (mut account_stream, _unsub) = result.unwrap();

                let mut poll_interval = tokio::time::interval(Duration::from_secs(15));
                let _ = poll_interval.tick().await; // ignore, immediate first tick
                loop {
                    select! {
                        biased;
                        response = account_stream.next() => {
                            if let Some(account_update) = response {
                                let account_data = account_update
                                    .value
                                    .decode::<AccountSharedData>()
                                    .expect("account");
                                tx.send((account_data.into(), Instant::now())).expect("sent");
                            } else {
                                // websocket subscription/stream closed, try reconnect..
                                break;
                            }
                        }
                        _ = poll_interval.tick() => {
                            if let Ok(account_data) = rpc_client_handle.get_account(&account).await {
                                tx.send_if_modified(|current| {
                                    if current.1.duration_since(Instant::now()) > poll_interval.period() {
                                        *current = (account_data, Instant::now());
                                          true
                                    } else {
                                        false
                                    }
                                });
                            } else {
                                // consecutive errors would indicate an issue, there's not much that can be done besides log/panic...
                            }
                        }
                    }
                }
            }
        });
    }
    /// Fetch an account and initiate subscription for future updates
    async fn get_account_impl(&self, account: Pubkey) -> SdkResult<Account> {
        {
            let cache = self.account_cache.read().await;
            if let Some(account_data_rx) = cache.get(&account) {
                let (account_data, _last_modified) = account_data_rx.borrow().clone();
                return Ok(account_data);
            }
        }

        // fetch initial account data, stream only updates on changes
        let account_data: Account = self.rpc_client.get_account(&account).await?;
        let (tx, rx) = watch::channel((account_data.clone(), Instant::now()));
        {
            let mut cache = self.account_cache.write().await;
            cache.insert(account, rx);
        }
        self.subscribe_account(account, tx);

        Ok(account_data)
    }
}

impl AccountProvider for WsAccountProvider {
    fn get_account(&self, account: Pubkey) -> BoxFuture<SdkResult<Account>> {
        self.get_account_impl(account).boxed()
    }
}

/// Drift Client API
///
/// It is cheaply clone-able and consumers are encouraged to do so
/// It is not recommended to create multiple instances with `::new()` as this will not re-use underlying resources such
/// as network connections or memory allocations
#[derive(Clone)]
#[must_use]
pub struct DriftClient<T: AccountProvider> {
    backend: &'static DriftClientBackend<T>,
}

impl<T: AccountProvider> DriftClient<T> {
    pub async fn new(context: Context, endpoint: &str, account_provider: T) -> SdkResult<Self> {
        Ok(Self {
            backend: Box::leak(Box::new(
                DriftClientBackend::new(context, endpoint, account_provider).await?,
            )),
        })
    }

    /// Return on-chain program metadata
    pub fn program_data(&self) -> &ProgramData {
        &self.backend.program_data
    }

    /// Get an account's open order by id
    ///
    /// `account` the drift user PDA
    pub async fn get_order_by_id(
        &self,
        account: &Pubkey,
        order_id: u32,
    ) -> SdkResult<Option<Order>> {
        let user = self.backend.get_account::<User>(account).await?;

        Ok(user.orders.iter().find(|o| o.order_id == order_id).copied())
    }

    /// Get an account's open order by user assigned id
    ///
    /// `account` the drift user PDA
    pub async fn get_order_by_user_id(
        &self,
        account: &Pubkey,
        user_order_id: u8,
    ) -> SdkResult<Option<Order>> {
        let user = self.backend.get_account::<User>(account).await?;

        Ok(user
            .orders
            .iter()
            .find(|o| o.user_order_id == user_order_id)
            .copied())
    }

    /// Get all the account's open orders
    ///
    /// `account` the drift user PDA
    pub async fn all_orders(&self, account: &Pubkey) -> SdkResult<Vec<Order>> {
        let user = self.backend.get_account::<User>(account).await?;

        Ok(user
            .orders
            .iter()
            .filter(|o| o.status == OrderStatus::Open)
            .copied()
            .collect())
    }

    /// Get all the account's active positions
    ///
    /// `account` the drift user PDA
    pub async fn all_positions(
        &self,
        account: &Pubkey,
    ) -> SdkResult<(Vec<SpotPosition>, Vec<PerpPosition>)> {
        let user = self.backend.get_account::<User>(account).await?;

        Ok((
            user.spot_positions
                .iter()
                .filter(|s| !s.is_available())
                .copied()
                .collect(),
            user.perp_positions
                .iter()
                .filter(|p| p.is_open_position())
                .copied()
                .collect(),
        ))
    }

    /// Get a perp position by market
    ///
    /// `account` the drift user PDA
    ///
    /// Returns the position if it exists
    pub async fn perp_position(
        &self,
        account: &Pubkey,
        market_index: u16,
    ) -> SdkResult<Option<PerpPosition>> {
        let user = self.backend.get_account::<User>(account).await?;

        Ok(user
            .perp_positions
            .iter()
            .find(|p| p.market_index == market_index)
            .copied())
    }

    /// Get a spot position by market
    ///
    /// `account` the drift user PDA
    ///
    /// Returns the position if it exists
    pub async fn spot_position(
        &self,
        account: &Pubkey,
        market_index: u16,
    ) -> SdkResult<Option<SpotPosition>> {
        let user = self.backend.get_account::<User>(account).await?;

        Ok(user
            .spot_positions
            .iter()
            .find(|p| p.market_index == market_index)
            .copied())
    }

    /// Get the user account data
    ///
    /// `account` the drift user PDA
    ///
    /// Returns the deserialized account data (`User`)
    pub async fn get_user_account(&self, account: &Pubkey) -> SdkResult<User> {
        self.backend.get_account(account).await
    }

    /// Sign and send a tx to the network
    ///
    /// Returns the signature on success
    pub async fn sign_and_send(
        &self,
        wallet: &Wallet,
        tx: VersionedMessage,
    ) -> SdkResult<Signature> {
        self.backend
            .sign_and_send(wallet, tx)
            .await
            .map_err(|err| err.to_out_of_sol_error().unwrap_or(err))
    }

    /// Get live info of a spot market
    pub async fn get_spot_market_info(&self, market_index: u16) -> SdkResult<SpotMarket> {
        let market = derive_spot_market_account(market_index);
        self.backend.get_account(&market).await
    }

    /// Lookup a market by symbol
    ///
    /// This operation is not free so lookups should be reused/cached by the caller
    ///
    /// Returns None if symbol does not map to any known market
    pub fn market_lookup(&self, symbol: &str) -> Option<MarketId> {
        if symbol.contains('-') {
            let markets = self.program_data().perp_market_configs();
            if let Some(market) = markets
                .iter()
                .find(|m| m.symbol().eq_ignore_ascii_case(symbol))
            {
                return Some(MarketId::perp(market.market_index));
            }
        } else {
            let markets = self.program_data().spot_market_configs();
            if let Some(market) = markets
                .iter()
                .find(|m| m.symbol().eq_ignore_ascii_case(symbol))
            {
                return Some(MarketId::spot(market.market_index));
            }
        }

        None
    }

    /// Initialize a transaction given a (sub)account address
    ///
    /// ```ignore
    /// let tx = client
    ///     .init_tx(&wallet.sub_account(3))
    ///     .cancel_all_orders()
    ///     .place_orders(...)
    ///     .build();
    /// ```
    /// Returns a `TransactionBuilder` for composing the tx
    pub async fn init_tx(&self, account: &Pubkey) -> SdkResult<TransactionBuilder> {
        let account_data = self.get_user_account(account).await?;
        Ok(TransactionBuilder::new(
            self.program_data(),
            *account,
            Cow::Owned(account_data),
        ))
    }
}

/// Provides the heavy-lifting and network facing features of the SDK
/// It is intended to be a singleton
pub struct DriftClientBackend<T: AccountProvider> {
    rpc_client: RpcClient,
    account_provider: T,
    program_data: ProgramData,
}

impl<T: AccountProvider> DriftClientBackend<T> {
    /// Initialize a new `DriftClientBackend`
    async fn new(
        context: Context,
        endpoint: &str,
        account_provider: T,
    ) -> SdkResult<DriftClientBackend<T>> {
        let rpc_client = RpcClient::new(endpoint.to_string());

        let mut this = Self {
            rpc_client,
            account_provider,
            program_data: ProgramData::uninitialized(),
        };

        let lookup_table_address = market_lookup_table(context);
        let (spot, perp, lookup_table_account): (
            SdkResult<Vec<SpotMarket>>,
            SdkResult<Vec<PerpMarket>>,
            SdkResult<Account>,
        ) = tokio::join!(
            this.get_program_accounts(),
            this.get_program_accounts(),
            this.get_account_raw(&lookup_table_address),
        );
        let lookup_table = utils::deserialize_alt(lookup_table_address, &lookup_table_account?)?;

        this.program_data = ProgramData::new(spot?, perp?, lookup_table);

        Ok(this)
    }

    /// Get recent tx priority fees
    ///
    /// - `window` # slots to include in the fee calculation
    async fn get_recent_priority_fees(
        &self,
        writable_markets: &[MarketId],
        window: Option<usize>,
    ) -> SdkResult<u64> {
        let addresses: Vec<Pubkey> = writable_markets
            .iter()
            .filter_map(|x| match x.kind {
                MarketType::Spot => self
                    .program_data
                    .spot_market_config_by_index(x.index)
                    .map(|x| x.pubkey),
                MarketType::Perp => self
                    .program_data
                    .perp_market_config_by_index(x.index)
                    .map(|x| x.pubkey),
            })
            .collect();

        let response = self
            .rpc_client
            .get_recent_prioritization_fees(addresses.as_slice())
            .await?;
        let window = window.unwrap_or(5).max(1);
        let fee = response
            .iter()
            .take(window)
            .map(|x| x.prioritization_fee)
            .sum::<u64>()
            / window as u64;

        Ok(fee)
    }

    /// Get all drift program accounts by Anchor type
    async fn get_program_accounts<U: AccountDeserialize + Discriminator>(
        &self,
    ) -> SdkResult<Vec<U>> {
        let accounts = self
            .rpc_client
            .get_program_accounts_with_config(
                &constants::PROGRAM_ID,
                RpcProgramAccountsConfig {
                    filters: Some(vec![RpcFilterType::Memcmp(Memcmp::new_raw_bytes(
                        0,
                        U::DISCRIMINATOR.to_vec(),
                    ))]),
                    account_config: RpcAccountInfoConfig {
                        encoding: Some(UiAccountEncoding::Base64Zstd),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )
            .await?;

        accounts
            .iter()
            .map(|(_, account_data)| {
                U::try_deserialize(&mut account_data.data.as_ref())
                    .map_err(|err| SdkError::Anchor(Box::new(err)))
            })
            .collect()
    }

    /// Fetch an `account` as an Anchor account type
    async fn get_account<U: AccountDeserialize>(&self, account: &Pubkey) -> SdkResult<U> {
        let account_data = self.account_provider.get_account(*account).await?;
        U::try_deserialize(&mut account_data.data.as_ref()).map_err(|_err| SdkError::InvalidAccount)
    }

    /// Fetch an `account`
    async fn get_account_raw(&self, account: &Pubkey) -> SdkResult<Account> {
        self.account_provider
            .get_account(*account)
            .await
            .map_err(Into::into)
    }

    /// Sign and send a tx to the network
    ///
    /// Returns the signature on success
    pub async fn sign_and_send(
        &self,
        wallet: &Wallet,
        tx: VersionedMessage,
    ) -> SdkResult<Signature> {
        let recent_block_hash = self.rpc_client.get_latest_blockhash().await?;
        let tx = wallet.sign_tx(tx, recent_block_hash)?;
        self.rpc_client
            .send_transaction(&tx)
            .await
            .map_err(|err| err.into())
    }
}

/// Composable Tx builder for Drift program
///
/// Prefer `DriftClient::init_tx`
///
/// ```ignore
/// use drift_sdk::{types::Context, TransactionBuilder, Wallet};
///
/// let wallet = Wallet::from_seed_bs58(Context::Dev, "seed");
/// let client = DriftClient::new("api.example.com").await.unwrap();
/// let account_data = client.get_account(wallet.default_sub_account()).await.unwrap();
///
/// let tx = TransactionBuilder::new(client.program_data, wallet.default_sub_account(), account_data.into())
///     .cancel_all_orders()
///     .place_orders(&[
///         NewOrder::default().build(),
///         NewOrder::default().build(),
///     ])
///     .legacy()
///     .build();
///
/// let signature = client.sign_and_send(tx, &wallet).await?;
/// ```
///
pub struct TransactionBuilder<'a> {
    /// contextual on-chain program data
    program_data: &'a ProgramData,
    /// sub-account data
    account_data: Cow<'a, User>,
    /// the drift sub-account address
    sub_account: Pubkey,
    /// the account to pay for the tx
    payer: Option<Pubkey>,
    /// ordered list of instructions
    ixs: Vec<Instruction>,
    /// use legacy transaction mode
    legacy: bool,
    /// add additional lookup tables (v0 only)
    lookup_tables: Vec<AddressLookupTableAccount>,
}

impl<'a> TransactionBuilder<'a> {
    /// Initialize a new `TransactionBuilder`
    ///
    /// `sub_account` drift sub-account address
    /// `account_data` drift sub-account data
    pub fn new<'b>(
        program_data: &'b ProgramData,
        sub_account: Pubkey,
        account_data: Cow<'b, User>,
    ) -> Self
    where
        'b: 'a,
    {
        Self {
            program_data,
            account_data,
            sub_account,
            payer: None,
            ixs: Default::default(),
            lookup_tables: vec![program_data.lookup_table.clone()],
            legacy: false,
        }
    }
    /// Use legacy tx mode
    pub fn legacy(mut self) -> Self {
        self.legacy = true;
        self
    }
    /// Set the tx lookup tables
    pub fn lookup_tables(mut self, lookup_tables: &[AddressLookupTableAccount]) -> Self {
        self.lookup_tables = lookup_tables.to_vec();
        self.lookup_tables
            .push(self.program_data.lookup_table.clone());

        self
    }
    /// Set the tx fee payer
    ///
    /// defaults to the account authority
    pub fn payer(mut self, payer: Pubkey) -> Self {
        self.payer = Some(payer);
        self
    }
    /// Set the priority fee of the tx
    ///
    /// `priority_fee` the price per unit of compute in µ-lamports, default = 5 µ-lamports
    pub fn priority_fee(mut self, priority_fee: u64) -> Self {
        let ix = ComputeBudgetInstruction::set_compute_unit_price(priority_fee);
        self.ixs.push(ix);
        self
    }
    /// Place new orders for account
    pub fn place_orders(mut self, orders: Vec<OrderParams>) -> Self {
        let readable_accounts: Vec<MarketId> = orders
            .iter()
            .map(|o| (o.market_index, o.market_type).into())
            .collect();

        let accounts = build_accounts(
            self.program_data,
            drift_program::accounts::PlaceOrder {
                state: *state_account(),
                authority: self.account_data.authority,
                user: self.sub_account,
            },
            self.account_data.as_ref(),
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
            self.program_data,
            drift_program::accounts::CancelOrder {
                state: *state_account(),
                authority: self.account_data.authority,
                user: self.sub_account,
            },
            self.account_data.as_ref(),
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
            self.program_data,
            drift_program::accounts::CancelOrder {
                state: *state_account(),
                authority: self.account_data.authority,
                user: self.sub_account,
            },
            self.account_data.as_ref(),
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
            self.program_data,
            drift_program::accounts::CancelOrder {
                state: *state_account(),
                authority: self.account_data.authority,
                user: self.sub_account,
            },
            self.account_data.as_ref(),
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

    /// Modify existing order(s)
    pub fn modify_orders(mut self, orders: Vec<(u32, ModifyOrderParams)>) -> Self {
        for (order_id, params) in orders {
            let accounts = build_accounts(
                self.program_data,
                drift_program::accounts::PlaceOrder {
                    state: *state_account(),
                    authority: self.account_data.authority,
                    user: self.sub_account,
                },
                self.account_data.as_ref(),
                &[],
                &[],
            );

            let ix = Instruction {
                program_id: constants::PROGRAM_ID,
                accounts,
                data: InstructionData::data(&drift_program::instruction::ModifyOrder {
                    order_id: Some(order_id),
                    modify_order_params: params,
                }),
            };
            self.ixs.push(ix);
        }

        self
    }

    /// Build the transaction message ready for signing and sending
    pub fn build(self) -> VersionedMessage {
        if self.legacy {
            let message = Message::new(
                self.ixs.as_ref(),
                self.payer.as_ref().or(Some(&self.account_data.authority)),
            );
            VersionedMessage::Legacy(message)
        } else {
            let message = v0::Message::try_compile(
                self.payer.as_ref().unwrap_or(&self.account_data.authority),
                self.ixs.as_slice(),
                self.lookup_tables.as_slice(),
                Default::default(),
            )
            .expect("ok");
            VersionedMessage::V0(message)
        }
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
    program_data: &ProgramData,
    base_accounts: impl ToAccountMetas,
    user: &User,
    markets_readable: &[MarketId],
    markets_writable: &[MarketId],
) -> Vec<AccountMeta> {
    // the order of accounts returned must be instruction, oracles, spot, perps see (https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/instructions/optional_accounts.rs#L28)
    let mut seen = [0_u64; 2]; // [spot, perp]
    let mut accounts = Vec::<RemainingAccount>::default();

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
                let SpotMarket { pubkey, oracle, .. } = program_data
                    .spot_market_config_by_index(market_index)
                    .expect("exists");
                (
                    RemainingAccount::Spot {
                        pubkey: *pubkey,
                        writable,
                    },
                    oracle,
                )
            }
            MarketType::Perp => {
                let PerpMarket { pubkey, amm, .. } = program_data
                    .perp_market_config_by_index(market_index)
                    .expect("exists");
                (
                    RemainingAccount::Perp {
                        pubkey: *pubkey,
                        writable,
                    },
                    &amm.oracle,
                )
            }
        };
        if let Err(idx) = accounts.binary_search(&account) {
            accounts.insert(idx, account);
        }
        let oracle = RemainingAccount::Oracle { pubkey: *oracle };
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
    /// The signing keypair, it could be authority or delegate
    signer: Arc<Keypair>,
    /// The drift 'authority' account
    /// user (sub)accounts are derived from this
    authority: Pubkey,
    /// The drift 'stats' account
    stats: Pubkey,
}

impl Wallet {
    /// Init wallet from a string that could be either a file path or the encoded key, uses default sub-account
    pub fn try_from_str(path_or_key: &str) -> SdkResult<Self> {
        let authority = utils::load_keypair_multi_format(path_or_key)?;
        Ok(Self::new(authority))
    }
    /// Init wallet from base58 encoded seed, uses default sub-account
    ///
    /// # panics
    /// if the key is invalid
    pub fn from_seed_bs58(seed: &str) -> Self {
        let authority: Keypair = Keypair::from_base58_string(seed);
        Self::new(authority)
    }
    /// Init wallet from seed bytes, uses default sub-account
    pub fn from_seed(seed: &[u8]) -> SdkResult<Self> {
        let authority: Keypair = keypair_from_seed(seed).map_err(|_| SdkError::InvalidSeed)?;
        Ok(Self::new(authority))
    }
    /// Init wallet with keypair
    ///
    /// `authority` keypair for tx signing
    pub fn new(authority: Keypair) -> Self {
        Self {
            stats: Wallet::derive_stats_account(&authority.pubkey(), &constants::PROGRAM_ID),
            authority: authority.pubkey(),
            signer: Arc::new(authority),
        }
    }
    /// Convert the wallet into a delegated one by providing the `authority` public key
    pub fn to_delegated(&mut self, authority: Pubkey) {
        self.stats = Wallet::derive_stats_account(&authority, &constants::PROGRAM_ID);
        self.authority = authority;
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
    /// Signs the given tx `message` returning the tx on success
    pub fn sign_tx(
        &self,
        mut message: VersionedMessage,
        recent_block_hash: Hash,
    ) -> SdkResult<VersionedTransaction> {
        message.set_recent_blockhash(recent_block_hash);
        VersionedTransaction::try_new(message, &[self.signer.as_ref()]).map_err(Into::into)
    }
    /// Return the wallet authority address
    pub fn authority(&self) -> &Pubkey {
        &self.authority
    }
    /// Return the wallet signing address
    pub fn signer(&self) -> Pubkey {
        self.signer.pubkey()
    }
    /// Return the drift user stats address
    pub fn stats(&self) -> &Pubkey {
        &self.stats
    }
    /// Return the address of the default sub-account (0)
    pub fn default_sub_account(&self) -> Pubkey {
        self.sub_account(0)
    }
    /// Calculate the drift user address given a `sub_account_id`
    pub fn sub_account(&self, sub_account_id: u16) -> Pubkey {
        Self::derive_user_account(self.authority(), sub_account_id, &constants::PROGRAM_ID)
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use drift_program::state::perp_market::PerpMarket;
    use serde_json::json;
    use solana_account_decoder::{UiAccount, UiAccountData};
    use solana_client::{
        rpc_client::Mocks,
        rpc_request::RpcRequest,
        rpc_response::{Response, RpcResponseContext},
    };

    use super::*;

    // static account data for test/mock
    const ACCOUNT_DATA: &str = include_str!("../res/9Jtc.hex");
    const DEVNET_ENDPOINT: &str = "https://api.devnet.solana.com";

    /// Init a new `DriftClient` with provided mocked RPC responses
    async fn setup(
        rpc_mocks: Mocks,
        account_provider_mocks: Mocks,
    ) -> DriftClient<RpcAccountProvider> {
        let backend = DriftClientBackend {
            rpc_client: RpcClient::new_mock_with_mocks(DEVNET_ENDPOINT.to_string(), rpc_mocks),
            account_provider: RpcAccountProvider {
                client: RpcClient::new_mock_with_mocks(
                    DEVNET_ENDPOINT.to_string(),
                    account_provider_mocks,
                ),
            },
            program_data: ProgramData::uninitialized(),
        };

        DriftClient {
            backend: Box::leak(Box::new(backend)),
        }
    }

    #[tokio::test]
    async fn get_market_accounts() {
        let client = DriftClient::new(
            Context::DevNet,
            DEVNET_ENDPOINT,
            RpcAccountProvider::new(DEVNET_ENDPOINT),
        )
        .await
        .unwrap();
        let accounts: Vec<SpotMarket> = client
            .backend
            .get_program_accounts()
            .await
            .expect("found accounts");
        assert!(accounts.len() > 1);

        let accounts: Vec<PerpMarket> = client
            .backend
            .get_program_accounts()
            .await
            .expect("found accounts");
        assert!(accounts.len() > 1);
    }

    #[tokio::test]
    async fn get_orders() {
        let user = Pubkey::from_str("9JtczxrJjPM4J1xooxr2rFXmRivarb4BwjNiBgXDwe2p").unwrap();
        let account_data = hex::decode(ACCOUNT_DATA).expect("valid hex");

        let mut account_mocks = Mocks::default();
        let account_response = json!(Response {
            context: RpcResponseContext::new(12_345),
            value: Some(UiAccount {
                data: UiAccountData::Binary(
                    solana_sdk::bs58::encode(account_data).into_string(),
                    UiAccountEncoding::Base58
                ),
                owner: user.to_string(),
                executable: false,
                lamports: 0,
                rent_epoch: 0,
            })
        });
        account_mocks.insert(RpcRequest::GetAccountInfo, account_response.clone());

        let client = setup(Default::default(), account_mocks).await;

        let orders = client.all_orders(&user).await.unwrap();
        assert_eq!(orders.len(), 3);
    }

    #[tokio::test]
    async fn get_positions() {
        let user = Pubkey::from_str("9JtczxrJjPM4J1xooxr2rFXmRivarb4BwjNiBgXDwe2p").unwrap();
        let account_data = hex::decode(ACCOUNT_DATA).expect("valid hex");

        let mut account_mocks = Mocks::default();
        let account_response = json!(Response {
            context: RpcResponseContext::new(12_345),
            value: Some(UiAccount {
                data: UiAccountData::Binary(
                    solana_sdk::bs58::encode(account_data).into_string(),
                    UiAccountEncoding::Base58
                ),
                owner: user.to_string(),
                executable: false,
                lamports: 0,
                rent_epoch: 0,
            })
        });
        account_mocks.insert(RpcRequest::GetAccountInfo, account_response.clone());
        let client = setup(Default::default(), account_mocks).await;

        let (spot, perp) = client.all_positions(&user).await.unwrap();
        assert_eq!(spot.len(), 1);
        assert_eq!(perp.len(), 1);
    }
}
