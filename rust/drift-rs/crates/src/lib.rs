//! Drift SDK

use std::{
    borrow::Cow,
    collections::BTreeSet,
    sync::{Arc, RwLock},
    time::Duration,
};

use crate::solana_sdk::{
    account::Account,
    clock::Slot,
    commitment_config::CommitmentLevel,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    message::{v0, Hash, Message, VersionedMessage},
    signature::Signature,
};
pub use crate::solana_sdk::{message::AddressLookupTableAccount, pubkey::Pubkey};
#[cfg(feature = "titan")]
use crate::titan::TitanSwapInfo;
use crate::{
    account_map::AccountMap,
    blockhash_subscriber::BlockhashSubscriber,
    constants::{
        derive_perp_market_account, derive_revenue_share_escrow, derive_spot_market_account,
        state_account, MarketExt, ProgramData, DEFAULT_PUBKEY, PYTH_LAZER_STORAGE_ACCOUNT_KEY,
        SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY,
    },
    grpc::grpc_subscriber::{AccountFilter, DriftGrpcClient, GeyserSubscribeOpts},
    jupiter::JupiterSwapInfo,
    marketmap::MarketMap,
    oraclemap::{Oracle, OracleMap},
    swift_order_subscriber::{SignedOrderInfo, SwiftOrderStream},
    types::{
        accounts::{PerpMarket, SpotMarket, State, User, UserStats},
        AccountUpdate, DataAndSlot, MarketType, *,
    },
    utils::{get_http_url, get_ws_url},
};
pub use crate::{grpc::GrpcSubscribeOpts, types::Context, wallet::Wallet};
use anchor_lang::{AccountDeserialize, Discriminator, InstructionData, ToAccountMetas};
use bytemuck::Pod;
use constants::{
    high_leverage_mode_account, ASSOCIATED_TOKEN_PROGRAM_ID, PROGRAM_ID, SYSTEM_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
pub use drift_pubsub_client::PubsubClient;
use futures_util::TryFutureExt;
use log::debug;
pub use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::{
    config::RpcSimulateTransactionConfig,
    filter::RpcFilterType,
    response::{Response, RpcSimulateTransactionResult},
};

// utils
pub mod async_utils;
pub mod jupiter;
pub mod market_state;
pub mod titan;
pub use market_state::MarketState;
pub mod math;
pub mod memcmp;
pub mod utils;
pub mod wallet;

// constants & types
pub mod constants;
pub mod drift_idl;
mod layout_check;
pub mod types;

// internal infra
pub mod grpc;
pub mod polled_account_subscriber;
pub mod websocket_account_subscriber;

pub mod websocket_program_account_subscriber;

// subscribers
pub mod auction_subscriber;
pub mod blockhash_subscriber;
pub mod event_subscriber;
pub mod priority_fee_subscriber;
pub mod swift_order_subscriber;

pub mod jit_client;

pub mod account_map;
pub mod marketmap;
pub mod oraclemap;

pub mod slot_subscriber;
pub mod usermap;

pub mod dlob;

/// DriftClient
///
/// It is cheaply clone-able and consumers are encouraged to do so.
/// It is not recommended to create multiple instances with `::new()` as this will not re-use underlying resources such
/// as network connections or memory allocations
///
/// The client can be used as is to fetch data ad-hoc over RPC or subscribed to receive live updates (transparently)
/// ```example(no_run)
/// let client = DriftClient::new(
///     Context::MainNet,
///     RpcClient::new("https://rpc.example.com"),
///     key_pair.into()
/// ).await.expect("initializes");
///
/// // queries over RPC
/// let sol_perp_price = client.oracle_price(MarketId::perp(0)).await;
///
/// // Subscribe to live program changes e.g oracle prices, spot/perp market changes, user accounts
/// let markets = [MarketId::perp(0), MarketId::spot(2)];
/// client.subscribe_markets(&markets).await.expect("subscribes");
/// client.subscribe_oracles(&markets).await.expect("subscribes");
///
/// // after subscribing, uses Ws-backed local storage
/// let sol_perp_price = client.oracle_price(MarketId::perp(0)).await;
///
/// client.unsubscribe();
/// ```
#[derive(Clone)]
#[must_use]
pub struct DriftClient {
    pub context: Context,
    backend: &'static DriftClientBackend,
    pub wallet: Wallet,
}

impl DriftClient {
    /// Create a new `DriftClient` instance
    ///
    /// * `context` - devnet or mainnet
    /// * `rpc_client` - an RpcClient instance
    /// * `wallet` - wallet to use for tx signing convenience
    pub async fn new(context: Context, rpc_client: RpcClient, wallet: Wallet) -> SdkResult<Self> {
        // check URL format here to fail early, otherwise happens at request time.
        let _ = get_http_url(&rpc_client.url())?;
        Ok(Self {
            backend: Box::leak(Box::new(
                DriftClientBackend::new(context, Arc::new(rpc_client)).await?,
            )),
            context,
            wallet,
        })
    }

    /// Create a new `DriftClient` instance with explicit Ws PubSub URL
    ///
    /// * `context` - devnet or mainnet
    /// * `rpc_client` - an RpcClient instance
    /// * `wallet` - wallet to use for tx signing convenience
    /// * `ws_pubsub_url` - custom Ws PubSub URL
    pub async fn new_with_ws_url(
        context: Context,
        rpc_client: RpcClient,
        wallet: Wallet,
        ws_pubsub_url: &str,
    ) -> SdkResult<Self> {
        // check URL format here to fail early, otherwise happens at request time.
        let _ = get_http_url(&rpc_client.url())?;
        // validate ws url
        let _ws_pubsub_url = get_ws_url(ws_pubsub_url)?;

        Ok(Self {
            backend: Box::leak(Box::new(
                DriftClientBackend::new_with_explicit_ws_url(
                    context,
                    Arc::new(rpc_client),
                    ws_pubsub_url,
                )
                .await?,
            )),
            context,
            wallet,
        })
    }

    pub async fn sync_user_accounts(&self, filters: Vec<RpcFilterType>) -> SdkResult<()> {
        self.backend.account_map.sync_user_accounts(filters).await
    }

    pub async fn sync_user_stats_accounts(&self) -> SdkResult<()> {
        self.backend.account_map.sync_stats_accounts().await
    }

    /// Starts background subscriptions for live blockhashes
    ///
    /// This is a no-op if already subscribed
    pub async fn subscribe_blockhashes(&self) -> SdkResult<()> {
        self.backend.subscribe_blockhashes().await
    }

    /// Starts background subscriptions for live market account updates
    ///
    /// * `markets` - list of markets to subscribe
    ///
    /// This is a no-op if already subscribed
    pub async fn subscribe_markets(&self, markets: &[MarketId]) -> SdkResult<()> {
        self.backend.subscribe_markets(markets).await
    }

    pub async fn subscribe_markets_with_callback<F>(
        &self,
        markets: &[MarketId],
        on_account: F,
    ) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        self.backend
            .subscribe_markets_with_callback(markets, on_account)
            .await
    }

    /// Subscribe to all spot and perp markets
    ///
    /// This is a no-op if already subscribed
    pub async fn subscribe_all_markets(&self) -> SdkResult<()> {
        let markets = self.get_all_market_ids();
        self.backend.subscribe_markets(&markets).await
    }

    pub async fn subscribe_all_markets_with_callback<F>(&self, on_account: F) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        let markets = self.get_all_market_ids();
        self.backend
            .subscribe_markets_with_callback(&markets, on_account)
            .await
    }

    /// Subscribe to all spot markets
    ///
    /// This is a no-op if already subscribed
    pub async fn subscribe_all_spot_markets(&self) -> SdkResult<()> {
        let markets = self.get_all_spot_market_ids();
        self.backend.subscribe_markets(&markets).await
    }

    pub async fn subscribe_all_spot_markets_with_callback<F>(&self, on_account: F) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        let markets = self.get_all_spot_market_ids();
        self.backend
            .subscribe_markets_with_callback(&markets, on_account)
            .await
    }

    /// Subscribe to all perp markets
    ///
    /// This is a no-op if already subscribed
    pub async fn subscribe_all_perp_markets(&self) -> SdkResult<()> {
        let markets = self.get_all_perp_market_ids();
        self.backend.subscribe_markets(&markets).await
    }

    pub async fn subscribe_all_perp_markets_with_callback<F>(&self, on_account: F) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        let markets = self.get_all_perp_market_ids();
        self.backend
            .subscribe_markets_with_callback(&markets, on_account)
            .await
    }

    /// Starts background subscriptions for live oracle account updates by market
    ///
    /// * `markets` - list of markets to subscribe for oracle updates
    ///
    /// This is a no-op if already subscribed
    pub async fn subscribe_oracles(&self, markets: &[MarketId]) -> SdkResult<()> {
        self.backend.subscribe_oracles(markets).await
    }

    pub async fn subscribe_oracles_with_callback<F>(
        &self,
        markets: &[MarketId],
        on_account: F,
    ) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        self.backend
            .subscribe_oracles_with_callback(markets, on_account)
            .await
    }

    /// Subscribe to all oracles
    ///
    /// This is a no-op if already subscribed
    pub async fn subscribe_all_oracles(&self) -> SdkResult<()> {
        let markets = self.get_all_market_ids();
        self.backend.subscribe_oracles(&markets).await
    }

    /// Subscribe to all oracle account updates with callback
    pub async fn subscribe_all_oracles_with_callback<F>(&self, on_account: F) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        let markets = self.get_all_market_ids();
        self.backend
            .subscribe_oracles_with_callback(&markets, on_account)
            .await
    }

    /// Subscribe to all spot market oracles
    ///
    /// This is a no-op if already subscribed
    pub async fn subscribe_all_spot_oracles(&self) -> SdkResult<()> {
        let markets = self.get_all_spot_market_ids();
        self.backend.subscribe_oracles(&markets).await
    }

    /// Subscribe to all spot oracle account updates with callback
    pub async fn subscribe_all_spot_oracles_with_callback<F>(&self, on_account: F) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        let markets = self.get_all_spot_market_ids();
        self.backend
            .subscribe_oracles_with_callback(&markets, on_account)
            .await
    }

    /// Subscribe to all perp market oracles
    ///
    /// This is a no-op if already subscribed
    pub async fn subscribe_all_perp_oracles(&self) -> SdkResult<()> {
        let markets = self.get_all_perp_market_ids();
        self.backend.subscribe_oracles(&markets).await
    }

    /// Subscribe to all perp oracle account updates with callback
    pub async fn subscribe_all_perp_oracles_with_callback<F>(&self, on_account: F) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        let markets = self.get_all_perp_market_ids();
        self.backend
            .subscribe_oracles_with_callback(&markets, on_account)
            .await
    }

    /// Subscribe to swift order feed(s) for given `markets`
    ///
    /// * `markets` - list of markets to watch for swift orders
    /// * `accept_sanitized` - set to `Some(true)` to view *sanitized order flow
    /// * `accept_deposit_trades` - set to `Some(true)` to view 'deposit+trade' order flow
    /// * `swift_ws_url` - optional custom swift Ws endpoint
    ///
    /// ## DEV
    /// - *a sanitized order may have its auction params modified by the program when
    ///   placed onchain. Makers should understand the time/price implications to accept these.
    ///
    /// - 'deposit+trade' orders require fillers to send an attached, preceding deposit tx
    ///   before the swift order
    ///
    /// Returns a stream of swift orders
    pub async fn subscribe_swift_orders(
        &self,
        markets: &[MarketId],
        accept_sanitized: Option<bool>,
        accept_deposit_trades: Option<bool>,
        swift_ws_url: Option<String>,
    ) -> SdkResult<SwiftOrderStream> {
        swift_order_subscriber::subscribe_swift_orders(
            self,
            markets,
            accept_sanitized.is_some_and(|x| x),
            accept_deposit_trades.is_some_and(|x| x),
            swift_ws_url,
        )
        .await
    }

    /// Returns the MarketIds for all active spot markets (ignores de-listed and settled markets)
    ///
    /// Useful for iterating over all spot markets
    pub fn get_all_spot_market_ids(&self) -> Vec<MarketId> {
        self.program_data()
            .spot_market_configs()
            .iter()
            .filter_map(|m| match m.status {
                MarketStatus::Settlement | MarketStatus::Delisted => {
                    log::debug!("ignoring settled/delisted spot market: {}", m.market_index);
                    None
                }
                _ => Some(MarketId::spot(m.market_index)),
            })
            .collect()
    }

    /// Returns the MarketIds for all active perp markets (ignores de-listed and settled markets)
    ///
    /// Useful for iterating over all perp markets
    pub fn get_all_perp_market_ids(&self) -> Vec<MarketId> {
        self.program_data()
            .perp_market_configs()
            .iter()
            .filter_map(|m| match m.status {
                MarketStatus::Settlement | MarketStatus::Delisted => {
                    log::debug!("ignoring settled/delisted perp market: {}", m.market_index);
                    None
                }
                _ => Some(MarketId::perp(m.market_index)),
            })
            .collect()
    }

    /// Returns the `MarketId`s for all active markets (ignores de-listed and settled markets)
    ///
    /// Useful for iterating over all markets
    pub fn get_all_market_ids(&self) -> Vec<MarketId> {
        let spot_markets = self.get_all_spot_market_ids();
        let perp_markets = self.get_all_perp_market_ids();
        spot_markets.into_iter().chain(perp_markets).collect()
    }

    /// Unsubscribe from network resources
    /// Subsequent queries will pull from the network ad-hoc
    ///
    /// This is a no-op if not subscribed
    pub async fn unsubscribe(&self) -> SdkResult<()> {
        self.backend.unsubscribe().await
    }

    /// Return a handle to the inner RPC client
    #[deprecated]
    pub fn inner(&self) -> &RpcClient {
        &self.backend.rpc_client
    }

    /// Return a handle to the inner RPC client
    pub fn rpc(&self) -> Arc<RpcClient> {
        self.backend.client()
    }

    /// Return a handle to the inner Ws client
    pub fn ws(&self) -> Arc<PubsubClient> {
        self.backend.ws()
    }

    /// Return on-chain program metadata
    ///
    /// Useful for inspecting market ids and config
    pub fn program_data(&self) -> &ProgramData {
        &self.backend.program_data
    }

    /// Get an account's open order by id
    ///
    /// * `account` - the drift user PDA
    /// * `order_id` - order id to query
    ///
    /// Returns the `Order` if it exists
    pub async fn get_order_by_id(
        &self,
        account: &Pubkey,
        order_id: u32,
    ) -> SdkResult<Option<Order>> {
        let user = self.backend.get_user_account(account).await?;

        Ok(user.orders.iter().find(|o| o.order_id == order_id).copied())
    }

    /// Get an account's open order by user assigned id
    ///
    /// * `account` - the drift user PDA
    /// * `user_order_id` - user defined order id to query
    ///
    /// Returns the `Order` if it exists
    pub async fn get_order_by_user_id(
        &self,
        account: &Pubkey,
        user_order_id: u8,
    ) -> SdkResult<Option<Order>> {
        let user = self.backend.get_user_account(account).await?;

        Ok(user
            .orders
            .iter()
            .find(|o| o.user_order_id == user_order_id)
            .copied())
    }

    /// Get the account's open orders
    ///
    /// * `account` - the drift user PDA
    ///
    /// Returns the list of open orders
    pub async fn all_orders(&self, account: &Pubkey) -> SdkResult<Vec<Order>> {
        let user = self.backend.get_user_account(account).await?;

        Ok(user
            .orders
            .iter()
            .filter(|o| o.status == OrderStatus::Open)
            .copied()
            .collect())
    }

    /// Get the account's unsettled positions
    ///
    /// * `account` - the drift user PDA
    ///
    /// Returns the list of unsettled positions
    pub async fn unsettled_positions(&self, account: &Pubkey) -> SdkResult<Vec<PerpPosition>> {
        let user = self.backend.get_user_account(account).await?;

        Ok(user
            .perp_positions
            .iter()
            .filter(|p| p.base_asset_amount == 0 && p.quote_asset_amount != 0)
            .copied()
            .collect())
    }

    /// Get all the account's open positions
    ///
    /// * `account` - the drift user PDA
    pub async fn all_positions(
        &self,
        account: &Pubkey,
    ) -> SdkResult<(Vec<SpotPosition>, Vec<PerpPosition>)> {
        let user = self.backend.get_user_account(account).await?;

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
    /// * `account` - the drift user PDA
    ///
    /// Returns the position if it exists
    pub async fn perp_position(
        &self,
        account: &Pubkey,
        market_index: u16,
    ) -> SdkResult<Option<PerpPosition>> {
        let user = self.backend.get_user_account(account).await?;

        Ok(user
            .perp_positions
            .iter()
            .find(|p| p.market_index == market_index && !p.is_available())
            .copied())
    }

    /// Get a spot position by market
    ///
    /// * `account` - the drift user PDA
    ///
    /// Returns the position if it exists
    pub async fn spot_position(
        &self,
        account: &Pubkey,
        market_index: u16,
    ) -> SdkResult<Option<SpotPosition>> {
        let user = self.backend.get_user_account(account).await?;

        Ok(user
            .spot_positions
            .iter()
            .find(|p| p.market_index == market_index && !p.is_available())
            .copied())
    }

    /// Return the `DriftClient`'s wallet
    pub fn wallet(&self) -> &Wallet {
        &self.wallet
    }

    /// Get the user account data
    /// Uses cached value if subscribed, falls back to network query
    ///
    /// * `account` - the drift user PDA (subaccount)
    ///
    /// Returns the deserialized account data (`User`)
    pub async fn get_user_account(&self, account: &Pubkey) -> SdkResult<User> {
        self.backend.get_user_account(account).await
    }

    /// Get the user account data and slot it was fetched at
    /// Uses cached value if subscribed, falls back to network query
    ///
    /// * `account` - the drift user PDA (subaccount)
    ///
    /// Returns the deserialized account data (`User`)
    pub async fn get_user_account_with_slot(
        &self,
        account: &Pubkey,
    ) -> SdkResult<DataAndSlot<User>> {
        self.backend.get_user_account_with_slot(account).await
    }

    /// Get a user stats account
    ///
    /// Returns the deserialized account data (`UserStats`)
    pub async fn get_user_stats(&self, authority: &Pubkey) -> SdkResult<UserStats> {
        let user_stats_pubkey = Wallet::derive_stats_account(authority);
        self.backend.get_account(&user_stats_pubkey).await
    }

    /// Get a user stats account and slot it was fetched at
    ///
    /// Returns the deserialized account data (`UserStats`)
    pub async fn get_user_stats_with_slot(
        &self,
        authority: &Pubkey,
    ) -> SdkResult<DataAndSlot<UserStats>> {
        let user_stats_pubkey = Wallet::derive_stats_account(authority);
        self.backend.get_account_with_slot(&user_stats_pubkey).await
    }

    /// Get the latest recent_block_hash
    /// uses latest cached if subscribed, otherwise falls back to network query
    pub async fn get_latest_blockhash(&self) -> SdkResult<Hash> {
        self.backend.get_latest_blockhash().await
    }

    /// Get some account value deserialized as T
    /// Uses cached value if subscribed, falls back to network query
    ///
    /// * `account` - any onchain account
    ///
    /// Returns the deserialized account data (`User`)
    pub async fn get_account_value<T: AccountDeserialize + Pod + Discriminator>(
        &self,
        account: &Pubkey,
    ) -> SdkResult<T> {
        self.backend.get_account(account).await
    }

    /// Try to get `account` as `T` using latest local value
    ///
    /// requires account was previously subscribed too.
    /// like `get_account_value` without async/network fallback
    pub fn try_get_account<T: AccountDeserialize + Pod + Discriminator>(
        &self,
        account: &Pubkey,
    ) -> SdkResult<T> {
        self.backend.try_get_account(account)
    }

    /// Try get the Drift `State` config account
    /// It contains various exchange level config parameters
    ///
    /// `State` is Borsh-only — it embeds non-`#[repr(C)]` types
    /// (`FeeStructure` etc.) whose x86_64 layout differs from on-chain bytes,
    /// so this routes through `AccountDeserialize` rather than the bytemuck
    /// zero-copy path used for `Pod` accounts.
    pub fn state_account(&self) -> SdkResult<State> {
        let raw = self.account_raw(state_account())?;
        State::try_deserialize(&mut raw.as_ref()).map_err(|_| SdkError::InvalidAccount)
    }

    /// Return raw cached bytes of `account` (including 8-byte discriminator), if subscribed.
    ///
    /// Useful when the on-chain type isn't `Pod`-compatible — e.g. drift's
    /// native `State` (Borsh-only) — and the caller needs to feed bytes into
    /// `AccountDeserialize::try_deserialize` themselves.
    pub fn account_raw(&self, account: &Pubkey) -> SdkResult<std::sync::Arc<[u8]>> {
        self.backend
            .account_map
            .account_raw(account)
            .ok_or(SdkError::NoAccountData(*account))
    }

    /// Simulate the tx on remote RPC node
    pub async fn simulate_tx(
        &self,
        tx: VersionedMessage,
    ) -> SdkResult<RpcSimulateTransactionResult> {
        let response = self
            .rpc()
            .simulate_transaction_with_config(
                &VersionedTransaction {
                    message: tx,
                    // must provide a signature for the RPC call to work
                    signatures: vec![Signature::default()],
                },
                RpcSimulateTransactionConfig {
                    sig_verify: false,
                    replace_recent_blockhash: true,
                    ..Default::default()
                },
            )
            .await;
        response.map(|r| r.value).map_err(Into::into)
    }

    /// Sign and send a tx to the network
    ///
    /// Returns the signature on success
    pub async fn sign_and_send(&self, tx: VersionedMessage) -> SdkResult<Signature> {
        let recent_block_hash = self.backend.get_latest_blockhash().await?;
        self.backend
            .sign_and_send(self.wallet(), tx, recent_block_hash)
            .await
            .map_err(|err| err.to_out_of_sol_error().unwrap_or(err))
    }

    /// Sign and send a tx to the network
    ///
    ///  * `recent_block_hash` - some block hash to use for tx signing, if not provided it will be automatically set
    ///  * `config` - custom RPC config to use when submitting the tx
    ///
    /// Returns the signature on success
    pub async fn sign_and_send_with_config(
        &self,
        tx: VersionedMessage,
        recent_block_hash: Option<Hash>,
        config: RpcSendTransactionConfig,
    ) -> SdkResult<Signature> {
        let recent_block_hash = match recent_block_hash {
            Some(h) => h,
            None => self.backend.get_latest_blockhash().await?,
        };
        self.backend
            .sign_and_send_with_config(self.wallet(), tx, recent_block_hash, config)
            .await
            .map_err(|err| err.to_out_of_sol_error().unwrap_or(err))
    }

    /// Get spot market account
    ///
    /// * `market_index` - spot market index
    ///
    /// uses latest cached value if subscribed, otherwise falls back to network query
    pub async fn get_spot_market_account(&self, market_index: u16) -> SdkResult<SpotMarket> {
        match self
            .backend
            .try_get_spot_market_account_and_slot(market_index)
        {
            Some(market) => Ok(market.data),
            None => {
                debug!(target: "rpc", "fetch market: spot/{market_index}");
                let market = derive_spot_market_account(market_index);
                self.backend.get_account(&market).await
            }
        }
    }

    /// Get perp market account
    ///
    /// * `market_index` - perp market index
    ///
    /// uses latest cached value if subscribed, otherwise falls back to network query
    pub async fn get_perp_market_account(&self, market_index: u16) -> SdkResult<PerpMarket> {
        match self
            .backend
            .try_get_perp_market_account_and_slot(market_index)
        {
            Some(market) => Ok(market.data),
            None => {
                debug!(target: "rpc", "fetch market: perp/{market_index}");
                let market = derive_perp_market_account(market_index);
                self.backend.get_account(&market).await
            }
        }
    }

    /// Try to spot market account from cache
    ///
    /// * `market_index` - spot market index
    ///
    /// Returns error if not subscribed
    pub fn try_get_spot_market_account(&self, market_index: u16) -> SdkResult<SpotMarket> {
        if let Some(market) = self
            .backend
            .try_get_spot_market_account_and_slot(market_index)
        {
            Ok(market.data)
        } else {
            Err(SdkError::NoMarketData(MarketId::spot(market_index)))
        }
    }

    /// Try to get perp market account from cache
    ///
    /// * `market_index` - spot market index
    ///
    /// Returns error if not subscribed
    pub fn try_get_perp_market_account(&self, market_index: u16) -> SdkResult<PerpMarket> {
        if let Some(market) = self
            .backend
            .try_get_perp_market_account_and_slot(market_index)
        {
            Ok(market.data)
        } else {
            Err(SdkError::NoMarketData(MarketId::perp(market_index)))
        }
    }

    /// Get spot market account and slot it was fetched at
    ///
    /// * `market_index` - spot market index
    ///
    /// uses latest cached value if subscribed, otherwise falls back to network query
    pub async fn get_spot_market_account_and_slot(
        &self,
        market_index: u16,
    ) -> SdkResult<DataAndSlot<SpotMarket>> {
        match self
            .backend
            .try_get_spot_market_account_and_slot(market_index)
        {
            Some(market) => Ok(market),
            None => {
                debug!(target: "rpc", "fetch market: spot/{market_index}");
                let market = derive_spot_market_account(market_index);
                self.backend.get_account_with_slot(&market).await
            }
        }
    }

    /// Get perp market account and slot it was fetched at
    ///
    /// * `market_index` - perp market index
    ///
    /// uses latest cached value if subscribed, otherwise falls back to network query
    pub async fn get_perp_market_account_and_slot(
        &self,
        market_index: u16,
    ) -> SdkResult<DataAndSlot<PerpMarket>> {
        match self
            .backend
            .try_get_perp_market_account_and_slot(market_index)
        {
            Some(market) => Ok(market),
            None => {
                debug!(target: "rpc", "fetch market: perp/{market_index}");
                let market = derive_perp_market_account(market_index);
                self.backend.get_account_with_slot(&market).await
            }
        }
    }

    /// Try to spot market account from cache and slot it was fetched at
    ///
    /// * `market_index` - spot market index
    ///
    /// Returns error if not subscribed
    pub fn try_get_spot_market_account_and_slot(
        &self,
        market_index: u16,
    ) -> SdkResult<DataAndSlot<SpotMarket>> {
        if let Some(market) = self
            .backend
            .try_get_spot_market_account_and_slot(market_index)
        {
            Ok(market)
        } else {
            Err(SdkError::NoMarketData(MarketId::spot(market_index)))
        }
    }

    /// Try to get perp market account from cache and slot it was fetched at
    ///
    /// * `market_index` - spot market index
    ///
    /// Returns error if not subscribed
    pub fn try_get_perp_market_account_and_slot(
        &self,
        market_index: u16,
    ) -> SdkResult<DataAndSlot<PerpMarket>> {
        if let Some(market) = self
            .backend
            .try_get_perp_market_account_and_slot(market_index)
        {
            Ok(market)
        } else {
            Err(SdkError::NoMarketData(MarketId::perp(market_index)))
        }
    }

    /// Lookup a market by symbol
    ///
    /// This operation is not free so lookups should be reused/cached by the caller
    ///
    /// Returns None if symbol does not map to any known market
    pub fn market_lookup(&self, symbol: &str) -> Option<MarketId> {
        if symbol.to_ascii_lowercase().ends_with("-perp") {
            let markets = self.program_data().perp_market_configs();
            markets
                .iter()
                .find(|m| m.symbol().eq_ignore_ascii_case(symbol))
                .map(|m| MarketId::perp(m.market_index))
        } else {
            let markets = self.program_data().spot_market_configs();
            markets
                .iter()
                .find(|m| m.symbol().eq_ignore_ascii_case(symbol))
                .map(|m| MarketId::spot(m.market_index))
        }
    }

    /// Get live oracle price for `market`
    /// uses latest cached if subscribed, otherwise falls back to network query
    pub async fn oracle_price(&self, market: MarketId) -> SdkResult<i64> {
        self.backend.oracle_price(market).await
    }

    /// Initialize a transaction given a (sub)account address
    ///
    /// ```ignore
    /// let tx = client
    ///     .init_tx(&wallet.sub_account(3), false)
    ///     .cancel_all_orders()
    ///     .place_orders(...)
    ///     .build();
    /// ```
    /// Returns a `TransactionBuilder` for composing the tx
    pub async fn init_tx(
        &self,
        account: &Pubkey,
        delegated: bool,
    ) -> SdkResult<TransactionBuilder<'_>> {
        let account_data = self.get_user_account(account).await?;
        Ok(TransactionBuilder::new(
            self.program_data(),
            *account,
            Cow::Owned(account_data),
            delegated,
        ))
    }

    pub async fn get_recent_priority_fees(
        &self,
        writable_markets: &[MarketId],
        window: Option<usize>,
    ) -> SdkResult<Vec<u64>> {
        self.backend
            .get_recent_priority_fees(writable_markets, window)
            .await
    }

    /// Try get the latest oracle data for `market`
    ///
    /// If only the price is required use `oracle_price` instead
    pub fn try_get_oracle_price_data_and_slot(&self, market: MarketId) -> Option<Oracle> {
        self.backend.try_get_oracle_price_data_and_slot(market)
    }

    /// Get the AMM `OraclePriceData` if valid, otherwise return the conventional `OraclePriceData`
    ///
    /// ## Params
    /// * `market_index` - perp market index
    /// * `current_slot` - current solana slot
    ///
    pub fn try_get_mmoracle_for_perp_market(
        &self,
        market_index: u16,
        current_slot: Slot,
    ) -> SdkResult<OraclePriceData> {
        let oracle_data = self
            .try_get_oracle_price_data_and_slot(MarketId::perp(market_index))
            .ok_or(SdkError::InvalidOracle)?;
        let perp_market = self.try_get_perp_market_account(market_index)?;
        let oracle_validity_guard_rails = self.state_account().unwrap().oracle_guard_rails.validity;

        let drift_validity_guard_rails: drift::state::state::ValidityGuardRails =
            unsafe { std::mem::transmute_copy::<_, _>(&oracle_validity_guard_rails) };
        perp_market
            .get_mm_oracle_price_data(oracle_data.data, current_slot, &drift_validity_guard_rails)
            .map(|x| x.get_safe_oracle_price_data())
            .map_err(|e| SdkError::Anchor(Box::new(e.into())))
    }

    /// Get the latest oracle data for `market`
    ///
    /// If only the price is required use `oracle_price` instead
    pub async fn get_oracle_price_data_and_slot(&self, market: MarketId) -> SdkResult<Oracle> {
        self.backend.get_oracle(market).await
    }

    /// Subscribe to live WebSocket updates for some `account`
    ///
    /// The latest value may be retrieved with `client.get_account(..)`
    /// ```example(no_run)
    /// let subaccount = Wallet::derive_user_account(authority, 1);
    /// client.subscribe_account(&subaccount).await;
    /// let subaccount_data = client.get_account::<User>(&subaccount);
    /// ```
    pub async fn subscribe_account(&self, account: &Pubkey) -> SdkResult<()> {
        self.backend.account_map.subscribe_account(account).await
    }

    /// Same as `subscribe_account` but uses RPC polling
    pub async fn subscribe_account_polled(
        &self,
        account: &Pubkey,
        interval: Duration,
    ) -> SdkResult<()> {
        self.backend
            .account_map
            .subscribe_account_polled(account, Some(interval))
            .await
    }

    /// Unsubscribe from updates for `account`
    pub fn unsubscribe_account(&self, account: &Pubkey) -> SdkResult<()> {
        self.backend.account_map.unsubscribe_account(account);
        Ok(())
    }

    /// Return a reference to the internal spot market map
    #[cfg(feature = "unsafe_pub")]
    pub fn spot_market_map(&self) -> Arc<MapOf<u16, DataAndSlot<SpotMarket>>> {
        self.backend.spot_market_map.map()
    }

    /// Return a reference to the internal perp market map
    #[cfg(feature = "unsafe_pub")]
    pub fn perp_market_map(&self) -> Arc<MapOf<u16, DataAndSlot<PerpMarket>>> {
        self.backend.perp_market_map.map()
    }

    /// Return a reference to the internal oracle map
    #[cfg(feature = "unsafe_pub")]
    pub fn oracle_map(&self) -> Arc<MapOf<(Pubkey, u8), Oracle>> {
        self.backend.oracle_map.map()
    }

    /// Subscribe to all: markets, oracles, users, and slot updates over gRPC
    ///
    /// Updates are transparently handled by the `DriftClient` and calls to get User accounts, markets, oracles, etc.
    /// will utilize the latest cached updates from the gRPC subscription.
    ///
    /// use `opts` to control what is _cached_ by the client. The gRPC connection will always subscribe
    /// to all drift accounts regardless.
    ///
    /// * `endpoint` - the gRPC endpoint
    /// * `x_token` - gRPC authentication X token
    /// * `opts` - configure callbacks and caching
    /// * `sync` - sync all oracle,market,and User accounts on startup
    ///
    pub async fn grpc_subscribe(
        &self,
        endpoint: String,
        x_token: String,
        opts: GrpcSubscribeOpts,
        sync: bool,
    ) -> SdkResult<()> {
        self.backend
            .grpc_subscribe(endpoint, x_token, opts, sync)
            .await
    }

    /// Unsubscribe the gRPC connection
    pub fn grpc_unsubscribe(&self) {
        self.backend.grpc_unsubscribe();
    }

    pub async fn get_slot(&self) -> Option<u64> {
        self.backend.client().get_slot().await.ok()
    }

    /// Return a reference to the internal backend
    #[cfg(feature = "unsafe_pub")]
    pub fn backend(&self) -> &'static DriftClientBackend {
        self.backend
    }
}

/// Provides the heavy-lifting and network facing features of the SDK
/// It is intended to be a singleton
pub struct DriftClientBackend {
    rpc_client: Arc<RpcClient>,
    pubsub_client: Arc<PubsubClient>,
    program_data: ProgramData,
    blockhash_subscriber: BlockhashSubscriber,
    account_map: AccountMap,
    perp_market_map: MarketMap<PerpMarket>,
    spot_market_map: MarketMap<SpotMarket>,
    oracle_map: OracleMap,
    grpc_unsub: RwLock<Option<(UnsubHandle, UnsubHandle)>>,
}
impl DriftClientBackend {
    /// Initialize a new `DriftClientBackend`
    async fn new(context: Context, rpc_client: Arc<RpcClient>) -> SdkResult<Self> {
        let pubsub_client =
            Arc::new(PubsubClient::new(&get_ws_url(rpc_client.url().as_str())?).await?);

        let perp_market_map =
            MarketMap::<PerpMarket>::new(Arc::clone(&pubsub_client), rpc_client.commitment());
        let spot_market_map =
            MarketMap::<SpotMarket>::new(Arc::clone(&pubsub_client), rpc_client.commitment());

        let lut_pubkeys = context.luts();

        let account_map = AccountMap::new(
            Arc::clone(&pubsub_client),
            Arc::clone(&rpc_client),
            rpc_client.commitment(),
        );

        tokio::try_join!(
            account_map.subscribe_account_polled(state_account(), Some(Duration::from_secs(180))),
            account_map.subscribe_account_polled(
                high_leverage_mode_account(),
                Some(Duration::from_secs(180))
            )
        )?;

        let (_, _, lut_accounts, state_account_data) = tokio::try_join!(
            perp_market_map.sync(&rpc_client),
            spot_market_map.sync(&rpc_client),
            rpc_client
                .get_multiple_accounts(lut_pubkeys)
                .map_err(Into::into),
            rpc_client
                .get_account_data(state_account())
                .map_err(Into::into),
        )?;

        let lookup_tables = lut_pubkeys
            .iter()
            .zip(lut_accounts.iter())
            .filter_map(|(pubkey, account_data)| match account_data.as_ref() {
                Some(data) => {
                    Some(utils::deserialize_alt(*pubkey, data).map_err(|_| SdkError::Deserializing))
                }
                None => {
                    log::warn!("LUT account missing, skipping: {pubkey}");
                    None
                }
            })
            .collect::<SdkResult<Vec<_>>>()?;

        let mut all_oracles = Vec::<(MarketId, Pubkey, OracleSource)>::with_capacity(
            perp_market_map.len() + spot_market_map.len(),
        );
        for market_oracle_info in perp_market_map
            .oracles()
            .iter()
            .chain(spot_market_map.oracles().iter())
        {
            all_oracles.push(*market_oracle_info);
        }

        let oracle_map = OracleMap::new(
            Arc::clone(&pubsub_client),
            all_oracles.as_slice(),
            rpc_client.commitment(),
        );

        Ok(Self {
            rpc_client: Arc::clone(&rpc_client),
            pubsub_client,
            blockhash_subscriber: BlockhashSubscriber::new(Duration::from_secs(2), rpc_client),
            program_data: ProgramData::new(
                spot_market_map.values(),
                perp_market_map.values(),
                lookup_tables,
                State::try_deserialize(&mut state_account_data.as_slice()).unwrap(),
            ),
            account_map,
            perp_market_map,
            spot_market_map,
            oracle_map,
            grpc_unsub: RwLock::default(),
        })
    }

    pub async fn new_with_explicit_ws_url(
        context: Context,
        rpc_client: Arc<RpcClient>,
        ws_pubsub_url: &str,
    ) -> SdkResult<Self> {
        use std::time::Duration;

        // Initialize PubsubClient with explicit URL
        let pubsub_client = Arc::new(PubsubClient::new(ws_pubsub_url).await?);

        let perp_market_map =
            MarketMap::<PerpMarket>::new(Arc::clone(&pubsub_client), rpc_client.commitment());
        let spot_market_map =
            MarketMap::<SpotMarket>::new(Arc::clone(&pubsub_client), rpc_client.commitment());

        let lut_pubkeys = context.luts();

        let account_map = AccountMap::new(
            Arc::clone(&pubsub_client),
            Arc::clone(&rpc_client),
            rpc_client.commitment(),
        );

        tokio::try_join!(
            account_map.subscribe_account_polled(state_account(), Some(Duration::from_secs(180))),
            account_map.subscribe_account_polled(
                high_leverage_mode_account(),
                Some(Duration::from_secs(180))
            )
        )?;

        let (_, _, lut_accounts, state_account_data) = tokio::try_join!(
            perp_market_map.sync(&rpc_client),
            spot_market_map.sync(&rpc_client),
            rpc_client
                .get_multiple_accounts(lut_pubkeys)
                .map_err(Into::into),
            rpc_client
                .get_account_data(state_account())
                .map_err(Into::into),
        )?;

        let lookup_tables = lut_pubkeys
            .iter()
            .zip(lut_accounts.iter())
            .map(|(pubkey, account_data)| {
                utils::deserialize_alt(*pubkey, account_data.as_ref().unwrap())
                    .expect("LUT decodes")
            })
            .collect();

        let mut all_oracles = Vec::<(MarketId, Pubkey, OracleSource)>::with_capacity(
            perp_market_map.len() + spot_market_map.len(),
        );
        for market_oracle_info in perp_market_map
            .oracles()
            .iter()
            .chain(spot_market_map.oracles().iter())
        {
            all_oracles.push(*market_oracle_info);
        }

        let oracle_map = OracleMap::new(
            Arc::clone(&pubsub_client),
            all_oracles.as_slice(),
            rpc_client.commitment(),
        );

        Ok(Self {
            rpc_client: Arc::clone(&rpc_client),
            pubsub_client,
            blockhash_subscriber: BlockhashSubscriber::new(Duration::from_secs(2), rpc_client),
            program_data: ProgramData::new(
                spot_market_map.values(),
                perp_market_map.values(),
                lookup_tables,
                State::try_deserialize(&mut state_account_data.as_slice()).unwrap(),
            ),
            account_map,
            perp_market_map,
            spot_market_map,
            oracle_map,
            grpc_unsub: RwLock::default(),
        })
    }

    /// Returns true if `DriftClientBackend` is subscribed via gRPC
    pub fn is_grpc_subscribed(&self) -> bool {
        let unsub = self.grpc_unsub.read().unwrap();
        unsub.is_some()
    }

    /// Start subscription for latest block hashes
    async fn subscribe_blockhashes(&self) -> SdkResult<()> {
        self.blockhash_subscriber.subscribe();
        Ok(())
    }

    /// Start subscriptions for market account updates
    async fn subscribe_markets(&self, markets: &[MarketId]) -> SdkResult<()> {
        self.subscribe_markets_inner(markets, EMPTY_ACCOUNT_CALLBACK)
            .await
    }

    async fn subscribe_markets_with_callback<F>(
        &self,
        markets: &[MarketId],
        on_account: F,
    ) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        self.subscribe_markets_inner(markets, on_account).await
    }

    async fn subscribe_markets_inner<F>(&self, markets: &[MarketId], on_account: F) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        if self.is_grpc_subscribed() {
            log::info!("already subscribed markets via gRPC");
            return Err(SdkError::AlreadySubscribed);
        }

        let (perps, spot) = markets
            .iter()
            .partition::<Vec<MarketId>, _>(|x| x.is_perp());
        let _ = tokio::try_join!(
            self.perp_market_map
                .subscribe_with_callback(&perps, on_account.clone()),
            self.spot_market_map
                .subscribe_with_callback(&spot, on_account),
        )?;

        Ok(())
    }

    /// Start subscriptions for market oracle accounts
    async fn subscribe_oracles(&self, markets: &[MarketId]) -> SdkResult<()> {
        self.subscribe_oracles_inner(markets, EMPTY_ACCOUNT_CALLBACK)
            .await
    }

    async fn subscribe_oracles_with_callback<F>(
        &self,
        markets: &[MarketId],
        on_account: F,
    ) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        self.subscribe_oracles_inner(markets, on_account).await
    }

    async fn subscribe_oracles_inner<F>(&self, markets: &[MarketId], on_account: F) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        if self.is_grpc_subscribed() {
            log::info!("already subscribed oracles via gRPC");
            return Err(SdkError::AlreadySubscribed);
        }

        self.oracle_map
            .subscribe_with_callback(markets, on_account)
            .await
    }

    /// Subscribe to all: markets, oracles, and slot updates over gRPC
    async fn grpc_subscribe(
        &self,
        endpoint: String,
        x_token: String,
        opts: GrpcSubscribeOpts,
        sync: bool,
    ) -> SdkResult<()> {
        log::debug!(target: "grpc", "subscribing to grpc with config: commitment: {:?}, interslot updates: {:?}", opts.commitment, opts.interslot_updates);
        let mut grpc = DriftGrpcClient::new(endpoint.clone(), x_token.clone())
            .grpc_connection_opts(opts.connection_opts.clone());

        if sync {
            // the DriftClientBackend syncs marketmaps by default
            if self.perp_market_map.len() == 0 {
                self.perp_market_map.sync(&self.rpc_client).await?;
            }
            if self.spot_market_map.len() == 0 {
                self.spot_market_map.sync(&self.rpc_client).await?;
            }
            let spot_markets = self
                .spot_market_map
                .marketmap
                .iter()
                .map(|i| MarketId::spot(*i.key()));
            let perp_markets = self
                .perp_market_map
                .marketmap
                .iter()
                .map(|i| MarketId::perp(*i.key()));
            let all_markets: Vec<MarketId> = spot_markets.chain(perp_markets).collect();

            self.oracle_map
                .sync(all_markets.as_ref(), &self.rpc_client)
                .await?;
        }

        grpc.on_account(
            AccountFilter::partial().with_discriminator(SpotMarket::DISCRIMINATOR),
            self.spot_market_map.on_account_fn(),
        );
        grpc.on_account(
            AccountFilter::partial().with_discriminator(PerpMarket::DISCRIMINATOR),
            self.perp_market_map.on_account_fn(),
        );

        if opts.user_stats_map {
            grpc.on_account(
                AccountFilter::partial().with_discriminator(UserStats::DISCRIMINATOR),
                self.account_map.on_account_fn(),
            );
        }

        let transactions_accounts_include = opts
            .transaction_include_accounts
            .iter()
            .map(|a| a.to_string())
            .collect();
        if let Some(f) = opts.on_transaction {
            grpc.on_transaction(f);
        }

        // set custom callbacks
        if let Some(callbacks) = opts.on_account {
            for (filter, on_account) in callbacks {
                grpc.on_account(filter, on_account)
            }
        }

        if let Some(f) = opts.on_slot {
            grpc.on_slot(f);
        }

        if let Some(f) = opts.on_block_meta {
            grpc.on_block_meta(f);
        }

        if opts.usermap {
            grpc.on_account(
                AccountFilter::partial().with_discriminator(User::DISCRIMINATOR),
                self.account_map.on_account_fn(),
            );
        } else {
            // when usermap is on, the custom accounts are already included
            // usermap off: subscribe to custom `User` accounts
            grpc.on_account(
                AccountFilter::full()
                    .with_discriminator(User::DISCRIMINATOR)
                    .with_accounts(opts.user_accounts.into_iter()),
                self.account_map.on_account_fn(),
            );
        }

        if opts.user_stats_map {
            grpc.on_account(
                AccountFilter::partial().with_discriminator(UserStats::DISCRIMINATOR),
                self.account_map.on_account_fn(),
            );
        }

        // start subscription
        let commitment = opts.commitment.unwrap_or(CommitmentLevel::Confirmed);
        let grpc_unsub = grpc
            .subscribe(
                commitment,
                GeyserSubscribeOpts {
                    accounts_owners: vec![PROGRAM_ID.to_string()],
                    interslot_updates: Some(opts.interslot_updates),
                    transactions_accounts_include,
                    blocks_meta: opts.subscribe_block_meta_updates,
                    slot_updates: opts.subscribe_slot_updates,
                    ..Default::default()
                },
            )
            .await
            .map_err(|err| SdkError::Grpc(Box::new(err)))?;

        // oracle pubkeys are subscribed individually
        // due to ownership differences
        let mut oracles_grpc =
            DriftGrpcClient::new(endpoint, x_token).grpc_connection_opts(opts.connection_opts);

        let oracle_pubkeys: Vec<String> = self
            .oracle_map
            .oracle_by_market
            .iter()
            .map(|(_, (pubkey, _))| pubkey.to_string())
            .collect();

        if let Some(on_oracle) = opts.on_oracle_update {
            oracles_grpc.on_account(AccountFilter::firehose(), on_oracle);
        }

        if opts.oraclemap {
            oracles_grpc.on_account(AccountFilter::firehose(), self.oracle_map.on_account_fn());
        }

        let oracles_grpc_unsub = oracles_grpc
            .subscribe(
                commitment,
                GeyserSubscribeOpts {
                    accounts_pubkeys: oracle_pubkeys,
                    interslot_updates: Some(opts.interslot_updates),
                    ..Default::default()
                },
            )
            .await
            .map_err(|err| SdkError::Grpc(Box::new(err)))?;

        let mut unsub = self.grpc_unsub.write().unwrap();
        let _ = unsub.insert((grpc_unsub, oracles_grpc_unsub));

        Ok(())
    }

    /// Unsubscribe the gRPC connections
    fn grpc_unsubscribe(&self) {
        let mut guard = self.grpc_unsub.write().unwrap();
        if let Some((a, b)) = guard.take() {
            let _ = a.send(());
            let _ = b.send(());
        }
    }

    /// End subscriptions to live program data
    async fn unsubscribe(&self) -> SdkResult<()> {
        self.blockhash_subscriber.unsubscribe();
        self.perp_market_map.unsubscribe_all()?;
        self.spot_market_map.unsubscribe_all()?;
        self.account_map.unsubscribe_account(state_account());
        self.oracle_map.unsubscribe_all()
    }

    pub fn try_get_perp_market_account_and_slot(
        &self,
        market_index: u16,
    ) -> Option<DataAndSlot<PerpMarket>> {
        self.perp_market_map.get(&market_index)
    }

    pub fn try_get_spot_market_account_and_slot(
        &self,
        market_index: u16,
    ) -> Option<DataAndSlot<SpotMarket>> {
        self.spot_market_map.get(&market_index)
    }

    pub fn try_get_oracle_price_data_and_slot(&self, market: MarketId) -> Option<Oracle> {
        self.oracle_map.get_by_market(&market)
    }

    /// Same as `try_get_oracle_price_data_and_slot` but checks the oracle pubkey has not changed
    /// this can be useful if the oracle address changes in the program
    pub fn try_get_oracle_price_data_and_slot_checked(&self, market: MarketId) -> Option<Oracle> {
        let current_oracle = self
            .oracle_map
            .get_by_market(&market)
            .expect("oracle")
            .pubkey;

        let program_configured_oracle = if market.is_perp() {
            let market = self.try_get_perp_market_account_and_slot(market.index())?;
            market.data.oracle
        } else {
            let market = self.try_get_spot_market_account_and_slot(market.index())?;
            market.data.oracle
        };

        if program_configured_oracle != current_oracle {
            panic!("invalid oracle: {}", market.index());
        }

        self.try_get_oracle_price_data_and_slot(market)
    }

    /// Return a handle to the inner RPC client
    fn client(&self) -> Arc<RpcClient> {
        Arc::clone(&self.rpc_client)
    }

    /// Return a handle to the inner RPC client
    fn ws(&self) -> Arc<PubsubClient> {
        Arc::clone(&self.pubsub_client)
    }

    /// Get recent tx priority fees
    ///
    /// * `writable_markets` - markets to consider for write locks
    /// * `window` - # of slots to include in the fee calculation
    async fn get_recent_priority_fees(
        &self,
        writable_markets: &[MarketId],
        window: Option<usize>,
    ) -> SdkResult<Vec<u64>> {
        let addresses: Vec<Pubkey> = writable_markets
            .iter()
            .filter_map(|x| match x.kind() {
                MarketType::Spot => self
                    .program_data
                    .spot_market_config_by_index(x.index())
                    .map(|x| x.pubkey),
                MarketType::Perp => self
                    .program_data
                    .perp_market_config_by_index(x.index())
                    .map(|x| x.pubkey),
            })
            .collect();

        let response = self
            .rpc_client
            .get_recent_prioritization_fees(addresses.as_slice())
            .await?;
        let window = window.unwrap_or(5).max(1);
        let fees = response
            .iter()
            .take(window)
            .map(|x| x.prioritization_fee)
            .collect();

        Ok(fees)
    }

    /// Fetch `account` as an Anchor account type `T`
    pub async fn get_account<T: AccountDeserialize + Pod + Discriminator>(
        &self,
        account: &Pubkey,
    ) -> SdkResult<T> {
        if let Some(value) = self.account_map.account_data(account) {
            Ok(value)
        } else {
            let account_data = self.rpc_client.get_account_data(account).await?;
            if account_data.is_empty() {
                return Err(SdkError::NoAccountData(*account));
            }
            T::try_deserialize(&mut account_data.as_slice())
                .map_err(|err| SdkError::Anchor(Box::new(err)))
        }
    }

    /// Fetch `account` as an Anchor account type `T` along with the retrieved slot
    pub async fn get_account_with_slot<T: AccountDeserialize + Pod + Discriminator>(
        &self,
        account: &Pubkey,
    ) -> SdkResult<DataAndSlot<T>> {
        if let Some(value) = self.account_map.account_data_and_slot(account) {
            Ok(value)
        } else {
            let (account, slot) = self.get_account_with_slot_raw(account).await?;
            Ok(DataAndSlot {
                slot,
                data: T::try_deserialize(&mut account.data.as_slice())
                    .map_err(|err| SdkError::Anchor(Box::new(err)))?,
            })
        }
    }

    /// Fetch `account` as a drift User account
    ///
    /// uses latest cached if subscribed, otherwise falls back to network query
    pub async fn get_user_account(&self, account: &Pubkey) -> SdkResult<User> {
        self.get_account(account).await
    }

    /// Fetch `account` as a drift User account and slot it was fetched at
    ///
    /// uses latest cached if subscribed, otherwise falls back to network query
    pub async fn get_user_account_with_slot(
        &self,
        account: &Pubkey,
    ) -> SdkResult<DataAndSlot<User>> {
        self.get_account_with_slot(account).await
    }

    /// Try to fetch `account` as `T` using latest local value
    /// requires account was previously subscribed too.
    pub fn try_get_account<T: AccountDeserialize + Pod + Discriminator>(
        &self,
        account: &Pubkey,
    ) -> SdkResult<T> {
        self.account_map
            .account_data(account)
            .ok_or_else(|| SdkError::NoAccountData(*account))
    }

    /// Returns latest blockhash
    ///
    /// uses latest cached if subscribed, otherwise falls back to network query
    pub async fn get_latest_blockhash(&self) -> SdkResult<Hash> {
        match self.blockhash_subscriber.get_latest_blockhash() {
            Some(hash) => Ok(hash),
            None => self
                .rpc_client
                .get_latest_blockhash()
                .await
                .map_err(|err| SdkError::Rpc(Box::new(err))),
        }
    }

    /// Sign and send a tx to the network
    ///
    /// Returns the signature on success
    pub async fn sign_and_send(
        &self,
        wallet: &Wallet,
        tx: VersionedMessage,
        recent_block_hash: Hash,
    ) -> SdkResult<Signature> {
        let tx = wallet.sign_tx(tx, recent_block_hash)?;
        self.rpc_client
            .send_transaction(&tx)
            .await
            .map_err(Into::into)
    }

    /// Sign and send a tx to the network with custom send config
    /// allows setting commitment level, retries, etc.
    ///
    /// Returns the signature on success
    pub async fn sign_and_send_with_config(
        &self,
        wallet: &Wallet,
        tx: VersionedMessage,
        recent_block_hash: Hash,
        config: RpcSendTransactionConfig,
    ) -> SdkResult<Signature> {
        let tx = wallet.sign_tx(tx, recent_block_hash)?;
        self.rpc_client
            .send_transaction_with_config(&tx, config)
            .await
            .map_err(Into::into)
    }

    /// Fetch the live oracle price for `market`
    ///
    /// Uses latest local value from an `OracleMap` if subscribed, falls back to network query
    pub async fn oracle_price(&self, market: MarketId) -> SdkResult<i64> {
        self.get_oracle(market).await.map(|o| o.data.price)
    }

    /// Fetch live oracle data for `market`
    ///
    /// Uses latest local value from an `OracleMap` if subscribed, falls back to network query
    pub async fn get_oracle(&self, market: MarketId) -> SdkResult<Oracle> {
        if let Some(oracle) = self.try_get_oracle_price_data_and_slot(market) {
            Ok(oracle)
        } else {
            debug!(target: "rpc", "fetch oracle account: {market:?}");
            let (oracle, oracle_source) = match market.kind() {
                MarketType::Perp => {
                    let market = self
                        .program_data
                        .perp_market_config_by_index(market.index())
                        .ok_or(SdkError::InvalidOracle)?;
                    (market.oracle, market.oracle_source)
                }
                MarketType::Spot => {
                    let market = self
                        .program_data
                        .spot_market_config_by_index(market.index())
                        .ok_or(SdkError::InvalidOracle)?;
                    (market.oracle, market.oracle_source)
                }
            };
            let (mut account_data, slot) = self.get_account_with_slot_raw(&oracle).await?;
            let oracle_price_data = drift::sdk::oracle_price(
                &oracle_source,
                &oracle,
                &account_data.owner,
                &mut account_data.data,
                slot,
            )
            .map_err(|e| SdkError::Anchor(Box::new(e.into())))?;

            Ok(Oracle {
                pubkey: oracle,
                source: oracle_source,
                slot,
                data: oracle_price_data,
                raw: account_data.data,
            })
        }
    }

    /// Get account via rpc along with retrieved slot number
    async fn get_account_with_slot_raw(&self, pubkey: &Pubkey) -> SdkResult<(Account, Slot)> {
        match self
            .rpc_client
            .get_account_with_commitment(pubkey, self.rpc_client.commitment())
            .await
        {
            Ok(Response {
                context,
                value: Some(account),
            }) => Ok((account, context.slot)),
            Ok(Response {
                context: _,
                value: None,
            }) => Err(SdkError::InvalidAccount),
            Err(err) => Err(err.into()),
        }
    }

    #[cfg(feature = "unsafe_pub")]
    pub fn account_map(&self) -> &AccountMap {
        &self.account_map
    }

    #[cfg(feature = "unsafe_pub")]
    pub fn perp_market_map(&self) -> &MarketMap<PerpMarket> {
        &self.perp_market_map
    }

    #[cfg(feature = "unsafe_pub")]
    pub fn spot_market_map(&self) -> &MarketMap<SpotMarket> {
        &self.spot_market_map
    }

    #[cfg(feature = "unsafe_pub")]
    pub fn oracle_map(&self) -> &OracleMap {
        &self.oracle_map
    }
}

/// Configure markets as forced for inclusion by `TransactionBuilder`
///
/// In contrast, without this Transactions are built using the latest known state of
/// users's open positions and orders, which can result in race conditions when executed onchain.
#[derive(Default)]
struct ForceMarkets {
    /// markets must include as readable
    readable: Vec<MarketId>,
    /// markets must include as writeable
    writeable: Vec<MarketId>,
}

impl ForceMarkets {
    /// Set given `markets` as readable, enforcing there inclusion in a final Tx
    pub fn with_readable(&mut self, markets: &[MarketId]) -> &mut Self {
        self.readable = markets.to_vec();
        self
    }
    /// Set given `markets` as writeable, enforcing there inclusion in a final Tx
    pub fn with_writeable(&mut self, markets: &[MarketId]) -> &mut Self {
        self.writeable = markets.to_vec();
        self
    }
}

/// Composable Tx builder for Drift program
///
/// Alternatively, use `DriftClient::init_tx` for simpler instantiation.
///
/// ```example(no_run)
/// use drift_rs::{types::Context, TransactionBuilder, Wallet};
///
/// let wallet = Wallet::from_seed_bs58("seed");
/// let client = DriftClient::new(Context::DevNet, "api.example.com", wallet).await.unwrap();
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
    /// sub-account data
    account_data: Cow<'a, User>,
    /// contextual on-chain program data
    program_data: &'a ProgramData,
    /// ordered list of instructions
    ixs: Vec<Instruction>,
    /// Tx lookup tables (v0 only)
    lookup_tables: Vec<AddressLookupTableAccount>,
    /// some markets forced to include in the tx accounts list
    force_markets: ForceMarkets,
    /// the drift sub-account address
    sub_account: Pubkey,
    /// either account authority or account delegate
    authority: Pubkey,
    /// use legacy transaction mode
    legacy: bool,
    /// optional fee payer account (defaults to `authority`)
    fee_payer: Option<Pubkey>,
}

/// Jupiter swap instructions prepared for insertion into a transaction
pub struct JupiterSwapInstructions {
    /// Account creation instructions (if needed)
    pub account_creation_instructions: Vec<Instruction>,
    /// The amount being swapped in (for begin wrapper)
    pub in_amount: u64,
    /// The main Jupiter swap instruction
    pub swap_instruction: Instruction,
    /// Optional cleanup instruction (e.g., SOL unwrap)
    pub cleanup_instruction: Option<Instruction>,
    /// Lookup tables for the transaction
    pub luts: Vec<AddressLookupTableAccount>,
}

#[cfg(feature = "titan")]
/// Titan swap instructions prepared for insertion into a transaction
pub struct TitanSwapInstructions {
    /// Account creation instructions (if needed)
    pub account_creation_instructions: Vec<Instruction>,
    /// The amount being swapped in (for begin wrapper)
    pub in_amount: u64,
    /// All Titan swap instructions
    pub swap_instructions: Vec<Instruction>,
    /// Lookup tables for the transaction
    pub luts: Vec<AddressLookupTableAccount>,
}

impl<'a> TransactionBuilder<'a> {
    /// Initialize a new `TransactionBuilder` for default signer
    ///
    /// * `program_data` - program data from chain
    /// * `sub_account` - drift sub-account address
    /// * `user` - drift sub-account data
    /// * `delegated` - set true to build tx for delegated signing
    pub fn new<'b>(
        program_data: &'b ProgramData,
        sub_account: Pubkey,
        user: Cow<'b, User>,
        delegated: bool,
    ) -> Self
    where
        'b: 'a,
    {
        Self {
            authority: if delegated {
                user.delegate
            } else {
                user.authority
            },
            program_data,
            account_data: user,
            sub_account,
            ixs: Default::default(),
            lookup_tables: program_data.lookup_tables.to_vec(),
            legacy: false,
            force_markets: Default::default(),
            fee_payer: None,
        }
    }
    /// Pubkey of sub-account owner
    fn owner(&self) -> Pubkey {
        self.account_data.authority
    }
    /// force given `markets` to be included in the final tx accounts list (ensure to call before building ixs)
    pub fn force_include_markets(&mut self, readable: &[MarketId], writeable: &[MarketId]) {
        self.force_markets.with_readable(readable);
        self.force_markets.with_writeable(writeable);
    }
    /// Use legacy tx mode
    pub fn legacy(mut self) -> Self {
        self.legacy = true;
        self
    }
    /// Set fee payer
    pub fn fee_payer(mut self, fee_payer: Pubkey) -> Self {
        self.fee_payer = Some(fee_payer);
        self
    }
    /// Extend the tx lookup tables (always includes the defacto drift LUTs)
    pub fn lookup_tables(mut self, lookup_tables: &[AddressLookupTableAccount]) -> Self {
        self.lookup_tables.extend_from_slice(lookup_tables);

        self
    }
    /// Set the priority fee of the tx
    ///
    /// * `microlamports_per_cu` - the price per unit of compute in µ-lamports
    pub fn with_priority_fee(mut self, microlamports_per_cu: u64, cu_limit: Option<u32>) -> Self {
        let cu_limit_ix = ComputeBudgetInstruction::set_compute_unit_price(microlamports_per_cu);
        self.ixs.insert(0, cu_limit_ix);
        if let Some(cu_limit) = cu_limit {
            let cu_price_ix = ComputeBudgetInstruction::set_compute_unit_limit(cu_limit);
            self.ixs.insert(1, cu_price_ix);
        }

        self
    }

    /// Append an ix to the Tx
    pub fn add_ix(mut self, ix: Instruction) -> Self {
        self.ixs.push(ix);
        self
    }

    /// Set ix at index
    pub fn set_ix(mut self, idx: usize, ix: Instruction) -> Self {
        self.ixs[idx] = ix;
        self
    }

    /// Return the ixs currently included in the Transaction
    pub fn ixs(&self) -> &[Instruction] {
        &self.ixs
    }

    pub fn transfer_isolated_perp_position_deposit(
        mut self,
        amount: i64,
        market_index: u16,
    ) -> Self {
        // assume USDC collateralized
        let quote_spot_market = self
            .program_data
            .spot_market_config_by_index(MarketId::QUOTE_SPOT.index())
            .expect("spot markets syncd");
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::TransferIsolatedPerpPositionDeposit {
                state: *state_account(),
                user: self.sub_account,
                user_stats: Wallet::derive_stats_account(&self.owner()),
                authority: self.authority,
                spot_market_vault: quote_spot_market.vault,
            },
            [self.account_data.as_ref()].into_iter(),
            self.force_markets
                .readable
                .iter()
                .chain(&[MarketId::perp(market_index)]),
            self.force_markets
                .writeable
                .iter()
                .chain(&[MarketId::QUOTE_SPOT]),
        );
        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::TransferIsolatedPerpPositionDeposit {
                perp_market_index: market_index,
                spot_market_index: quote_spot_market.market_index,
                amount,
            }),
        };

        self.ixs.push(ix);

        self
    }

    /// Deposit collateral into the user's account for a given spot market.
    ///
    /// Automatically derives the user's associated token account. Optionally supports reduce-only deposits.
    ///
    /// # Parameters
    /// - `amount`: The amount of collateral to deposit (in native units).
    /// - `market_index`: The spot market index to deposit into.
    /// - `reduce_only`: If `Some(true)`, only reduces an existing borrow; otherwise, acts as a normal deposit.
    /// - `transfer_hook`: transfer hook program address, if required by the spot token
    pub fn deposit(
        mut self,
        amount: u64,
        market_index: u16,
        reduce_only: Option<bool>,
        transfer_hook: Option<Pubkey>,
    ) -> Self {
        let spot_market = self
            .program_data
            .spot_market_config_by_index(market_index)
            .expect("spot markets syncd");
        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::Deposit {
                state: *state_account(),
                user: self.sub_account,
                user_stats: Wallet::derive_stats_account(&self.owner()),
                authority: self.authority,
                spot_market_vault: spot_market.vault,
                user_token_account: Wallet::derive_associated_token_address(
                    &self.authority,
                    spot_market,
                ),
                token_program: spot_market.token_program(),
            },
            [self.account_data.as_ref()].into_iter(),
            self.force_markets.readable.iter(),
            [MarketId::spot(market_index)].iter(),
        );

        if spot_market.has_transfer_hook() {
            accounts.push(AccountMeta::new_readonly(
                transfer_hook.expect("requires transfer hook"),
                false,
            ));
        }

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::Deposit {
                market_index,
                amount,
                reduce_only: reduce_only.unwrap_or(false),
            }),
        };

        self.ixs.push(ix);

        self
    }

    /// Withdraw collateral from the user's account for a given spot market.
    ///
    /// Automatically derives the user's associated token account. Optionally supports reduce-only withdrawals.
    ///
    /// # Parameters
    /// - `amount`: The amount of collateral to withdraw (in native units).
    /// - `market_index`: The spot market index to withdraw from.
    /// - `reduce_only`: If `Some(true)`, only reduces an existing deposit; otherwise, acts as a normal withdrawal.
    /// - `transfer_hook`: transfer hook program address, if required by the spot token
    pub fn withdraw(
        mut self,
        amount: u64,
        market_index: u16,
        reduce_only: Option<bool>,
        transfer_hook: Option<Pubkey>,
    ) -> Self {
        let spot_market = self
            .program_data
            .spot_market_config_by_index(market_index)
            .expect("spot markets syncd");
        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::Withdraw {
                state: *state_account(),
                user: self.sub_account,
                user_stats: Wallet::derive_stats_account(&self.owner()),
                authority: self.authority,
                spot_market_vault: spot_market.vault,
                user_token_account: Wallet::derive_associated_token_address(
                    &self.authority,
                    spot_market,
                ),
                velocity_signer: constants::derive_drift_signer(),
                token_program: spot_market.token_program(),
            },
            [self.account_data.as_ref()].into_iter(),
            self.force_markets.readable.iter(),
            [MarketId::spot(market_index)]
                .iter()
                .chain(self.force_markets.writeable.iter()),
        );

        if spot_market.has_transfer_hook() {
            accounts.push(AccountMeta::new_readonly(
                transfer_hook.expect("requires transfer hook"),
                false,
            ));
        }

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::Withdraw {
                market_index,
                amount,
                reduce_only: reduce_only.unwrap_or(false),
            }),
        };

        self.ixs.push(ix);

        self
    }

    /// Place new orders for account
    ///
    /// * `orders` list of orders to place
    pub fn place_orders(mut self, orders: Vec<OrderParams>) -> Self {
        let mut readable_accounts: Vec<MarketId> = orders
            .iter()
            .map(|o| (o.market_index, o.market_type).into())
            .collect();
        readable_accounts.extend(&self.force_markets.readable);

        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::PlaceOrder {
                state: *state_account(),
                authority: self.authority,
                user: self.sub_account,
            },
            [self.account_data.as_ref()].into_iter(),
            readable_accounts.iter(),
            self.force_markets.writeable.iter(),
        );

        // Upstream drift removed User.margin_mode; high-leverage mode now
        // comes exclusively from individual OrderParams flags.
        if orders.iter().any(|x| x.high_leverage_mode()) {
            accounts.push(AccountMeta::new(*high_leverage_mode_account(), false));
        }

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::PlaceOrders { params: orders }),
        };

        self.ixs.push(ix);

        self
    }

    /// Cancel all orders for account
    pub fn cancel_all_orders(mut self) -> Self {
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::CancelOrder {
                state: *state_account(),
                authority: self.authority,
                user: self.sub_account,
            },
            [self.account_data.as_ref()].into_iter(),
            self.force_markets.readable.iter(),
            self.force_markets.writeable.iter(),
        );

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::CancelOrders {
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
    /// * `market` - tuple of market index and type (spot or perp)
    /// * `direction` - long or short
    pub fn cancel_orders(
        mut self,
        market: (u16, MarketType),
        direction: Option<PositionDirection>,
    ) -> Self {
        let (idx, r#type) = market;
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::CancelOrder {
                state: *state_account(),
                authority: self.authority,
                user: self.sub_account,
            },
            [self.account_data.as_ref()].into_iter(),
            [(idx, r#type).into()]
                .iter()
                .chain(self.force_markets.readable.iter()),
            self.force_markets.writeable.iter(),
        );

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::CancelOrders {
                market_index: Some(idx),
                market_type: Some(r#type),
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
            drift::accounts::CancelOrder {
                state: *state_account(),
                authority: self.authority,
                user: self.sub_account,
            },
            [self.account_data.as_ref()].into_iter(),
            self.force_markets.readable.iter(),
            self.force_markets.writeable.iter(),
        );

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::CancelOrdersByIds { order_ids }),
        };
        self.ixs.push(ix);

        self
    }

    /// Cancel orders by given _user_ ids
    pub fn cancel_orders_by_user_id(mut self, user_order_ids: Vec<u8>) -> Self {
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::CancelOrder {
                state: *state_account(),
                authority: self.authority,
                user: self.sub_account,
            },
            [self.account_data.as_ref()].into_iter(),
            self.force_markets.readable.iter(),
            self.force_markets.writeable.iter(),
        );

        for user_order_id in user_order_ids {
            let ix = Instruction {
                program_id: constants::PROGRAM_ID,
                accounts: accounts.clone(),
                data: InstructionData::data(&drift::instruction::CancelOrderByUserId {
                    user_order_id,
                }),
            };
            self.ixs.push(ix);
        }

        self
    }

    /// Modify existing order(s) by order id
    pub fn modify_orders(mut self, orders: &[(u32, ModifyOrderParams)]) -> Self {
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::CancelOrder {
                state: *state_account(),
                authority: self.authority,
                user: self.sub_account,
            },
            [self.account_data.as_ref()].into_iter(),
            self.force_markets.readable.iter(),
            self.force_markets.writeable.iter(),
        );

        for (order_id, params) in orders {
            let ix = Instruction {
                program_id: constants::PROGRAM_ID,
                accounts: accounts.clone(),
                data: InstructionData::data(&drift::instruction::ModifyOrder {
                    order_id: Some(*order_id),
                    modify_order_params: params.clone(),
                }),
            };
            self.ixs.push(ix);
        }

        self
    }

    /// Modify existing order(s) by user order id
    pub fn modify_orders_by_user_id(mut self, orders: &[(u8, ModifyOrderParams)]) -> Self {
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::PlaceOrder {
                state: *state_account(),
                authority: self.authority,
                user: self.sub_account,
            },
            [self.account_data.as_ref()].into_iter(),
            self.force_markets.readable.iter(),
            self.force_markets.writeable.iter(),
        );

        for (user_order_id, params) in orders {
            let ix = Instruction {
                program_id: constants::PROGRAM_ID,
                accounts: accounts.clone(),
                data: InstructionData::data(&drift::instruction::ModifyOrderByUserId {
                    user_order_id: *user_order_id,
                    modify_order_params: params.clone(),
                }),
            };
            self.ixs.push(ix);
        }

        self
    }

    /// Add a place and make instruction (perp-only; spot variant removed upstream).
    ///
    /// * `order` - the order to place
    /// * `taker_info` - taker account address and data
    /// * `taker_order_id` - the id of the taker's order to match with
    /// * `referrer` - pubkey of the taker's referrer account, if any
    pub fn place_and_make(
        mut self,
        order: OrderParams,
        taker_info: &(Pubkey, User),
        taker_order_id: u32,
        referrer: Option<Pubkey>,
    ) -> Self {
        let (taker, taker_account) = taker_info;
        let is_perp = order.market_type == MarketType::Perp;
        let perp_writable = [MarketId::perp(order.market_index)];
        let spot_writable = [MarketId::spot(order.market_index), MarketId::QUOTE_SPOT];
        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::PlaceAndMake {
                state: *state_account(),
                authority: self.authority,
                user: self.sub_account,
                user_stats: Wallet::derive_stats_account(&self.owner()),
                taker: *taker,
                taker_stats: Wallet::derive_stats_account(&taker_account.authority),
            },
            [self.account_data.as_ref(), taker_account].into_iter(),
            self.force_markets.readable.iter(),
            if is_perp {
                perp_writable.iter()
            } else {
                spot_writable.iter()
            }
            .chain(self.force_markets.writeable.iter()),
        );

        // Upstream drift removed User.margin_mode; high-leverage mode now
        // comes exclusively from individual OrderParams flags.
        if order.high_leverage_mode() {
            accounts.push(AccountMeta::new(*high_leverage_mode_account(), false));
        }

        if let Some(referrer) = referrer {
            accounts.push(AccountMeta::new(
                Wallet::derive_stats_account(&referrer),
                false,
            ));
            accounts.push(AccountMeta::new(referrer, false));
        }

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::PlaceAndMakePerpOrder {
                params: order,
                taker_order_id,
            }),
        };

        self.ixs.push(ix);
        self
    }

    /// Add a place and take instruction (perp-only; spot variant removed upstream).
    ///
    /// * `order` - the order to place
    /// * `maker_info` - pubkey of the maker/counter-party(s) to take against and account data
    /// * `referrer` - pubkey of the maker's referrer account, if any
    pub fn place_and_take(
        mut self,
        order: OrderParams,
        maker_info: &[(Pubkey, User)],
        referrer: Option<Pubkey>,
        success_condition: Option<u32>,
    ) -> Self {
        let mut user_accounts = vec![self.account_data.as_ref()];

        for (_maker, maker_account) in maker_info {
            user_accounts.push(maker_account);
        }

        let is_perp = order.market_type == MarketType::Perp;
        let perp_writable = [MarketId::perp(order.market_index)];
        let spot_writable = [MarketId::spot(order.market_index), MarketId::QUOTE_SPOT];

        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::PlaceAndTake {
                state: *state_account(),
                authority: self.authority,
                user: self.sub_account,
                user_stats: Wallet::derive_stats_account(&self.owner()),
            },
            user_accounts.into_iter(),
            self.force_markets.readable.iter(),
            if is_perp {
                perp_writable.iter()
            } else {
                spot_writable.iter()
            }
            .chain(self.force_markets.writeable.iter()),
        );

        if is_perp && order.high_leverage_mode() {
            accounts.push(AccountMeta::new(*high_leverage_mode_account(), false));
        }

        // if referrer is maker don't add account again
        if referrer.is_some_and(|r| !maker_info.iter().any(|(m, _)| *m == r)) {
            let referrer = referrer.unwrap();
            accounts.push(AccountMeta::new(
                Wallet::derive_stats_account(&referrer),
                false,
            ));
            accounts.push(AccountMeta::new(referrer, false));
        }

        for (maker, maker_account) in maker_info {
            accounts.push(AccountMeta::new(*maker, false));
            accounts.push(AccountMeta::new(
                Wallet::derive_stats_account(&maker_account.authority),
                false,
            ));
        }

        let _ = is_perp;
        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::PlaceAndTakePerpOrder {
                params: order,
                success_condition,
            }),
        };

        self.ixs.push(ix);
        self
    }

    /// Place and try to fill (make) against the swift order (Perps only)
    ///
    /// * `maker_order` - order params defined by the maker, e.g. partial or full fill
    /// * `signed_order_info` - the signed swift order info (i.e from taker)
    /// * `taker_account` - taker account data
    /// * `taker_account_referrer` - taker account referrer key
    ///
    pub fn place_and_make_swift_order(
        mut self,
        maker_order: OrderParams,
        signed_order_info: &SignedOrderInfo,
        taker_account: &User,
        taker_account_referrer: &Pubkey,
    ) -> Self {
        let order_params = signed_order_info.order_params();
        assert!(
            order_params.market_type == MarketType::Perp,
            "only swift perps are supported"
        );
        self = self.place_swift_order(signed_order_info, taker_account);

        let perp_writable = [MarketId::perp(order_params.market_index)];
        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::PlaceAndMakeSignedMsg {
                state: *state_account(),
                authority: self.authority,
                user: self.sub_account,
                user_stats: Wallet::derive_stats_account(&self.owner()),
                taker: signed_order_info.taker_subaccount(),
                taker_stats: Wallet::derive_stats_account(&taker_account.authority),
                taker_signed_msg_user_orders: Wallet::derive_swift_order_account(
                    &taker_account.authority,
                ),
            },
            [self.account_data.as_ref(), taker_account].into_iter(),
            self.force_markets.readable.iter(),
            perp_writable
                .iter()
                .chain(self.force_markets.writeable.iter()),
        );

        if taker_account_referrer != &DEFAULT_PUBKEY {
            accounts.push(AccountMeta::new(*taker_account_referrer, false));
            accounts.push(AccountMeta::new(
                Wallet::derive_stats_account(taker_account_referrer),
                false,
            ));
        }

        if signed_order_info.has_builder() {
            accounts.push(AccountMeta::new(
                derive_revenue_share_escrow(&taker_account.authority),
                false,
            ));
        }

        self.ixs.push(Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::PlaceAndMakeSignedMsgPerpOrder {
                params: maker_order,
                signed_msg_order_uuid: signed_order_info.order_uuid(),
            }),
        });

        self
    }

    /// Place a swift order (Perps only)
    ///
    /// ☢️ this Ix will not fill by itself. The caller should add a subsequent Ix
    /// e.g. with JIT proxy, to atomically place and fill the order
    /// or see `place_and_make_swift_order`
    ///
    /// * `signed_order_info` - the signed swift order info
    /// * `taker_account` - taker subaccount data
    ///
    pub fn place_swift_order(
        mut self,
        signed_order_info: &SignedOrderInfo,
        taker_account: &User,
    ) -> Self {
        let order_params = signed_order_info.order_params();
        assert!(
            order_params.market_type == MarketType::Perp,
            "only swift perps are supported"
        );

        if signed_order_info.has_isolated_position_deposit() {
            self.force_include_markets(&[], &[MarketId::QUOTE_SPOT]);
        }

        let perp_readable = [MarketId::perp(order_params.market_index)];
        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::PlaceSignedMsgTakerOrder {
                state: *state_account(),
                authority: self.authority,
                user: signed_order_info.taker_subaccount(),
                user_stats: Wallet::derive_stats_account(&signed_order_info.taker_authority),
                signed_msg_user_orders: Wallet::derive_swift_order_account(
                    &signed_order_info.taker_authority,
                ),
                ix_sysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            },
            [taker_account].into_iter(),
            perp_readable
                .iter()
                .chain(self.force_markets.readable.iter()),
            self.force_markets.writeable.iter(),
        );

        // Upstream drift removed User.margin_mode; high-leverage mode now
        // comes exclusively from individual OrderParams flags.
        if order_params.high_leverage_mode() {
            accounts.push(AccountMeta::new(*high_leverage_mode_account(), false));
        }

        if signed_order_info.has_builder() {
            accounts.push(AccountMeta::new(
                derive_revenue_share_escrow(&signed_order_info.taker_authority),
                false,
            ));
        }

        let swift_taker_ix_data = signed_order_info.to_ix_data();
        let ed25519_verify_ix = crate::utils::new_ed25519_ix_ptr(
            swift_taker_ix_data.as_slice(),
            self.ixs.len() as u16 + 1,
            None,
        );

        let place_swift_ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::PlaceSignedMsgTakerOrder {
                signed_msg_order_params_message_bytes: swift_taker_ix_data,
                is_delegate_signer: signed_order_info.using_delegate_signing(),
            }),
        };

        self.ixs
            .extend_from_slice(&[ed25519_verify_ix, place_swift_ix]);
        self
    }

    /// Set the subaccount's _max_ initial margin ratio.
    ///
    /// * `sub_account_id` - index of the subaccount
    /// * `margin_ratio` - new margin ratio in MARGIN_PRECISION
    ///
    /// MARGIN_PRECISION => 1x leverage
    /// MARGIN_PRECISION * 10 => .1x leverage
    /// MARGIN_PRECISION / 10 =>  10x leverage
    ///
    pub fn set_max_initial_margin_ratio(mut self, margin_ratio: u32, sub_account_id: u16) -> Self {
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::UpdateUser {
                authority: self.authority,
                user: self.sub_account,
            },
            [self.account_data.as_ref()].into_iter(),
            std::iter::empty(),
            std::iter::empty(),
        );
        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::UpdateUserCustomMarginRatio {
                _sub_account_id: sub_account_id,
                margin_ratio,
            }),
        };
        self.ixs.push(ix);

        self
    }

    /// Add a spot `begin_swap` ix
    ///
    /// This should be followed by a subsequent `end_swap` ix
    pub fn begin_swap(
        mut self,
        amount_in: u64,
        in_market: &SpotMarket,
        out_market: &SpotMarket,
        payer_token_account: &Pubkey,
        payee_token_account: &Pubkey,
    ) -> Self {
        let in_token_program = in_market.token_program();
        let out_token_program = out_market.token_program();

        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::Swap {
                state: *state_account(),
                user: self.sub_account,
                user_stats: Wallet::derive_stats_account(&self.owner()),
                authority: self.authority,
                out_spot_market_vault: out_market.vault,
                in_spot_market_vault: in_market.vault,
                in_token_account: *payer_token_account,
                out_token_account: *payee_token_account,
                token_program: in_token_program,
                velocity_signer: self.program_data.state().signer,
                instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            },
            [self.account_data.as_ref()].into_iter(),
            [MarketId::QUOTE_SPOT].iter(),
            [
                MarketId::spot(in_market.market_index),
                MarketId::spot(out_market.market_index),
            ]
            .iter(),
        );

        if out_token_program != in_token_program {
            accounts.push(AccountMeta::new_readonly(out_token_program, false));
        }

        if out_market.is_token_2022_program() || in_market.is_token_2022_program() {
            accounts.push(AccountMeta::new_readonly(in_market.mint, false));
            accounts.push(AccountMeta::new_readonly(out_market.mint, false));
        }

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::BeginSwap {
                in_market_index: in_market.market_index,
                out_market_index: out_market.market_index,
                amount_in,
            }),
        };
        self.ixs.push(ix);

        self
    }

    /// Add a spot `end_swap` ix
    ///
    /// This should follow a preceding `begin_swap` ix
    pub fn end_swap(
        mut self,
        in_market: &SpotMarket,
        out_market: &SpotMarket,
        payer_token_account: &Pubkey,
        payee_token_account: &Pubkey,
        limit_price: Option<u64>,
        reduce_only: Option<SwapReduceOnly>,
    ) -> Self {
        let out_token_program = out_market.token_program();
        let in_token_program = in_market.token_program();

        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::Swap {
                state: *state_account(),
                user: self.sub_account,
                user_stats: Wallet::derive_stats_account(&self.owner()),
                authority: self.authority,
                out_spot_market_vault: out_market.vault,
                in_spot_market_vault: in_market.vault,
                in_token_account: *payer_token_account,
                out_token_account: *payee_token_account,
                token_program: in_token_program,
                velocity_signer: self.program_data.state().signer,
                instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            },
            [self.account_data.as_ref()].into_iter(),
            [MarketId::QUOTE_SPOT].iter(),
            [
                MarketId::spot(in_market.market_index),
                MarketId::spot(out_market.market_index),
            ]
            .iter(),
        );

        if out_token_program != in_token_program {
            accounts.push(AccountMeta::new_readonly(out_token_program, false));
        }

        if out_market.is_token_2022_program() || in_market.is_token_2022_program() {
            accounts.push(AccountMeta::new_readonly(in_market.mint, false));
            accounts.push(AccountMeta::new_readonly(out_market.mint, false));
        }

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::EndSwap {
                in_market_index: in_market.market_index,
                out_market_index: out_market.market_index,
                limit_price,
                reduce_only: reduce_only.map(|r| unsafe {
                    std::mem::transmute::<_, drift::instructions::SwapReduceOnly>(r)
                }),
            }),
        };
        self.ixs.push(ix);

        self
    }

    /// Helper function that creates token account creation instructions
    fn create_token_account_instructions(
        authority: &Pubkey,
        token_account: &Pubkey,
        mint: &Pubkey,
        token_program: &Pubkey,
    ) -> Instruction {
        Instruction {
            program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(*authority, true), // payer
                AccountMeta::new(*token_account, false),
                AccountMeta::new_readonly(*authority, false), // wallet
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                AccountMeta::new_readonly(*token_program, false),
            ],
            data: vec![1], // idempotent mode
        }
    }

    /// Prepares Jupiter swap instructions for insertion into a transaction
    ///
    /// This function handles common Jupiter-specific logic and returns a struct containing
    /// all the instructions that need to be inserted between begin and end wrapper instructions.
    ///
    /// # Arguments
    /// * `jupiter_swap_info` - Jupiter swap route and instructions
    /// * `in_market` - Spot market of the input token
    /// * `out_market` - Spot market of the output token
    /// * `in_token_account` - Input token account pubkey
    /// * `out_token_account` - Output token account pubkey
    pub fn build_jupiter_swap_ixs(
        authority: &Pubkey,
        jupiter_swap_info: JupiterSwapInfo,
        in_market: &SpotMarket,
        out_market: &SpotMarket,
        in_token_account: &Pubkey,
        out_token_account: &Pubkey,
    ) -> JupiterSwapInstructions {
        let jupiter_swap_ixs = jupiter_swap_info.ixs;

        // initialize token accounts
        let account_creation_instructions = if !jupiter_swap_ixs.setup_instructions.is_empty() {
            // jupiter swap ixs imply account creation is required
            // provide our own creation ixs
            vec![
                Self::create_token_account_instructions(
                    authority,
                    in_token_account,
                    &in_market.mint,
                    &in_market.token_program(),
                ),
                Self::create_token_account_instructions(
                    authority,
                    out_token_account,
                    &out_market.mint,
                    &out_market.token_program(),
                ),
            ]
        } else {
            Vec::new()
        };

        // TODO: support jito bundle
        if !jupiter_swap_ixs.other_instructions.is_empty() {
            panic!("jupiter swap unsupported ix: Jito tip");
        }

        // support SOL unwrap ixs, ignore account delete/reclaim ixs
        let cleanup_instruction = jupiter_swap_ixs.cleanup_instruction.filter(|ix| {
            ix.program_id != TOKEN_PROGRAM_ID && ix.program_id != TOKEN_2022_PROGRAM_ID
        });

        JupiterSwapInstructions {
            account_creation_instructions,
            in_amount: jupiter_swap_info.quote.in_amount,
            swap_instruction: jupiter_swap_ixs.swap_instruction,
            cleanup_instruction,
            luts: jupiter_swap_info.luts,
        }
    }

    /// Add a Jupiter token swap to the tx
    ///
    /// # Arguments
    /// * `jupiter_swap_info` - Jupiter swap route and instructions
    /// * `in_market` - Spot market of the input token
    /// * `out_market` - Spot market of the output token
    /// * `in_token_account` - Input token account pubkey
    /// * `out_token_account` - Output token account pubkey
    /// * `limit_price` - Set a limit price
    /// * `reduce_only` - Set a reduce only order
    pub fn jupiter_swap(
        mut self,
        jupiter_swap_info: JupiterSwapInfo,
        in_market: &SpotMarket,
        out_market: &SpotMarket,
        in_token_account: &Pubkey,
        out_token_account: &Pubkey,
        limit_price: Option<u64>,
        reduce_only: Option<SwapReduceOnly>,
    ) -> Self {
        let JupiterSwapInstructions {
            account_creation_instructions,
            in_amount,
            swap_instruction,
            cleanup_instruction,
            luts,
        } = Self::build_jupiter_swap_ixs(
            &self.authority,
            jupiter_swap_info,
            in_market,
            out_market,
            in_token_account,
            out_token_account,
        );
        self.ixs.extend(account_creation_instructions);

        self = self.begin_swap(
            in_amount,
            in_market,
            out_market,
            in_token_account,
            out_token_account,
        );
        self.ixs.push(swap_instruction);
        if let Some(cleanup_ix) = cleanup_instruction {
            self.ixs.push(cleanup_ix);
        }
        self = self.end_swap(
            in_market,
            out_market,
            in_token_account,
            out_token_account,
            limit_price,
            reduce_only,
        );
        self.lookup_tables(&luts)
    }

    /// Add a Jupiter token swap to the tx for liquidation
    ///
    /// This wraps the Jupiter swap with `liquidate_spot_with_swap_begin` and `liquidate_spot_with_swap_end`
    ///
    /// # Arguments
    /// * `jupiter_swap_info` - Jupiter swap route and instructions
    /// * `in_market` - Spot market of the input token (liability market)
    /// * `out_market` - Spot market of the output token (asset market)
    /// * `in_token_account` - Input token account pubkey (for account creation if needed)
    /// * `out_token_account` - Output token account pubkey (for account creation if needed)
    /// * `asset_market_index` - Market index of the asset (collateral)
    /// * `liability_market_index` - Market index of the liability (borrow)
    /// * `user_account` - The user account being liquidated
    pub fn jupiter_swap_liquidate(
        mut self,
        jupiter_swap_info: JupiterSwapInfo,
        in_market: &SpotMarket,
        out_market: &SpotMarket,
        in_token_account: &Pubkey,
        out_token_account: &Pubkey,
        asset_market_index: u16,
        liability_market_index: u16,
        user_account: &User,
    ) -> Self {
        let JupiterSwapInstructions {
            account_creation_instructions,
            in_amount,
            swap_instruction,
            cleanup_instruction,
            luts,
        } = Self::build_jupiter_swap_ixs(
            &self.authority,
            jupiter_swap_info,
            in_market,
            out_market,
            in_token_account,
            out_token_account,
        );
        self.ixs.extend(account_creation_instructions);
        self = self.liquidate_spot_with_swap_begin(
            asset_market_index,
            liability_market_index,
            in_amount,
            user_account,
        );
        self.ixs.push(swap_instruction);
        if let Some(cleanup_ix) = cleanup_instruction {
            self.ixs.push(cleanup_ix);
        }
        self = self.liquidate_spot_with_swap_end(
            asset_market_index,
            liability_market_index,
            user_account,
        );

        self.lookup_tables(&luts)
    }

    #[cfg(feature = "titan")]
    /// Prepares Titan swap instructions for insertion into a transaction
    ///
    /// This function handles common Titan-specific logic and returns a struct containing
    /// all the instructions that need to be inserted between begin and end wrapper instructions.
    ///
    /// # Arguments
    /// * `titan_swap_info` - Titan swap route and instructions
    /// * `in_market` - Spot market of the input token
    /// * `out_market` - Spot market of the output token
    /// * `in_token_account` - Input token account pubkey
    /// * `out_token_account` - Output token account pubkey
    pub fn build_titan_swap_ixs(
        authority: &Pubkey,
        titan_swap_info: TitanSwapInfo,
        in_market: &SpotMarket,
        out_market: &SpotMarket,
        in_token_account: &Pubkey,
        out_token_account: &Pubkey,
    ) -> TitanSwapInstructions {
        let swap_response = titan_swap_info.ixs;

        let account_creation_instructions = vec![
            Self::create_token_account_instructions(
                authority,
                in_token_account,
                &in_market.mint,
                &in_market.token_program(),
            ),
            Self::create_token_account_instructions(
                authority,
                out_token_account,
                &out_market.mint,
                &out_market.token_program(),
            ),
        ];

        let swap_instructions: Vec<Instruction> = swap_response
            .instructions
            .into_iter()
            .filter(|ix| {
                ix.program_id != TOKEN_PROGRAM_ID
                    && ix.program_id != TOKEN_2022_PROGRAM_ID
                    && ix.program_id != ASSOCIATED_TOKEN_PROGRAM_ID
                    && ix.program_id != DEFAULT_PUBKEY
            })
            .collect();

        TitanSwapInstructions {
            account_creation_instructions,
            in_amount: titan_swap_info.quote.in_amount,
            swap_instructions,
            luts: titan_swap_info.luts,
        }
    }

    #[cfg(feature = "titan")]
    /// Add a Titan token swap to the tx
    ///
    /// # Arguments
    /// * `titan_swap_info` - Titan swap route and instructions
    /// * `in_market` - Spot market of the input token
    /// * `out_market` - Spot market of the output token
    /// * `in_token_account` - Input token account pubkey
    /// * `out_token_account` - Output token account pubkey
    /// * `limit_price` - Set a limit price
    /// * `reduce_only` - Set a reduce only order
    pub fn titan_swap(
        mut self,
        titan_swap_info: TitanSwapInfo,
        in_market: &SpotMarket,
        out_market: &SpotMarket,
        in_token_account: &Pubkey,
        out_token_account: &Pubkey,
        limit_price: Option<u64>,
        reduce_only: Option<SwapReduceOnly>,
    ) -> Self {
        let TitanSwapInstructions {
            account_creation_instructions,
            in_amount,
            swap_instructions,
            luts,
        } = Self::build_titan_swap_ixs(
            &self.authority,
            titan_swap_info,
            in_market,
            out_market,
            in_token_account,
            out_token_account,
        );
        self.ixs.extend(account_creation_instructions);

        self = self.begin_swap(
            in_amount,
            in_market,
            out_market,
            in_token_account,
            out_token_account,
        );
        self.ixs.extend(swap_instructions);
        self = self.end_swap(
            in_market,
            out_market,
            in_token_account,
            out_token_account,
            limit_price,
            reduce_only,
        );
        self.lookup_tables(&luts)
    }

    #[cfg(feature = "titan")]
    /// Add a Titan token swap to the tx for liquidation
    ///
    /// This wraps the Titan swap with `liquidate_spot_with_swap_begin` and `liquidate_spot_with_swap_end`
    ///
    /// # Arguments
    /// * `titan_swap_info` - Titan swap route and instructions
    /// * `in_market` - Spot market of the input token (liability market)
    /// * `out_market` - Spot market of the output token (asset market)
    /// * `in_token_account` - Input token account pubkey (for account creation if needed)
    /// * `out_token_account` - Output token account pubkey (for account creation if needed)
    /// * `asset_market_index` - Market index of the asset (collateral)
    /// * `liability_market_index` - Market index of the liability (borrow)
    /// * `user_account` - The user account being liquidated
    pub fn titan_swap_liquidate(
        mut self,
        jupiter_swap_info: TitanSwapInfo,
        in_market: &SpotMarket,
        out_market: &SpotMarket,
        in_token_account: &Pubkey,
        out_token_account: &Pubkey,
        asset_market_index: u16,
        liability_market_index: u16,
        user_account: &User,
    ) -> Self {
        let TitanSwapInstructions {
            account_creation_instructions,
            in_amount,
            swap_instructions,
            luts,
        } = Self::build_titan_swap_ixs(
            &self.authority,
            jupiter_swap_info,
            in_market,
            out_market,
            in_token_account,
            out_token_account,
        );
        self.ixs.extend(account_creation_instructions);
        self = self.liquidate_spot_with_swap_begin(
            asset_market_index,
            liability_market_index,
            in_amount,
            user_account,
        );
        self.ixs.extend(swap_instructions);
        self = self.liquidate_spot_with_swap_end(
            asset_market_index,
            liability_market_index,
            user_account,
        );

        self.lookup_tables(&luts)
    }

    /// Settle perp PnL for some user account and market
    ///
    /// * `market_index` market to settle position for
    /// * `target_pubkey` target subaccount address, leave None to settle PnL for the signer
    /// * `target_account` target subaccount data, leave None to settle PnL for the signer
    ///
    pub fn settle_pnl(
        mut self,
        market_index: u16,
        target_pubkey: Option<&Pubkey>,
        target_account: Option<&User>,
    ) -> Self {
        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::SettlePNL {
                state: *state_account(),
                user: target_pubkey.copied().unwrap_or(self.sub_account),
                authority: self.authority,
                spot_market_vault: self
                    .program_data
                    .spot_market_config_by_index(MarketId::QUOTE_SPOT.index())
                    .unwrap()
                    .vault,
            },
            [target_account.unwrap_or(&self.account_data)].into_iter(),
            std::iter::empty(),
            [MarketId::QUOTE_SPOT, MarketId::perp(market_index)].iter(),
        );

        let target_user = target_account.unwrap_or(&self.account_data);
        if target_user.orders.iter().any(|o| o.has_builder()) {
            accounts.push(AccountMeta::new(
                derive_revenue_share_escrow(&target_user.authority),
                false,
            ));
        }

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::SettlePnl { market_index }),
        };

        self.ixs.push(ix);

        self
    }

    /// Settle perp multiple PnLs for user account and markets
    ///
    /// * `markets` market indexes to settle positions for
    /// * `mode` Choose Must or try settle PnL
    /// * `target_pubkey` target subaccount address, leave None to settle PnL for the signer
    /// * `target_account` target subaccount data, leave None to settle PnL for the signer
    ///
    pub fn settle_pnl_multi(
        mut self,
        markets: &[u16],
        mode: SettlePnlMode,
        target_pubkey: Option<&Pubkey>,
        target_account: Option<&User>,
    ) -> Self {
        let perp_iter: Vec<MarketId> = markets.iter().map(|i| MarketId::perp(*i)).collect();
        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::SettlePNL {
                state: *state_account(),
                user: target_pubkey.copied().unwrap_or(self.sub_account),
                authority: self.authority,
                spot_market_vault: self
                    .program_data
                    .spot_market_config_by_index(MarketId::QUOTE_SPOT.index())
                    .unwrap()
                    .vault,
            },
            [target_account.unwrap_or(&self.account_data)].into_iter(),
            std::iter::empty(),
            perp_iter
                .iter()
                .chain(std::iter::once(&MarketId::QUOTE_SPOT)),
        );

        let target_user = target_account.unwrap_or(&self.account_data);
        if target_user.orders.iter().any(|o| o.has_builder()) {
            accounts.push(AccountMeta::new(
                derive_revenue_share_escrow(&target_user.authority),
                false,
            ));
        }

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::SettleMultiplePnls {
                market_indexes: markets.to_vec(),
                mode,
            }),
        };

        self.ixs.push(ix);

        self
    }

    /// Fill a perpetual order by matching it against maker orders
    ///
    /// This instruction allows a filler to execute a taker's order by matching it against
    /// existing maker orders in the order book. The filler receives a fee for providing
    /// liquidity and executing the trade.
    ///
    /// * `market_index` - the perpetual market index to fill orders on
    /// * `taker` - the taker's subaccount pubkey
    /// * `taker_account` - the taker's user account data
    /// * `taker_stats` - the taker's user stats account data
    /// * `taker_order_id` - optional order ID to fill, if None fills the best available order
    /// * `makers` - list of maker user accounts that will provide liquidity
    /// * `has_builder` - if true include RevenueShareEscrow account for the taker, otherwise
    ///   try to infer from the taker's orders. This exists because the caller may have additional
    ///   information about the builder status of the order, such as from decoding the Swift message.
    ///   Worst case it will include the RevenueShareEscrow account optimistically.
    pub fn fill_perp_order(
        mut self,
        market_index: u16,
        taker: Pubkey,
        taker_account: &User,
        taker_stats: &UserStats,
        taker_order_id: Option<u32>,
        makers: &[User],
        has_builder: Option<bool>,
    ) -> Self {
        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::FillOrder {
                state: *state_account(),
                authority: self.authority,
                user: taker,
                user_stats: Wallet::derive_stats_account(&taker_account.authority),
                filler: self.sub_account,
                filler_stats: Wallet::derive_stats_account(&self.owner()),
            },
            makers.iter().chain(std::iter::once(taker_account)),
            std::iter::empty(),
            std::iter::once(&MarketId::perp(market_index)),
        );

        for maker in makers {
            accounts.extend([
                AccountMeta::new(
                    Wallet::derive_user_account(&maker.authority, maker.sub_account_id),
                    false,
                ),
                AccountMeta::new(Wallet::derive_stats_account(&maker.authority), false),
            ]);
        }

        if taker_stats.is_referred() {
            accounts.extend([
                AccountMeta::new(Wallet::derive_user_account(&taker_stats.referrer, 0), false),
                AccountMeta::new(Wallet::derive_stats_account(&taker_stats.referrer), false),
            ]);
        }

        let add_revenue_share_escrow = if let Some(has) = has_builder {
            has
        } else if let Some(order_id) = taker_order_id {
            taker_account
                .orders
                .iter()
                .find(|o| o.order_id == order_id)
                .is_none_or(|o| o.has_builder())
        } else {
            // no taker_order_id, should be a swift order, include the revenue share escrow optimistically
            true
        };
        if add_revenue_share_escrow {
            accounts.push(AccountMeta::new(
                derive_revenue_share_escrow(&taker_account.authority),
                false,
            ))
        }

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::FillPerpOrder {
                order_id: taker_order_id,
                _maker_order_id: None,
            }),
        };

        self.ixs.push(ix);
        self
    }

    /// Trigger a conditional order (stop loss, take profit, etc.)
    ///
    /// This instruction allows a filler to trigger a conditional order when the specified
    /// market conditions are met. Conditional orders include stop losses, take profits,
    /// and other trigger-based order types.
    ///
    /// * `user` - the user's subaccount pubkey that owns the conditional order
    /// * `user_account` - the user's account data containing the conditional order
    /// * `order_id` - the ID of the conditional order to trigger
    /// * `market` - tuple of (market_index, market_type) for the market the order is on
    pub fn trigger_order(
        mut self,
        user: Pubkey,
        user_account: &User,
        order_id: u32,
        market: (u16, MarketType),
    ) -> Self {
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::TriggerOrder {
                state: *state_account(),
                authority: self.authority,
                user,
                filler: self.sub_account,
            },
            std::iter::once(user_account),
            std::iter::empty(),
            std::iter::once(&MarketId::from(market)),
        );

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::TriggerOrder { order_id }),
        };

        self.ixs.push(ix);

        self
    }

    /// Initialize a Swift (signed message) order account for the authority/wallet.
    ///
    /// Prepares the account for off-chain signed order flow.
    pub fn initialize_swift_account(mut self) -> Self {
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::InitializeSignedMsgUserOrders {
                signed_msg_user_orders: Wallet::derive_swift_order_account(&self.authority),
                authority: self.authority,
                payer: self.authority,
                rent: SYSVAR_RENT_PUBKEY,
                system_program: SYSTEM_PROGRAM_ID,
            },
            std::iter::empty(),
            std::iter::empty(),
            std::iter::empty(),
        );

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::InitializeSignedMsgUserOrders {
                num_orders: 16,
            }),
        };
        self.ixs.push(ix);

        self
    }

    /// Initialize a new user account (subaccount) for the authority/wallet.
    ///
    /// Optionally set a custom name and referrer.
    /// For `sub_account_id = 0`, also initializes the user stats account.
    ///
    /// # Parameters
    /// - `sub_account_id`: The subaccount index to initialize (0 for main account).
    /// - `name`: Optional custom name for the account. If `None`, a default name is used.
    /// - `referrer`: Optional referrer pubkey for the account.
    ///
    /// # Example
    /// ```
    /// use drift_rs::{TransactionBuilder, Wallet};
    /// use solana_pubkey::Pubkey;
    ///
    /// let wallet = Wallet::new_random();
    /// let program_data = /* obtain ProgramData */;
    /// let sub_account_id = 0;
    /// let mut builder = TransactionBuilder::new(&program_data, wallet.default_sub_account(), /* user data */, false);
    ///
    /// // Initialize the user account and the swift account, then deposit 100_000 USDC (spot market 0)
    /// builder = builder
    ///     .initialize_user_account(sub_account_id, None, None)
    ///     .initialize_swift_account()
    ///     .deposit(100_000, 0, None);
    /// ```
    pub fn initialize_user_account(
        mut self,
        sub_account_id: u16,
        name: Option<String>,
        referrer: Option<Pubkey>,
    ) -> Self {
        if sub_account_id == 0 {
            let ix = Instruction {
                program_id: constants::PROGRAM_ID,
                accounts: drift::accounts::InitializeUserStats {
                    state: *state_account(),
                    authority: self.authority,
                    user_stats: Wallet::derive_stats_account(&self.owner()),
                    payer: self.authority,
                    rent: SYSVAR_RENT_PUBKEY,
                    system_program: SYSTEM_PROGRAM_ID,
                }
                .to_account_metas(None),
                data: InstructionData::data(&drift::instruction::InitializeUserStats {}),
            };
            self.ixs.push(ix);
        }

        let mut accounts = drift::accounts::InitializeUser {
            state: *state_account(),
            authority: self.authority,
            user: Wallet::derive_user_account(&self.authority, sub_account_id),
            user_stats: Wallet::derive_stats_account(&self.owner()),
            payer: self.authority,
            rent: SYSVAR_RENT_PUBKEY,
            system_program: SYSTEM_PROGRAM_ID,
        }
        .to_account_metas(None);
        if let Some(referrer) = referrer {
            accounts.extend_from_slice(&[
                AccountMeta::new(Wallet::derive_user_account(&referrer, 0), false),
                AccountMeta::new(Wallet::derive_stats_account(&referrer), false),
            ]);
        }

        let name = name.unwrap_or_else(|| {
            if sub_account_id == 0 {
                "Main Account".into()
            } else {
                format!("Subaccount {}", sub_account_id + 1)
            }
        });
        let name_padded = format!("{:<32}", name);

        let ix = Instruction {
            program_id: constants::PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::InitializeUser {
                sub_account_id,
                name: name_padded.as_bytes()[..32].try_into().unwrap(),
            }),
        };

        self.ixs.push(ix);

        self
    }

    /// Liquidate a spot position for a given user account.
    ///
    /// The liquidator will be the subaccount associated with this `TransactionBuilder` (i.e., the builder's default subaccount).
    ///
    /// # Parameters
    /// - `asset_market_index`: The index of the spot market to use as collateral.
    /// - `liability_market_index`: The market index of liquidatee position.
    /// - `user_account`: the user account to liquidate (liquidatee)
    /// - `liquidator_max_liability_transfer`: The maximum base asset amount the liquidator is willing to liquidate.
    /// - `limit_price`: Optional limit price for the liquidation (if `None`, no limit is set).
    ///
    /// # Returns
    /// Returns an updated `TransactionBuilder` with the liquidation instruction appended.
    pub fn liquidate_spot(
        mut self,
        asset_market_index: u16,
        liability_market_index: u16,
        user_account: &User,
        liquidator_max_liability_transfer: u128,
        limit_price: Option<u64>,
    ) -> Self {
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::LiquidateSpot {
                state: *state_account(),
                authority: self.authority,
                user: Wallet::derive_user_account(
                    &user_account.authority,
                    user_account.sub_account_id,
                ),
                liquidator: self.sub_account,
            },
            [&self.account_data, user_account].into_iter(),
            std::iter::empty(),
            [
                MarketId::spot(asset_market_index),
                MarketId::spot(liability_market_index),
            ]
            .iter(),
        );

        let liquidate_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::LiquidateSpot {
                asset_market_index,
                liability_market_index,
                liquidator_max_liability_transfer,
                limit_price,
            }),
        };

        self.ixs.push(liquidate_ix);
        self
    }

    /// Liquidate a spot position using an external swap (begin phase)
    ///
    /// This is the first step of a two phase liquidation that involves swapping collateral.
    /// Must be followed by an external swap instruction and then liquidate_spot_with_swap_end.
    ///
    /// # Parameters
    /// - `asset_market_index`: The spot market index of the asset (collateral)
    /// - `liability_market_index`: The spot market index of the liability (borrow)
    /// - `swap_amount`: The amount to swap
    /// - `user_account`: The user account being liquidated
    ///
    /// # Returns
    /// Returns the updated `TransactionBuilder` with the instruction appended.
    pub fn liquidate_spot_with_swap_begin(
        mut self,
        asset_market_index: u16,
        liability_market_index: u16,
        swap_amount: u64,
        user_account: &User,
    ) -> Self {
        let asset_spot_market = self
            .program_data
            .spot_market_config_by_index(asset_market_index)
            .expect("asset spot market exists");
        let liability_spot_market = self
            .program_data
            .spot_market_config_by_index(liability_market_index)
            .expect("liability spot market exists");

        let accounts = build_accounts(
            self.program_data,
            drift::accounts::LiquidateSpotWithSwap {
                state: *state_account(),
                authority: self.authority,
                liquidator: self.sub_account,
                user: Wallet::derive_user_account(
                    &user_account.authority,
                    user_account.sub_account_id,
                ),
                liability_spot_market_vault: liability_spot_market.vault,
                asset_spot_market_vault: asset_spot_market.vault,
                liability_token_account: Wallet::derive_associated_token_address(
                    &self.authority,
                    liability_spot_market,
                ),
                asset_token_account: Wallet::derive_associated_token_address(
                    &self.authority,
                    asset_spot_market,
                ),
                token_program: liability_spot_market.token_program(),
                velocity_signer: constants::derive_drift_signer(),
                instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            },
            [&self.account_data, user_account].into_iter(),
            std::iter::empty(),
            [
                MarketId::spot(asset_market_index),
                MarketId::spot(liability_market_index),
            ]
            .iter(),
        );

        let liquidate_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::LiquidateSpotWithSwapBegin {
                asset_market_index,
                liability_market_index,
                swap_amount,
            }),
        };

        self.ixs.push(liquidate_ix);
        self
    }

    /// Liquidate a spot position using an external swap (end phase)
    ///
    /// This completes the liquidation after the external swap has been executed.
    /// Must be preceded by liquidate_spot_with_swap_begin and an external swap instruction.
    ///
    ///
    /// # Parameters
    /// - `asset_market_index`: The spot market index of the asset (collateral)
    /// - `liability_market_index`: The spot market index of the liability (borrow)
    /// - `user_account`: The user account being liquidated
    ///
    /// # Returns
    /// Returns the updated `TransactionBuilder` with the instruction appended.
    pub fn liquidate_spot_with_swap_end(
        mut self,
        asset_market_index: u16,
        liability_market_index: u16,
        user_account: &User,
    ) -> Self {
        let asset_spot_market = self
            .program_data
            .spot_market_config_by_index(asset_market_index)
            .expect("asset spot market exists");
        let liability_spot_market = self
            .program_data
            .spot_market_config_by_index(liability_market_index)
            .expect("liability spot market exists");

        let accounts = build_accounts(
            self.program_data,
            drift::accounts::LiquidateSpotWithSwap {
                state: *state_account(),
                authority: self.authority,
                liquidator: self.sub_account,
                user: Wallet::derive_user_account(
                    &user_account.authority,
                    user_account.sub_account_id,
                ),
                liability_spot_market_vault: liability_spot_market.vault,
                asset_spot_market_vault: asset_spot_market.vault,
                liability_token_account: Wallet::derive_associated_token_address(
                    &self.authority,
                    liability_spot_market,
                ),
                asset_token_account: Wallet::derive_associated_token_address(
                    &self.authority,
                    asset_spot_market,
                ),
                token_program: liability_spot_market.token_program(),
                velocity_signer: constants::derive_drift_signer(),
                instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            },
            [&self.account_data, user_account].into_iter(),
            std::iter::empty(),
            [
                MarketId::spot(asset_market_index),
                MarketId::spot(liability_market_index),
            ]
            .iter(),
        );

        let liquidate_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::LiquidateSpotWithSwapEnd {
                asset_market_index,
                liability_market_index,
            }),
        };

        self.ixs.push(liquidate_ix);
        self
    }

    /// Liquidate a perp position for a given user.
    ///
    /// This method constructs a liquidation instruction for a perpetual market position.
    /// The liquidator will be the subaccount associated with this `TransactionBuilder` (i.e., the builder's default subaccount).
    ///
    /// # Parameters
    /// - `market_index`: The index of the perp market to liquidate on.
    /// - `user_account`: The user account (liquidatee) whose position will be liquidated.
    /// - `liquidator_max_base_asset_amount`: The maximum base asset amount the liquidator is willing to liquidate.
    /// - `limit_price`: Optional limit price for the liquidation (if `None`, no limit is set).
    ///
    /// # Returns
    /// Returns an updated `TransactionBuilder` with the liquidation instruction appended.
    pub fn liquidate_perp(
        mut self,
        market_index: u16,
        user_account: &User,
        liquidator_max_base_asset_amount: u64,
        limit_price: Option<u64>,
    ) -> Self {
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::LiquidatePerp {
                state: *state_account(),
                authority: self.authority,
                user: Wallet::derive_user_account(
                    &user_account.authority,
                    user_account.sub_account_id,
                ),
                user_stats: Wallet::derive_stats_account(&user_account.authority),
                liquidator: self.sub_account,
                liquidator_stats: Wallet::derive_stats_account(&self.owner()),
            },
            [&self.account_data, user_account].into_iter(),
            std::iter::empty(),
            std::iter::once(&MarketId::perp(market_index)),
        );

        let liquidate_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::LiquidatePerp {
                market_index,
                liquidator_max_base_asset_amount,
                limit_price,
            }),
        };

        self.ixs.push(liquidate_ix);
        self
    }

    /// Liquidate a perp position with fill for a given user.
    ///
    /// This method constructs a liquidation instruction for a perpetual market position that includes
    /// maker orders to fill the liquidated position. The liquidator will be the subaccount associated
    /// with this `TransactionBuilder` (i.e., the builder's default subaccount).
    ///
    /// # Parameters
    /// - `market_index`: The index of the perp market to liquidate on.
    /// - `liquidatee`: The user account (liquidatee) whose position will be liquidated.
    /// - `makers`: Array of maker users whose orders will be used to fill the liquidated position.
    ///
    /// # Returns
    /// Returns an updated `TransactionBuilder` with the liquidation instruction appended.
    pub fn liquidate_perp_with_fill(
        mut self,
        market_index: u16,
        liquidatee: &User,
        makers: &[User],
    ) -> Self {
        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::LiquidatePerp {
                state: *state_account(),
                authority: self.authority,
                user: Wallet::derive_user_account(&liquidatee.authority, liquidatee.sub_account_id),
                user_stats: Wallet::derive_stats_account(&liquidatee.authority),
                liquidator: self.sub_account,
                liquidator_stats: Wallet::derive_stats_account(&self.owner()),
            },
            [&self.account_data, liquidatee].into_iter().chain(makers),
            std::iter::empty(),
            std::iter::once(&MarketId::perp(market_index)),
        );

        for maker in makers {
            accounts.extend([
                AccountMeta::new(
                    Wallet::derive_user_account(&maker.authority, maker.sub_account_id),
                    false,
                ),
                AccountMeta::new(Wallet::derive_stats_account(&maker.authority), false),
            ]);
        }

        let liquidate_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::LiquidatePerpWithFill {
                market_index,
            }),
        };

        self.ixs.push(liquidate_ix);
        self
    }

    /// Liquidate a perp pnl using deposit for a given user.
    ///
    /// This method constructs a liquidation instruction for a perpetual market position's pnl.
    /// The liquidator will be the subaccount associated with this `TransactionBuilder` (i.e., the builder's default subaccount).
    ///
    /// # Parameters
    /// - `liquidatee`: The user account (liquidatee) whose position will be liquidated.
    /// - `perp_market_index`: The index of the perp market to liquidate on.
    /// - `spot_market_index`: The index of the spot market to be used as liability.
    /// - `liquidator_max_pnl_transfer`: The maximum pnl amount the liquidator is willing to liquidate.
    /// - `limit_price`: Optional limit price for the liquidation (if `None`, no limit is set).
    ///
    /// # Returns
    /// Returns an updated `TransactionBuilder` with the liquidation instruction appended.
    pub fn liquidate_perp_pnl_for_deposit(
        mut self,
        liquidatee: &User,
        perp_market_index: u16,
        spot_market_index: u16,
        liquidator_max_pnl_transfer: u128,
        limit_price: Option<u64>,
    ) -> Self {
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::LiquidatePerpPnlForDeposit {
                state: *state_account(),
                authority: self.authority,
                liquidator: self.sub_account,
                liquidator_stats: Wallet::derive_stats_account(&self.owner()),
                user: Wallet::derive_user_account(&liquidatee.authority, liquidatee.sub_account_id),
                user_stats: Wallet::derive_stats_account(&liquidatee.authority),
            },
            [&self.account_data, liquidatee].into_iter(),
            std::iter::empty(),
            [
                MarketId::perp(perp_market_index),
                MarketId::spot(spot_market_index),
            ]
            .iter(),
        );

        let liquidate_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::LiquidatePerpPnlForDeposit {
                perp_market_index,
                spot_market_index,
                liquidator_max_pnl_transfer,
                limit_price,
            }),
        };

        self.ixs.push(liquidate_ix);
        self
    }

    /// Liquidate borrows using perp pnl for a given user.
    ///
    /// This method constructs a liquidation instruction for a borrow position's pnl.
    /// The liquidator will be the subaccount associated with this `TransactionBuilder` (i.e., the builder's default subaccount).
    ///
    /// # Parameters
    /// - `liquidatee`: The user account (liquidatee) whose position will be liquidated.
    /// - `perp_market_index`: The index of the perp market to liquidate on.
    /// - `spot_market_index`: The index of the spot market to be used as liability.
    /// - `liquidator_max_liability_transfer`: The maximum transfer amount the liquidator is willing to liquidate.
    /// - `limit_price`: Optional limit price for the liquidation (if `None`, no limit is set).
    ///
    /// # Returns
    /// Returns an updated `TransactionBuilder` with the liquidation instruction appended.
    pub fn liquidate_borrow_for_perp_pnl(
        mut self,
        liquidatee: &User,
        perp_market_index: u16,
        spot_market_index: u16,
        liquidator_max_liability_transfer: u128,
        limit_price: Option<u64>,
    ) -> Self {
        let accounts = build_accounts(
            self.program_data,
            drift::accounts::LiquidateBorrowForPerpPnl {
                state: *state_account(),
                authority: self.authority,
                liquidator: self.sub_account,
                liquidator_stats: Wallet::derive_stats_account(&self.owner()),
                user: Wallet::derive_user_account(&liquidatee.authority, liquidatee.sub_account_id),
                user_stats: Wallet::derive_stats_account(&liquidatee.authority),
            },
            [&self.account_data, liquidatee].into_iter(),
            std::iter::empty(),
            [
                MarketId::perp(perp_market_index),
                MarketId::spot(spot_market_index),
            ]
            .iter(),
        );

        let liquidate_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::LiquidateBorrowForPerpPnl {
                perp_market_index,
                spot_market_index,
                liquidator_max_liability_transfer,
                limit_price,
            }),
        };

        self.ixs.push(liquidate_ix);
        self
    }

    /// Post a Pyth Lazer oracle update
    ///
    /// Appends an Ed25519 signature verify ix and Pyth Lazer oracle update ix to the transaction.
    ///
    /// # Parameters
    ///
    /// - `feed_ids`: Pyth Lazer feed IDs for which the oracle update should be posted.
    /// - `pyth_message`: the Pyth message update
    ///
    /// # Returns
    ///
    /// Returns the updated `TransactionBuilder` with the new instructions appended.
    pub fn post_pyth_lazer_oracle_update(mut self, feed_ids: &[u32], pyth_message: &[u8]) -> Self {
        let ed25519_verify_ix =
            crate::utils::new_ed25519_ix_ptr(pyth_message, self.ixs.len() as u16 + 1, Some(4));

        let mut accounts = build_accounts(
            self.program_data,
            drift::accounts::UpdatePythLazerOracle {
                keeper: self.authority,
                pyth_lazer_storage: PYTH_LAZER_STORAGE_ACCOUNT_KEY,
                ix_sysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            },
            std::iter::empty(),
            std::iter::empty(),
            std::iter::empty(),
        );
        accounts.extend(feed_ids.iter().map(|f| {
            AccountMeta::new(crate::utils::derive_pyth_lazer_oracle_public_key(*f), false)
        }));

        let pyth_update_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: InstructionData::data(&drift::instruction::PostPythLazerOracleUpdate {
                pyth_message: pyth_message.to_vec(),
            }),
        };

        self.ixs
            .extend_from_slice(&[ed25519_verify_ix, pyth_update_ix]);

        self
    }

    /// Build the transaction message ready for signing and sending
    pub fn build(self) -> VersionedMessage {
        let payer = self.fee_payer.unwrap_or(self.authority);
        if self.legacy {
            let message = Message::new(self.ixs.as_ref(), Some(&payer));
            VersionedMessage::Legacy(message)
        } else {
            let message = v0::Message::try_compile(
                &payer,
                self.ixs.as_slice(),
                self.lookup_tables.as_slice(),
                Default::default(),
            )
            .expect("ok");
            VersionedMessage::V0(message)
        }
    }

    pub fn program_data(&self) -> &ProgramData {
        self.program_data
    }

    pub fn account_data(&self) -> &Cow<'_, User> {
        &self.account_data
    }

    /// Update user position margin ratio
    ///
    /// ## Params
    /// * `market_index` - perp market index of the position
    /// * `margin_ratio` - new margin ratio for the position
    ///
    pub fn update_user_perp_position_custom_margin_ratio(
        mut self,
        market_index: u16,
        margin_ratio: u16,
    ) -> Self {
        let accounts = build_accounts(
            self.program_data(),
            drift::accounts::UpdateUserPerpPositionCustomMarginRatio {
                user: self.sub_account,
                authority: self.owner(),
            },
            std::iter::empty(),
            std::iter::empty(),
            std::iter::empty(),
        );
        self.ixs.push(Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: InstructionData::data(
                &drift::instruction::UpdateUserPerpPositionCustomMarginRatio {
                    _sub_account_id: self.account_data.sub_account_id,
                    perp_market_index: market_index,
                    margin_ratio,
                },
            ),
        });
        self
    }
}

/// Builds a set of required accounts from a user's open positions and additional given accounts
///
/// * `base_accounts` - base anchor accounts
/// * `users` - Drift user account data
/// * `markets_readable` - IDs of markets to include as readable
/// * `markets_writable` - IDs of markets to include as writable (takes priority over readable)
///
/// # Panics
///  if the user has positions in an unknown market (i.e unsupported by the SDK)
pub fn build_accounts<'a>(
    program_data: &ProgramData,
    base_accounts: impl anchor_lang::ToAccountMetas,
    users: impl Iterator<Item = &'a User>,
    markets_readable: impl Iterator<Item = &'a MarketId>,
    markets_writable: impl Iterator<Item = &'a MarketId>,
) -> Vec<AccountMeta> {
    // the order of accounts returned must be instruction, oracles, spot, perps see (https://github.com/drift-labs/protocol-v2/blob/master/programs/drift/src/instructions/optional_accounts.rs#L28)
    let mut accounts = BTreeSet::<RemainingAccount>::new();

    // add accounts to the ordered list
    let mut include_market =
        |market_index: u16, market_type: MarketType, writable: bool| match market_type {
            MarketType::Spot => {
                let SpotMarket { pubkey, oracle, .. } = program_data
                    .spot_market_config_by_index(market_index)
                    .expect("exists");
                accounts.extend(
                    [
                        RemainingAccount::Spot {
                            pubkey: *pubkey,
                            writable,
                        },
                        RemainingAccount::Oracle { pubkey: *oracle },
                    ]
                    .iter(),
                )
            }
            MarketType::Perp => {
                let PerpMarket { pubkey, oracle, .. } = program_data
                    .perp_market_config_by_index(market_index)
                    .expect("exists");
                accounts.extend(
                    [
                        RemainingAccount::Perp {
                            pubkey: *pubkey,
                            writable,
                        },
                        RemainingAccount::Oracle { pubkey: *oracle },
                    ]
                    .iter(),
                )
            }
        };

    for market in markets_writable {
        include_market(market.index(), market.kind(), true);
    }

    for market in markets_readable {
        include_market(market.index(), market.kind(), false);
    }

    for user in users {
        // Drift program performs margin checks which requires reading user positions
        for p in user.spot_positions.iter().filter(|p| !p.is_available()) {
            include_market(p.market_index, MarketType::Spot, false);
        }
        for p in user.perp_positions.iter().filter(|p| !p.is_available()) {
            include_market(p.market_index, MarketType::Perp, false);
        }
        // always manually try to include the quote (USDC) market
        // TODO: this is not exactly the same semantics as the TS sdk
        include_market(MarketId::QUOTE_SPOT.index(), MarketType::Spot, false);
    }

    let mut account_metas = base_accounts.to_account_metas(None);
    account_metas.extend(accounts.into_iter().map(Into::into));
    account_metas
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use crate::solana_sdk::keypair::Keypair;
    use anchor_lang::prelude::system_instruction;
    use drift::state::perp_market::PerpMarket;
    use serde_json::json;
    use solana_account_decoder_client_types::{UiAccount, UiAccountData, UiAccountEncoding};
    use solana_rpc_client::rpc_client::Mocks;
    use solana_rpc_client_api::{
        request::RpcRequest,
        response::{Response, RpcResponseContext},
    };

    use super::*;

    const DEVNET_ENDPOINT: &str = "https://api.devnet.solana.com";

    /// Init a new `DriftClient` with provided mocked RPC responses
    async fn setup(rpc_mocks: Mocks, keypair: Keypair) -> DriftClient {
        let rpc_client = Arc::new(RpcClient::new_mock_with_mocks(
            DEVNET_ENDPOINT.to_string(),
            rpc_mocks,
        ));

        let pubsub_client = Arc::new(
            PubsubClient::new(&get_ws_url(DEVNET_ENDPOINT).unwrap())
                .await
                .expect("ws connects"),
        );

        let perp_market_map =
            MarketMap::<PerpMarket>::new(Arc::clone(&pubsub_client), rpc_client.commitment());
        let spot_market_map =
            MarketMap::<SpotMarket>::new(Arc::clone(&pubsub_client), rpc_client.commitment());

        let backend = DriftClientBackend {
            rpc_client: Arc::clone(&rpc_client),
            pubsub_client: Arc::clone(&pubsub_client),
            program_data: ProgramData::uninitialized(),
            perp_market_map,
            spot_market_map,
            oracle_map: OracleMap::new(Arc::clone(&pubsub_client), &[], rpc_client.commitment()),
            blockhash_subscriber: BlockhashSubscriber::new(
                Duration::from_secs(2),
                Arc::clone(&rpc_client),
            ),
            account_map: AccountMap::new(
                Arc::clone(&pubsub_client),
                Arc::clone(&rpc_client),
                CommitmentConfig::processed(),
            ),
            grpc_unsub: Default::default(),
        };

        DriftClient {
            context: Context::DevNet,
            backend: Box::leak(Box::new(backend)),
            wallet: Wallet::new(keypair),
        }
    }

    #[tokio::test]
    async fn test_backend_send_sync() {
        let account_mocks = Mocks::default();
        let client = setup(account_mocks, Keypair::new()).await;

        tokio::task::spawn(async move {
            let _ = client.clone();
        });
    }

    #[tokio::test]
    #[cfg(feature = "rpc_tests")]
    async fn test_marketmap_subscribe() {
        use utils::test_envs::mainnet_endpoint;

        let client = DriftClient::new(
            Context::MainNet,
            RpcAccountProvider::new(&mainnet_endpoint()),
            Keypair::new().into(),
        )
        .await
        .unwrap();

        let _ = client.subscribe().await;

        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;

        for _ in 0..20 {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            let perp_market = client.get_perp_market_account_and_slot(0);
            let slot = perp_market.unwrap().slot;
            dbg!(slot);
        }

        for _ in 0..20 {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            let spot_market = client.get_spot_market_account_and_slot(0);
            let slot = spot_market.unwrap().slot;
            dbg!(slot);
        }
    }

    // Build an on-chain wire representation of `user` (8-byte discriminator + Pod bytes).
    fn encode_user_account(user: &User) -> Vec<u8> {
        use anchor_lang::Discriminator;
        let mut bytes = Vec::with_capacity(8 + std::mem::size_of::<User>());
        bytes.extend_from_slice(<User as Discriminator>::DISCRIMINATOR);
        bytes.extend_from_slice(bytemuck::bytes_of(user));
        bytes
    }

    fn account_info_response(owner: &Pubkey, data: Vec<u8>) -> serde_json::Value {
        json!(Response {
            context: RpcResponseContext::new(12_345),
            value: Some(UiAccount {
                data: UiAccountData::Binary(
                    bs58::encode(data).into_string(),
                    UiAccountEncoding::Base58
                ),
                owner: owner.to_string(),
                executable: false,
                lamports: 0,
                rent_epoch: 0,
                space: None,
            })
        })
    }

    #[tokio::test]
    async fn get_orders() {
        let user_pda = Pubkey::from_str("9JtczxrJjPM4J1xooxr2rFXmRivarb4BwjNiBgXDwe2p").unwrap();
        let mut user = User::default();
        for slot in user.orders.iter_mut().take(3) {
            slot.status = OrderStatus::Open;
        }

        let mut account_mocks = Mocks::default();
        account_mocks.insert(
            RpcRequest::GetAccountInfo,
            account_info_response(&user_pda, encode_user_account(&user)),
        );

        let client = setup(account_mocks, Keypair::new()).await;

        let orders = client.all_orders(&user_pda).await.unwrap();
        assert_eq!(orders.len(), 3);
    }

    #[tokio::test]
    async fn get_positions() {
        let user_pda = Pubkey::from_str("9JtczxrJjPM4J1xooxr2rFXmRivarb4BwjNiBgXDwe2p").unwrap();
        let mut user = User::default();
        // One non-available spot position (scaled_balance != 0).
        user.spot_positions[0].scaled_balance = 1;
        // One open perp position (base_asset_amount != 0).
        user.perp_positions[0].base_asset_amount = 1;

        let mut account_mocks = Mocks::default();
        account_mocks.insert(
            RpcRequest::GetAccountInfo,
            account_info_response(&user_pda, encode_user_account(&user)),
        );
        let client = setup(account_mocks, Keypair::new()).await;

        let (spot, perp) = client.all_positions(&user_pda).await.unwrap();
        assert_eq!(spot.len(), 1);
        assert_eq!(perp.len(), 1);
    }

    #[tokio::test]
    async fn test_place_orders_high_leverage() {
        let user = Cow::Owned(User::default());

        let program_data = ProgramData::new(
            vec![SpotMarket::default()],
            vec![PerpMarket::default()],
            vec![],
            State::default(),
        );
        let sub_account = Pubkey::new_unique();

        let builder = TransactionBuilder::new(&program_data, sub_account, user, false);

        let orders = vec![OrderParams {
            market_index: 0,
            market_type: MarketType::Perp,
            direction: PositionDirection::Long,
            order_type: OrderType::Limit,
            bit_flags: <OrderParams as crate::types::OrderParamsExt>::HIGH_LEVERAGE_MODE_FLAG,
            ..Default::default()
        }];

        let tx = builder.place_orders(orders).build();

        let high_leverage_account = *high_leverage_mode_account();
        assert!(tx.static_account_keys().contains(&high_leverage_account));
    }
}
