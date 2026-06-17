use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use crate::solana_sdk::{clock::Slot, commitment_config::CommitmentConfig, pubkey::Pubkey};
use anchor_lang::{AccountDeserialize, Discriminator};
use bytemuck::Pod;
use dashmap::DashMap;
use drift_pubsub_client::PubsubClient;
use futures_util::{
    stream::{FuturesOrdered, FuturesUnordered},
    StreamExt,
};
use serde_json::json;
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::{
    config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    request::RpcRequest,
    response::{OptionalContext, RpcKeyedAccount},
};

use crate::{
    accounts::State,
    constants::{self, derive_perp_market_account, derive_spot_market_account, state_account},
    grpc::AccountUpdate,
    memcmp::get_market_filter,
    types::{MapOf, OracleSource, EMPTY_ACCOUNT_CALLBACK},
    websocket_account_subscriber::WebsocketAccountSubscriber,
    DataAndSlot, MarketId, MarketType, PerpMarket, SdkResult, SpotMarket, UnsubHandle,
};

const LOG_TARGET: &str = "marketmap";

pub trait Market {
    const MARKET_TYPE: MarketType;
    fn market_index(&self) -> u16;
    fn oracle_info(&self) -> (MarketId, Pubkey, OracleSource);
}

impl Market for PerpMarket {
    const MARKET_TYPE: MarketType = MarketType::Perp;

    fn market_index(&self) -> u16 {
        self.market_index
    }

    fn oracle_info(&self) -> (MarketId, Pubkey, OracleSource) {
        (
            MarketId::perp(self.market_index),
            self.oracle,
            self.oracle_source,
        )
    }
}

impl Market for SpotMarket {
    const MARKET_TYPE: MarketType = MarketType::Spot;

    fn market_index(&self) -> u16 {
        self.market_index
    }

    fn oracle_info(&self) -> (MarketId, Pubkey, OracleSource) {
        (
            MarketId::spot(self.market_index),
            self.oracle,
            self.oracle_source,
        )
    }
}

/// Dynamic map of Drift Spot or Perp market accounts
///
/// Caller can subscribe to updates via Ws with `.subscribe(..)`
/// or drive the map by calling `.sync()` periodically
pub struct MarketMap<T: Pod + Discriminator + Send> {
    pub marketmap: Arc<DashMap<u16, DataAndSlot<T>, ahash::RandomState>>,
    subscriptions: DashMap<u16, UnsubHandle, ahash::RandomState>,
    latest_slot: Arc<AtomicU64>,
    pubsub: Arc<PubsubClient>,
    commitment: CommitmentConfig,
}

impl<T> MarketMap<T>
where
    T: Pod + Discriminator + Clone + Send + Sync + Market + 'static,
{
    pub const SUBSCRIPTION_ID: &'static str = "marketmap";

    pub fn new(pubsub: Arc<PubsubClient>, commitment: CommitmentConfig) -> Self {
        Self {
            subscriptions: Default::default(),
            marketmap: Arc::default(),
            latest_slot: Arc::new(AtomicU64::new(0)),
            pubsub,
            commitment,
        }
    }

    /// Return a reference to the internal map data structure
    pub fn map(&self) -> Arc<MapOf<u16, DataAndSlot<T>>> {
        Arc::clone(&self.marketmap)
    }

    /// Returns a hook for driving the map with new `Account` updates
    pub(crate) fn on_account_fn(&self) -> impl Fn(&AccountUpdate) {
        let marketmap = self.map();
        move |update: &AccountUpdate| {
            let market = crate::utils::deser_zero_copy::<T>(update.data);
            let idx = market.market_index();
            marketmap.insert(
                idx,
                DataAndSlot {
                    slot: update.slot,
                    data: market,
                },
            );
        }
    }

    /// Subscribe to market account updates without callback
    pub async fn subscribe(&self, markets: &[MarketId]) -> SdkResult<()> {
        self.subscribe_inner(markets, EMPTY_ACCOUNT_CALLBACK).await
    }

    /// Subscribe to market account updates with callback
    pub async fn subscribe_with_callback<F>(
        &self,
        markets: &[MarketId],
        on_account: F,
    ) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        self.subscribe_inner(markets, on_account).await
    }

    /// Subscribe to market account updates
    async fn subscribe_inner<F>(&self, markets: &[MarketId], on_account: F) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        log::debug!(target: LOG_TARGET, "subscribing: {:?}", T::MARKET_TYPE);

        let markets = HashSet::<MarketId>::from_iter(markets.iter().copied());
        let mut pending_subscriptions =
            Vec::<(u16, WebsocketAccountSubscriber)>::with_capacity(markets.len());
        for market in markets {
            if self.subscriptions.contains_key(&market.index()) {
                continue;
            }

            let market_pubkey = match T::MARKET_TYPE {
                MarketType::Perp => derive_perp_market_account(market.index()),
                MarketType::Spot => derive_spot_market_account(market.index()),
            };
            let market_subscriber = WebsocketAccountSubscriber::new(
                Arc::clone(&self.pubsub),
                market_pubkey,
                self.commitment,
            );

            pending_subscriptions.push((market.index(), market_subscriber));
        }

        let futs_iter = pending_subscriptions.into_iter().map(|(idx, fut)| {
            let marketmap = Arc::clone(&self.marketmap);
            let latest_slot = self.latest_slot.clone();
            let on_account = on_account.clone();
            async move {
                let unsub = fut
                    .subscribe(Self::SUBSCRIPTION_ID, false, {
                        move |update| {
                            if update.slot > latest_slot.load(Ordering::Relaxed) {
                                latest_slot.store(update.slot, Ordering::Relaxed);
                            }
                            marketmap.insert(
                                idx,
                                DataAndSlot {
                                    slot: update.slot,
                                    data: crate::utils::deser_zero_copy::<T>(&update.data),
                                },
                            );
                            on_account(update);
                        }
                    })
                    .await;
                (idx, unsub)
            }
        });

        let mut subscription_futs = FuturesUnordered::from_iter(futs_iter);
        while let Some((market, unsub)) = subscription_futs.next().await {
            log::debug!(target: LOG_TARGET, "subscribed market: {market:?}");
            self.subscriptions.insert(market, unsub?);
        }

        log::debug!(target: LOG_TARGET, "subscribed: {:?}", T::MARKET_TYPE);

        Ok(())
    }

    /// Returns whether the market is subscribed to Ws updates or not
    pub fn is_subscribed(&self, market_index: u16) -> bool {
        self.subscriptions.contains_key(&market_index)
    }

    /// Unsubscribe from updates for the given `markets`
    pub fn unsubscribe(&self, markets: &[MarketId]) -> SdkResult<()> {
        for market in markets {
            if let Some((market, unsub)) = self.subscriptions.remove(&market.index()) {
                let _ = unsub.send(());
                self.marketmap.remove(&market);
            }
        }
        log::debug!(target: LOG_TARGET, "unsubscribed markets: {markets:?}");

        Ok(())
    }

    /// Unsubscribe from all market updates
    pub fn unsubscribe_all(&self) -> SdkResult<()> {
        let all_markets: Vec<MarketId> = self
            .subscriptions
            .iter()
            .map(|x| (*x.key(), T::MARKET_TYPE).into())
            .collect();
        self.unsubscribe(&all_markets)
    }

    pub fn values(&self) -> Vec<T> {
        self.marketmap.iter().map(|x| x.data).collect()
    }

    /// Returns a list of oracle info for each market
    pub fn oracles(&self) -> Vec<(MarketId, Pubkey, OracleSource)> {
        self.values().iter().map(|x| x.oracle_info()).collect()
    }

    pub fn len(&self) -> usize {
        self.marketmap.len()
    }

    pub fn contains(&self, market_index: &u16) -> bool {
        self.marketmap.contains_key(market_index)
    }

    pub fn get(&self, market_index: &u16) -> Option<DataAndSlot<T>> {
        self.marketmap
            .get(market_index)
            .map(|market| market.clone())
    }

    /// Sync all market accounts
    pub async fn sync(&self, rpc: &RpcClient) -> SdkResult<()> {
        log::debug!(
            target: LOG_TARGET,
            "syncing marketmap: {:?}",
            T::MARKET_TYPE
        );
        let (markets, latest_slot) = get_market_accounts_with_fallback::<T>(rpc).await?;
        for market in markets {
            self.marketmap.insert(
                market.market_index(),
                DataAndSlot {
                    data: market,
                    slot: latest_slot,
                },
            );
        }
        self.latest_slot.store(latest_slot, Ordering::Relaxed);

        log::debug!(
            target: LOG_TARGET,
            "synced {:?} marketmap with {} markets",
            T::MARKET_TYPE,
            self.marketmap.len()
        );
        Ok(())
    }

    pub fn get_latest_slot(&self) -> u64 {
        self.latest_slot.load(Ordering::Relaxed)
    }
}

/// Fetch all market (program) accounts with multiple fallbacks
///
/// Tries progressively less intensive RPC methods for wider compatibility with RPC providers:
///     getProgramAccounts, getMultipleAccounts, lastly multiple getAccountInfo
///
/// Returns deserialized accounts and retrieved slot
pub async fn get_market_accounts_with_fallback<T: Market + Pod + Discriminator>(
    rpc: &RpcClient,
) -> SdkResult<(Vec<T>, Slot)> {
    let mut markets = Vec::<T>::default();

    let account_config = RpcAccountInfoConfig {
        commitment: Some(rpc.commitment()),
        encoding: Some(UiAccountEncoding::Base64Zstd),
        ..RpcAccountInfoConfig::default()
    };

    let gpa_config = RpcProgramAccountsConfig {
        filters: Some(vec![get_market_filter(T::MARKET_TYPE)]),
        account_config: account_config.clone(),
        with_context: Some(true),
        sort_results: None,
    };

    // try 'getProgramAccounts'
    let response: Result<OptionalContext<Vec<RpcKeyedAccount>>, _> = rpc
        .send(
            RpcRequest::GetProgramAccounts,
            json!([constants::PROGRAM_ID.to_string(), gpa_config]),
        )
        .await;

    if let Ok(OptionalContext::Context(accounts)) = response {
        for account in accounts.value {
            let market_data = account.account.data.decode().expect("Market data");
            markets.push(crate::utils::deser_zero_copy::<T>(&market_data));
        }
        return Ok((markets, accounts.context.slot));
    }
    log::debug!(
        target: LOG_TARGET,
        "syncing with getProgramAccounts failed: {:?}",
        T::MARKET_TYPE
    );

    let state_response = rpc
        .get_ui_account_with_config(state_account(), account_config)
        .await
        .expect("state account fetch");

    let state_data = state_response.value.expect("state has data").data;
    let state = State::try_deserialize_unchecked(
        &mut state_data.decode().expect("deser state account").as_slice(),
    )
    .expect("state deserializes");

    let market_pdas: Vec<Pubkey> = match T::MARKET_TYPE {
        MarketType::Spot => (0..state.number_of_spot_markets)
            .map(derive_spot_market_account)
            .collect(),
        MarketType::Perp => (0..state.number_of_markets)
            .map(derive_perp_market_account)
            .collect(),
    };

    // try 'getMultipleAccounts'
    let mut market_requests = FuturesOrdered::new();
    for market_chunk in market_pdas.chunks(64) {
        market_requests
            .push_back(rpc.get_multiple_accounts_with_commitment(market_chunk, rpc.commitment()));
    }

    while let Some(market_response) = market_requests.next().await {
        match market_response {
            Ok(data) => {
                for market in data.value {
                    match market {
                        Some(market) => {
                            markets.push(crate::utils::deser_zero_copy::<T>(&market.data));
                        }
                        None => {
                            log::warn!(
                                target: LOG_TARGET,
                                "failed to fetch market account (missing)"
                            );
                            break;
                        }
                    }
                }
            }
            Err(err) => {
                log::warn!(
                    target: LOG_TARGET,
                    "failed to fetch market accounts: {err:?}"
                );
                return Err(err)?;
            }
        }
    }
    if market_pdas.len() == markets.len() {
        return Ok((markets, state_response.context.slot));
    }
    log::debug!(
        target: LOG_TARGET,
        "syncing with getMultipleAccounts failed: {:?}",
        T::MARKET_TYPE
    );

    // try multiple 'getAccount's
    let mut market_requests =
        FuturesOrdered::from_iter(market_pdas.iter().map(|acc| rpc.get_account_data(acc)));

    while let Some(market_response) = market_requests.next().await {
        match market_response {
            Ok(data) => {
                markets.push(crate::utils::deser_zero_copy::<T>(&data));
            }
            Err(err) => {
                log::warn!("failed to fetch market account: {err:?}");
                return Err(err)?;
            }
        }
    }

    Ok((markets, state_response.context.slot))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::solana_sdk::commitment_config::CommitmentConfig;
    use drift_pubsub_client::PubsubClient;
    use solana_rpc_client::nonblocking::rpc_client::RpcClient;

    use super::{get_market_accounts_with_fallback, MarketMap};
    use crate::{
        accounts::{PerpMarket, SpotMarket},
        utils::{get_ws_url, test_envs::devnet_endpoint},
        MarketId,
    };

    #[tokio::test]
    async fn marketmap_subscribe() {
        let map = MarketMap::<PerpMarket>::new(
            Arc::new(
                PubsubClient::new(&get_ws_url(&devnet_endpoint()).unwrap())
                    .await
                    .expect("ws connects"),
            ),
            CommitmentConfig::confirmed(),
        );

        assert!(map
            .subscribe(&[MarketId::perp(0), MarketId::perp(1), MarketId::perp(1)])
            .await
            .is_ok());
        assert!(map.is_subscribed(0));
        assert!(map.is_subscribed(1));
        assert_eq!(map.subscriptions.len(), 2);

        assert!(map.unsubscribe_all().is_ok());
        assert_eq!(map.subscriptions.len(), 0);
        assert!(!map.is_subscribed(0));
        assert!(!map.is_subscribed(1));
    }

    #[tokio::test]
    async fn get_market_accounts_with_fallback_works() {
        let result: Result<(Vec<PerpMarket>, _), _> =
            get_market_accounts_with_fallback::<PerpMarket>(&RpcClient::new(devnet_endpoint()))
                .await;

        assert!(result.is_ok_and(|r| r.0.len() > 0 && r.1 > 0));

        let result =
            get_market_accounts_with_fallback::<SpotMarket>(&RpcClient::new(devnet_endpoint()))
                .await;

        assert!(result.is_ok_and(|r| r.0.len() > 0 && r.1 > 0));
    }
}

#[cfg(feature = "rpc_tests")]
mod rpc_tests {
    use crate::solana_sdk::commitment_config::CommitmentConfig;

    use super::*;
    use crate::utils::test_envs::mainnet_endpoint;

    #[tokio::test]
    async fn test_marketmap_perp() {
        let commitment = CommitmentConfig {
            commitment: CommitmentConfig::Processed,
        };

        let marketmap = MarketMap::<PerpMarket>::new(commitment, mainnet_endpoint(), true);
        marketmap.subscribe().await.unwrap();

        tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;

        dbg!(marketmap.size());
        assert!(marketmap.size() == 28);

        dbg!(marketmap.get_latest_slot());

        marketmap.unsubscribe().await.unwrap();

        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;

        assert_eq!(marketmap.size(), 0);
        assert_eq!(marketmap.subscribed.load(Ordering::Relaxed), false);
    }

    #[tokio::test]
    async fn test_marketmap_spot() {
        let commitment = CommitmentConfig {
            commitment: CommitmentConfig::Processed,
        };

        let marketmap = MarketMap::<SpotMarket>::new(commitment, RPC, true);
        marketmap.subscribe().await.unwrap();

        tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;

        dbg!(marketmap.size());
        assert!(marketmap.size() == 13);

        dbg!(marketmap.get_latest_slot());

        marketmap.unsubscribe().await.unwrap();

        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;

        assert_eq!(marketmap.size(), 0);
        assert_eq!(marketmap.subscribed.get(), false);
    }
}
