use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use crate::solana_sdk::{
    account::Account, clock::Slot, commitment_config::CommitmentConfig, pubkey::Pubkey,
};
use ahash::HashSet;
use dashmap::{DashMap, ReadOnlyView};
use drift::sdk::oracle_price as sdk_oracle_price;
use drift_pubsub_client::PubsubClient;
use futures_util::{
    stream::{FuturesOrdered, FuturesUnordered},
    StreamExt,
};
use log::warn;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;

use crate::{
    grpc::AccountUpdate as GrpcAccountUpdate,
    types::{AccountUpdate, MapOf, OraclePriceData, OracleSource, EMPTY_ACCOUNT_CALLBACK},
    websocket_account_subscriber::WebsocketAccountSubscriber,
    MarketId, SdkError, SdkResult, UnsubHandle,
};

const LOG_TARGET: &str = "oraclemap";

#[allow(dead_code)]
#[derive(Clone, Debug)]
/// Captures shared relationship between oracles and markets/source types
enum OracleShareMode {
    /// Oracle is used by 1 or more markets
    Normal { source: OracleSource },
    /// Oracle is shared by markets with mixed sources
    Mixed { sources: Vec<OracleSource> },
}

#[derive(Clone, Default, Debug)]
pub struct Oracle {
    pub pubkey: Pubkey,
    pub data: OraclePriceData,
    pub source: OracleSource,
    pub slot: u64,
    pub raw: Vec<u8>,
}

/// Dynamic map of Drift market oracle data
///
/// Caller can subscribe to some subset of markets for Ws backed updates
/// Alternatively, the caller may drive the map by calling `sync` periodically
pub struct OracleMap {
    /// Oracle data keyed by pubkey and source
    pub oraclemap: Arc<DashMap<(Pubkey, u8), Oracle, ahash::RandomState>>,
    /// Oracle subscription handles by pubkey
    subscriptions: DashMap<Pubkey, UnsubHandle, ahash::RandomState>,
    /// Oracle (pubkey, source) by MarketId (immutable)
    pub oracle_by_market: ReadOnlyView<MarketId, (Pubkey, OracleSource), ahash::RandomState>,
    /// map from oracle to consuming markets/source types
    shared_oracles: ReadOnlyView<Pubkey, OracleShareMode, ahash::RandomState>,
    latest_slot: Arc<AtomicU64>,
    commitment: CommitmentConfig,
    pubsub: Arc<PubsubClient>,
}

impl OracleMap {
    pub const SUBSCRIPTION_ID: &'static str = "oraclemap";

    /// Create a new `OracleMap`
    ///
    /// * `rpc_client` - Shared RPC client instance
    /// * `pubsub_client` - Shared Pubsub client instance
    /// * `all_oracles` - Exhaustive list of all Drift oracle pubkeys and source by market
    ///
    pub fn new(
        pubsub_client: Arc<PubsubClient>,
        all_oracles: &[(MarketId, Pubkey, OracleSource)],
        commitment: CommitmentConfig,
    ) -> Self {
        log::debug!(target: LOG_TARGET, "all oracles: {:?}", all_oracles);
        let oracle_by_market: DashMap<MarketId, (Pubkey, OracleSource), ahash::RandomState> =
            all_oracles
                .iter()
                .copied()
                .map(|(market, pubkey, source)| (market, (pubkey, source)))
                .collect();
        let oracle_by_market = oracle_by_market.into_read_only();

        let shared_oracles = DashMap::<Pubkey, OracleShareMode, ahash::RandomState>::default();
        for (_market, (pubkey, source)) in oracle_by_market.iter() {
            shared_oracles
                .entry(*pubkey)
                .and_modify(|m| match m {
                    OracleShareMode::Normal {
                        source: existing_source,
                    } => {
                        if existing_source != source {
                            *m = OracleShareMode::Mixed {
                                sources: vec![*existing_source, *source],
                            }
                        }
                    }
                    OracleShareMode::Mixed { sources } => {
                        if !sources.contains(source) {
                            sources.push(*source);
                        }
                    }
                })
                .or_insert(OracleShareMode::Normal { source: *source });
        }

        Self {
            oraclemap: Arc::default(),
            shared_oracles: shared_oracles.into_read_only(),
            oracle_by_market,
            subscriptions: Default::default(),
            latest_slot: Arc::new(AtomicU64::new(0)),
            commitment,
            pubsub: pubsub_client,
        }
    }

    /// Subscribe to oracle updates for given `markets` without callback
    pub async fn subscribe(&self, markets: &[MarketId]) -> SdkResult<()> {
        self.subscribe_inner(markets, EMPTY_ACCOUNT_CALLBACK).await
    }

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

    /// Subscribe to oracle updates for given `markets`
    ///
    /// Can be called multiple times to subscribe to additional markets
    ///
    /// Panics
    ///
    /// If the `market` oracle pubkey is not loaded
    async fn subscribe_inner<F>(&self, markets: &[MarketId], on_account: F) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        let markets = HashSet::from_iter(markets);
        log::debug!(target: LOG_TARGET, "subscribe market oracles: {markets:?}");

        let mut pending_subscriptions =
            Vec::<WebsocketAccountSubscriber>::with_capacity(markets.len());

        for market in markets {
            let (oracle_pubkey, _oracle_source) =
                self.oracle_by_market.get(market).expect("oracle exists");

            // markets can share oracle pubkeys, only want one sub per oracle pubkey
            if self.subscriptions.contains_key(oracle_pubkey)
                || pending_subscriptions
                    .iter()
                    .any(|sub| &sub.pubkey == oracle_pubkey)
            {
                log::debug!(
                    target: LOG_TARGET,
                    "subscription exists: {market:?}/{oracle_pubkey:?}"
                );
                continue;
            }

            let oracle_subscriber = WebsocketAccountSubscriber::new(
                Arc::clone(&self.pubsub),
                *oracle_pubkey,
                self.commitment,
            );

            pending_subscriptions.push(oracle_subscriber);
        }

        let futs_iter = pending_subscriptions.into_iter().map(|sub_fut| {
            let oraclemap = Arc::clone(&self.oraclemap);
            let oracle_shared_mode = self
                .shared_oracles
                .get(&sub_fut.pubkey)
                .expect("oracle exists")
                .clone();
            let oracle_shared_mode_ref = oracle_shared_mode.clone();
            let on_account = on_account.clone();
            async move {
                let unsub = sub_fut
                    .subscribe(Self::SUBSCRIPTION_ID, true, move |update| {
                        match &oracle_shared_mode_ref {
                            OracleShareMode::Normal { source } => {
                                update_handler(update, *source, &oraclemap)
                            }
                            OracleShareMode::Mixed { sources } => {
                                for source in sources {
                                    update_handler(update, *source, &oraclemap);
                                }
                            }
                        }
                        on_account(update);
                    })
                    .await;
                ((sub_fut.pubkey, oracle_shared_mode), unsub)
            }
        });

        let mut subscription_futs = FuturesUnordered::from_iter(futs_iter);

        while let Some(((pubkey, oracle_share_mode), unsub)) = subscription_futs.next().await {
            log::debug!(
                target: LOG_TARGET,
                "subscribed market oracle: {oracle_share_mode:?}"
            );
            self.subscriptions.insert(pubkey, unsub?);
        }

        log::debug!(target: LOG_TARGET, "subscribed");
        Ok(())
    }

    /// Unsubscribe from oracle updates for the given `markets`
    pub fn unsubscribe(&self, markets: &[MarketId]) -> SdkResult<()> {
        for market in markets {
            if let Some((oracle_pubkey, oracle_source)) = self.oracle_by_market.get(market) {
                if let Some((_, unsub)) = self.subscriptions.remove(oracle_pubkey) {
                    let _ = unsub.send(());
                    self.oraclemap
                        .remove(&(*oracle_pubkey, *oracle_source as u8));
                }
            }
        }
        log::debug!(target: LOG_TARGET, "unsubscribed markets: {markets:?}");

        Ok(())
    }

    /// Unsubscribe from all oracle updates
    pub fn unsubscribe_all(&self) -> SdkResult<()> {
        let all_markets: Vec<MarketId> = self.oracle_by_market.keys().copied().collect();
        self.unsubscribe(&all_markets)
    }

    /// Fetches account data for each market oracle set by `markets`
    ///
    /// This may be invoked manually to resync oracle data for some set of markets
    pub async fn sync(&self, markets: &[MarketId], rpc: &RpcClient) -> SdkResult<()> {
        let markets = HashSet::<MarketId>::from_iter(markets.iter().copied());
        log::debug!(target: LOG_TARGET, "sync oracles for: {markets:?}");

        let mut oracle_sources = Vec::with_capacity(markets.len());
        let mut oracle_pubkeys = Vec::with_capacity(markets.len());

        for (_, (pubkey, source)) in self
            .oracle_by_market
            .iter()
            .filter(|(m, _)| markets.contains(m))
        {
            oracle_pubkeys.push(*pubkey);
            oracle_sources.push(*source);
        }

        let (mut synced_oracles, latest_slot) =
            match get_multi_account_data_with_fallback(rpc, &oracle_pubkeys).await {
                Ok(result) => result,
                Err(err) => {
                    warn!(target: LOG_TARGET, "failed to sync oracle accounts");
                    return Err(err);
                }
            };

        if synced_oracles.len() != oracle_pubkeys.len() {
            warn!(target: LOG_TARGET, "failed to sync all oracle accounts");
            return Err(SdkError::InvalidOracle);
        }

        for ((oracle_pubkey, oracle_account), oracle_source) in
            synced_oracles.iter_mut().zip(oracle_sources)
        {
            let price_data = sdk_oracle_price(
                &oracle_source,
                oracle_pubkey,
                &oracle_account.owner,
                &mut oracle_account.data,
                latest_slot,
            )
            .expect("valid oracle data");

            self.oraclemap
                .entry((*oracle_pubkey, oracle_source as u8))
                .and_modify(|o| {
                    log::debug!(
                        target: LOG_TARGET,
                        "sync oracle update: {:?}/{}",
                        oracle_source,
                        oracle_pubkey
                    );
                    o.raw.clone_from(&oracle_account.data);
                    o.data = price_data;
                    o.slot = latest_slot;
                })
                .or_insert_with(|| {
                    log::debug!(
                        target: LOG_TARGET,
                        "sync oracle new: {:?}/{}",
                        oracle_source,
                        oracle_pubkey
                    );
                    Oracle {
                        pubkey: *oracle_pubkey,
                        data: price_data,
                        slot: latest_slot,
                        source: oracle_source,
                        raw: oracle_account.data.clone(),
                    }
                });
        }

        self.latest_slot.store(latest_slot, Ordering::Relaxed);
        log::debug!(
            target: LOG_TARGET,
            "synced {} oracles",
            synced_oracles.len()
        );

        Ok(())
    }

    /// Number of oracles known to the `OracleMap`
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.oraclemap.len()
    }

    /// Returns true if the oraclemap has a Ws subscription for `market`
    pub fn is_subscribed(&self, market: &MarketId) -> bool {
        if let Some((oracle_pubkey, _oracle_source)) = self.oracle_by_market.get(market) {
            self.subscriptions.contains_key(oracle_pubkey)
        } else {
            false
        }
    }

    /// Get the address of a perp market oracle
    pub fn current_perp_oracle(&self, market_index: u16) -> Option<Pubkey> {
        self.get_by_market(&MarketId::perp(market_index))
            .map(|x| x.pubkey)
    }

    /// Get the address of a spot market oracle
    pub fn current_spot_oracle(&self, market_index: u16) -> Option<Pubkey> {
        self.get_by_market(&MarketId::spot(market_index))
            .map(|x| x.pubkey)
    }

    /// Return Oracle data by market, if known
    pub fn get_by_market(&self, market: &MarketId) -> Option<Oracle> {
        if let Some((oracle_pubkey, oracle_source)) = self.oracle_by_market.get(market) {
            self.oraclemap
                .get(&(*oracle_pubkey, *oracle_source as u8))
                .map(|o| o.clone())
        } else {
            None
        }
    }

    #[allow(dead_code)]
    pub fn values(&self) -> Vec<Oracle> {
        self.oraclemap.iter().map(|x| x.clone()).collect()
    }

    pub fn get_latest_slot(&self) -> u64 {
        self.latest_slot.load(Ordering::Relaxed)
    }
    /// Return a reference to the internal map data structure
    pub fn map(&self) -> Arc<MapOf<(Pubkey, u8), Oracle>> {
        Arc::clone(&self.oraclemap)
    }

    /// Returns a hook for driving the map with new `Account` updates
    pub(crate) fn on_account_fn(&self) -> impl Fn(&GrpcAccountUpdate) {
        let oraclemap = self.map();
        let oracle_lookup = self.shared_oracles.clone();

        move |update: &GrpcAccountUpdate| match oracle_lookup.get(&update.pubkey).unwrap() {
            OracleShareMode::Normal { source } => {
                update_handler_grpc(update, *source, &oraclemap);
            }
            OracleShareMode::Mixed { sources } => {
                for source in sources {
                    update_handler_grpc(update, *source, &oraclemap);
                }
            }
        }
    }
}

/// Handler fn for new oracle account data
#[inline]
fn update_handler_grpc(
    update: &GrpcAccountUpdate,
    oracle_source: OracleSource,
    oracle_map: &DashMap<(Pubkey, u8), Oracle, ahash::RandomState>,
) {
    let slot = update.slot;
    let mut data_buf = update.data.to_vec();
    match sdk_oracle_price(
        &oracle_source,
        &update.pubkey,
        &update.owner,
        &mut data_buf,
        slot,
    ) {
        Ok(price_data) => {
            oracle_map
                .entry((update.pubkey, oracle_source as u8))
                .and_modify(|o| {
                    o.data = price_data;
                    o.slot = slot;
                    o.raw.resize(update.data.len(), 0);
                    o.raw.clone_from_slice(update.data);
                })
                .or_insert(Oracle {
                    pubkey: update.pubkey,
                    source: oracle_source,
                    data: price_data,
                    slot,
                    raw: update.data.to_vec(),
                });
        }
        Err(err) => {
            log::error!("Failed to get oracle price: {err:?}, {:?}", update.pubkey)
        }
    }
}

/// Handler fn for new oracle account data
fn update_handler(
    update: &AccountUpdate,
    oracle_source: OracleSource,
    oracle_map: &DashMap<(Pubkey, u8), Oracle, ahash::RandomState>,
) {
    let oracle_pubkey = update.pubkey;
    let mut data_buf = update.data.clone();
    match sdk_oracle_price(
        &oracle_source,
        &oracle_pubkey,
        &update.owner,
        &mut data_buf,
        update.slot,
    ) {
        Ok(price_data) => {
            oracle_map
                .entry((oracle_pubkey, oracle_source as u8))
                .and_modify(|o| {
                    o.data = price_data;
                    o.slot = update.slot;
                    o.raw = update.data.to_vec();
                })
                .or_insert(Oracle {
                    pubkey: oracle_pubkey,
                    source: oracle_source,
                    data: price_data,
                    slot: update.slot,
                    raw: update.data.to_vec(),
                });
        }
        Err(err) => {
            log::error!("Failed to get oracle price: {err:?}, {oracle_pubkey:?}")
        }
    }
}

/// Fetch all accounts with multiple fallbacks
///
/// Tries progressively less intensive RPC methods for wider compatibility with RPC providers:
///    getMultipleAccounts, lastly multiple getAccountInfo
///
/// Returns deserialized accounts and retrieved slot
async fn get_multi_account_data_with_fallback(
    rpc: &RpcClient,
    pubkeys: &[Pubkey],
) -> SdkResult<(Vec<(Pubkey, Account)>, Slot)> {
    let mut account_data = Vec::with_capacity(pubkeys.len());

    // try 'getMultipleAccounts'
    let mut gma_requests = FuturesOrdered::new();
    for keys in pubkeys.chunks(64) {
        gma_requests.push_back(async move {
            let response = rpc
                .get_multiple_accounts_with_commitment(keys, rpc.commitment())
                .await;
            (response, keys)
        });
    }

    let mut gma_slot = 0;
    while let Some((gma_response, keys)) = gma_requests.next().await {
        match gma_response {
            Ok(response) => {
                gma_slot = response.context.slot;
                for (oracle, pubkey) in response.value.into_iter().zip(keys) {
                    match oracle {
                        Some(oracle) => {
                            account_data.push((*pubkey, oracle));
                        }
                        None => {
                            log::warn!(
                                target: LOG_TARGET,
                                "failed to fetch oracle account (missing)"
                            );
                            break;
                        }
                    }
                }
            }
            Err(err) => {
                log::warn!(
                    target: LOG_TARGET,
                    "failed to fetch oracle accounts: {err:?}"
                );
                return Err(err)?;
            }
        }
    }

    if account_data.len() == pubkeys.len() {
        return Ok((account_data, gma_slot));
    }
    log::debug!(
        target: LOG_TARGET,
        "syncing with getMultipleAccounts failed"
    );

    // try multiple 'getAccount's
    let mut account_requests = FuturesOrdered::from_iter(pubkeys.iter().map(|p| async move {
        (
            p,
            rpc.get_account_with_commitment(p, rpc.commitment()).await,
        )
    }));

    let mut latest_slot = 0;
    while let Some((pubkey, response)) = account_requests.next().await {
        match response {
            Ok(response) => {
                let account = response.value.ok_or({
                    log::warn!("failed to fetch oracle account");
                    SdkError::InvalidOracle
                })?;
                latest_slot = latest_slot.max(response.context.slot);
                account_data.push((*pubkey, account));
            }
            Err(err) => {
                log::warn!("failed to fetch oracle account: {err:?}");
                return Err(err)?;
            }
        }
    }

    Ok((account_data, latest_slot))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::{
        get_ws_url,
        test_envs::{devnet_endpoint, mainnet_endpoint},
    };

    const SOL_PERP_ORACLE: Pubkey =
        solana_pubkey::pubkey!("BAtFj4kQttZRVep3UZS2aZRDixkGYgWsbqTBVDbnSsPF");

    #[tokio::test]
    async fn oraclemap_sync() {
        let all_oracles = vec![
            (
                MarketId::spot(0),
                solana_pubkey::pubkey!("5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7"),
                OracleSource::PythStableCoin,
            ),
            (MarketId::perp(0), SOL_PERP_ORACLE, OracleSource::PythPull),
            (
                MarketId::perp(1),
                solana_pubkey::pubkey!("486kr3pmFPfTsS4aZgcsQ7kS4i9rjMsYYZup6HQNSTT4"),
                OracleSource::PythPull,
            ),
            (MarketId::spot(1), SOL_PERP_ORACLE, OracleSource::PythPull),
        ];
        let rpc = Arc::new(RpcClient::new(devnet_endpoint().into()));
        let pubsub = Arc::new(
            PubsubClient::new(&get_ws_url(&devnet_endpoint()).unwrap())
                .await
                .expect("ws connects"),
        );
        let map = OracleMap::new(pubsub, &all_oracles, rpc.commitment());

        // - dups ignored
        // - markets with same oracle pubkey, make at most 1 sub
        let markets = [
            MarketId::perp(0),
            MarketId::spot(1),
            MarketId::perp(1),
            MarketId::spot(1),
        ];
        map.sync(&markets, &rpc).await.expect("subd");
    }

    #[tokio::test]
    async fn oraclemap_subscribe_mixed_spot_perp_source() {
        // bonk oracle uses a precision trick via 'oracle source'
        // with same oracle pubkey
        let all_oracles = vec![
            (
                MarketId::perp(0),
                solana_pubkey::pubkey!("3m6i4RFWEDw2Ft4tFHPJtYgmpPe21k56M3FHeWYrgGBz"),
                OracleSource::PythLazer,
            ),
            (
                MarketId::perp(4),
                solana_pubkey::pubkey!("BERaNi6cpEresbq6HC1EQGaB1H1UjvEo4NGnmYSSJof4"),
                OracleSource::PythLazer1M,
            ),
            (
                MarketId::spot(32),
                solana_pubkey::pubkey!("BERaNi6cpEresbq6HC1EQGaB1H1UjvEo4NGnmYSSJof4"),
                OracleSource::PythLazer,
            ),
        ];
        let pubsub = Arc::new(
            PubsubClient::new(&get_ws_url(&mainnet_endpoint()).unwrap())
                .await
                .expect("ws connects"),
        );
        let map = OracleMap::new(pubsub, &all_oracles, CommitmentConfig::confirmed());

        let markets = [MarketId::perp(0), MarketId::spot(32), MarketId::perp(4)];
        map.subscribe(&markets).await.expect("subd");
        assert_eq!(map.len(), 3);
        assert!(map.is_subscribed(&MarketId::spot(32)));
        assert!(map.is_subscribed(&MarketId::perp(4)));
    }

    #[tokio::test]
    async fn oraclemap_subscribes() {
        let _ = env_logger::try_init();
        let all_oracles = vec![
            (
                MarketId::spot(0),
                solana_pubkey::pubkey!("5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7"),
                OracleSource::PythStableCoin,
            ),
            (MarketId::perp(0), SOL_PERP_ORACLE, OracleSource::PythPull),
            (
                MarketId::perp(1),
                solana_pubkey::pubkey!("486kr3pmFPfTsS4aZgcsQ7kS4i9rjMsYYZup6HQNSTT4"),
                OracleSource::PythPull,
            ),
            (MarketId::spot(1), SOL_PERP_ORACLE, OracleSource::PythPull),
        ];
        let pubsub = Arc::new(
            PubsubClient::new(&get_ws_url(&devnet_endpoint()).unwrap())
                .await
                .expect("ws connects"),
        );
        let map = OracleMap::new(pubsub, &all_oracles, CommitmentConfig::confirmed());

        // - dups ignored
        // - markets with same oracle pubkey, make at most 1 sub
        let markets = [
            MarketId::perp(0),
            MarketId::spot(1),
            MarketId::perp(1),
            MarketId::spot(1),
        ];
        map.subscribe(&markets).await.expect("subd");
        assert_eq!(map.len(), 2);
        let markets = [MarketId::perp(0), MarketId::spot(1)];
        map.subscribe(&markets).await.expect("subd");
        assert_eq!(map.len(), 2);

        assert!(map.is_subscribed(&MarketId::perp(0)));
        assert!(map.is_subscribed(&MarketId::perp(1)));

        // check unsub ok
        assert!(map.unsubscribe(&[MarketId::perp(0)]).is_ok());
        assert!(!map.is_subscribed(&MarketId::perp(0)));
    }

    #[tokio::test]
    async fn oraclemap_unsubscribe_all() {
        let all_oracles = vec![
            (
                MarketId::spot(0),
                solana_pubkey::pubkey!("5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7"),
                OracleSource::PythStableCoin,
            ),
            (
                MarketId::perp(1),
                solana_pubkey::pubkey!("486kr3pmFPfTsS4aZgcsQ7kS4i9rjMsYYZup6HQNSTT4"),
                OracleSource::PythPull,
            ),
        ];
        let map = OracleMap::new(
            Arc::new(
                PubsubClient::new(&get_ws_url(&devnet_endpoint()).unwrap())
                    .await
                    .expect("ws connects"),
            ),
            &all_oracles,
            CommitmentConfig::confirmed(),
        );
        map.subscribe(&[MarketId::spot(0), MarketId::perp(1)])
            .await
            .expect("subd");
        assert!(map.unsubscribe_all().is_ok());
        assert_eq!(map.len(), 0);
    }

    #[cfg(feature = "rpc_tests")]
    #[tokio::test]
    async fn test_oracle_map() {
        use crate::{
            marketmap::MarketMap,
            types::accounts::{PerpMarket, SpotMarket},
        };
        let commitment = CommitmentConfig::processed();

        let spot_market_map =
            MarketMap::<SpotMarket>::new(commitment.clone(), mainnet_endpoint(), true);
        let perp_market_map =
            MarketMap::<PerpMarket>::new(commitment.clone(), mainnet_endpoint(), true);

        let _ = spot_market_map.sync().await;
        let _ = perp_market_map.sync().await;

        let perp_oracles = perp_market_map.oracles();
        let spot_oracles = spot_market_map.oracles();

        let mut oracles = vec![];
        oracles.extend(perp_oracles.clone());
        oracles.extend(spot_oracles.clone());

        let mut oracle_infos = vec![];
        for oracle_info in oracles {
            if !oracle_infos.contains(&oracle_info) {
                oracle_infos.push(oracle_info)
            }
        }

        let oracle_infos_len = oracle_infos.len();
        dbg!(oracle_infos_len);

        let oracle_map = OracleMap::new(
            commitment,
            &mainnet_endpoint(),
            true,
            perp_oracles,
            spot_oracles,
        );

        let _ = oracle_map.subscribe().await;

        dbg!(oracle_map.size());

        dbg!("sleeping");
        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
        dbg!("done sleeping");

        let rlb_perp_market_oracle_pubkey = perp_market_map
            .get(&17)
            .expect("rlb perp market")
            .data
            .amm
            .oracle;
        let rlb_oracle = oracle_map
            .get(&rlb_perp_market_oracle_pubkey)
            .expect("rlb oracle");
        dbg!("rlb oracle info:");
        dbg!(rlb_oracle.data.price);
        dbg!(rlb_oracle.slot);

        dbg!("perp market oracles");
        let mut last_sol_price = 0;
        let mut last_sol_slot = 0;
        let mut last_btc_price = 0;
        let mut last_btc_slot = 0;
        for _ in 0..10 {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            dbg!();
            let sol_perp_market_oracle_pubkey = perp_market_map
                .get(&0)
                .expect("sol perp market")
                .data
                .amm
                .oracle;
            let sol_oracle = oracle_map
                .get(&sol_perp_market_oracle_pubkey)
                .expect("sol oracle");
            dbg!("sol oracle info:");
            dbg!(sol_oracle.data.price);
            dbg!(sol_oracle.slot);
            dbg!(
                "sol price change: {}",
                sol_oracle.data.price - last_sol_price
            );
            dbg!("sol slot change: {}", sol_oracle.slot - last_sol_slot);
            last_sol_price = sol_oracle.data.price;
            last_sol_slot = sol_oracle.slot;

            dbg!();

            let btc_perp_market_oracle_pubkey = perp_market_map
                .get(&1)
                .expect("btc perp market")
                .data
                .amm
                .oracle;
            let btc_oracle = oracle_map
                .get(&btc_perp_market_oracle_pubkey)
                .expect("btc oracle");
            dbg!("btc oracle info:");
            dbg!(btc_oracle.data.price);
            dbg!(btc_oracle.slot);
            dbg!(
                "btc price change: {}",
                btc_oracle.data.price - last_btc_price
            );
            dbg!("btc slot change: {}", btc_oracle.slot - last_btc_slot);
            last_btc_price = btc_oracle.data.price;
            last_btc_slot = btc_oracle.slot;
        }

        dbg!();

        dbg!("spot market oracles");
        let mut last_rndr_price = 0;
        let mut last_rndr_slot = 0;
        let mut last_weth_price = 0;
        let mut last_weth_slot = 0;
        for _ in 0..10 {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            dbg!();
            let rndr_spot_market_oracle_pubkey = spot_market_map
                .get(&11)
                .expect("sol perp market")
                .data
                .oracle;
            let rndr_oracle = oracle_map
                .get(&rndr_spot_market_oracle_pubkey)
                .expect("sol oracle");
            dbg!("rndr oracle info:");
            dbg!(rndr_oracle.data.price);
            dbg!(rndr_oracle.slot);
            dbg!(
                "rndr price change: {}",
                rndr_oracle.data.price - last_rndr_price
            );
            dbg!("rndr slot change: {}", rndr_oracle.slot - last_rndr_slot);
            last_rndr_price = rndr_oracle.data.price;
            last_rndr_slot = rndr_oracle.slot;

            dbg!();

            let weth_spot_market_oracle_pubkey = spot_market_map
                .get(&4)
                .expect("sol perp market")
                .data
                .oracle;
            let weth_oracle = oracle_map
                .get(&weth_spot_market_oracle_pubkey)
                .expect("sol oracle");
            dbg!("weth oracle info:");
            dbg!(weth_oracle.data.price);
            dbg!(weth_oracle.slot);
            dbg!(
                "weth price change: {}",
                weth_oracle.data.price - last_weth_price
            );
            dbg!("weth slot change: {}", weth_oracle.slot - last_weth_slot);
            last_weth_price = weth_oracle.data.price;
            last_weth_slot = weth_oracle.slot;
        }

        let _ = oracle_map.unsubscribe().await;
    }
}
