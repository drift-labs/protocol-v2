//! Filler Bot
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anchor_lang::Discriminator;
use dashmap::DashMap;
use futures_util::StreamExt;
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_rpc_client_api::config::{
    RpcAccountInfoConfig, RpcProgramAccountsConfig, RpcTransactionConfig,
};
use solana_sdk::{signature::Signature, transaction::TransactionError};
use solana_transaction_status_client_types::UiTransactionEncoding;
use tokio::{runtime::Handle, sync::RwLock};
use velocity_rs::program::math::auction::calculate_auction_price;
use velocity_rs::{
    constants::PROGRAM_ID,
    dlob::{
        CrossesAndTopMakers, CrossingRegion, DLOBNotifier, MakerCrosses, OrderKind, TakerOrder,
        DLOB,
    },
    event_subscriber::VelocityEvent,
    grpc::{
        grpc_subscriber::{AccountFilter, GrpcConnectionOpts},
        AccountUpdate, TransactionUpdate,
    },
    priority_fee_subscriber::PriorityFeeSubscriber,
    swift_order_subscriber::{SignedOrderInfo, SwiftOrderStream},
    types::{
        accounts::{PerpMarket, User, UserStats},
        CommitmentConfig, FeeTier, MarketId, MarketPrecision, MarketStatus, MarketType, Order,
        OrderParamsExt, OrderTriggerCondition, OrderType, PositionDirection, PostOnlyParam,
        RpcSendTransactionConfig, StateExt, VersionedMessage, VersionedTransaction, AMM,
    },
    GrpcSubscribeOpts, Pubkey, TransactionBuilder, VelocityClient, Wallet,
};

use crate::{
    http::Metrics,
    util::{
        swift_placement_expired, OrderSlotLimiter, PendingTxMeta, PendingTxs, PythPriceUpdate,
        TxIntent,
    },
    Config, UseMarkets,
};

const TARGET: &str = "filler";

pub struct FillerBot {
    velocity: VelocityClient,
    dlob: &'static DLOB,
    filler_subaccount: Pubkey,
    slot_rx: tokio::sync::mpsc::Receiver<u64>,
    swift_order_stream: SwiftOrderStream,
    limiter: OrderSlotLimiter<40>,
    market_ids: Vec<MarketId>,
    config: Config,
    tx_worker_ref: TxSender,
    priority_fee_subscriber: Arc<PriorityFeeSubscriber>,
    pyth_price_feed: Option<tokio::sync::mpsc::Receiver<PythPriceUpdate>>,
    metrics: Arc<Metrics>,
}

impl FillerBot {
    pub async fn new(config: Config, velocity: VelocityClient, metrics: Arc<Metrics>) -> Self {
        let dlob: &'static DLOB = Box::leak(Box::new(DLOB::default()));
        let tx_worker = TxWorker::new(
            velocity.clone(),
            metrics.clone(),
            config.dry,
            None,
            None,
            None,
        );
        let rt = tokio::runtime::Handle::current();
        let tx_worker_ref = tx_worker.run(rt);

        let mut market_ids = match config.use_markets() {
            UseMarkets::All => velocity.get_all_perp_market_ids(),
            UseMarkets::Subset(m) => m,
        };
        // remove bet perp markets
        market_ids.retain(|x| {
            let market = velocity
                .program_data()
                .perp_market_config_by_index(x.index())
                .unwrap();
            let name = core::str::from_utf8(&market.name)
                .unwrap()
                .to_ascii_lowercase();

            !name.contains("bet") && market.status != MarketStatus::Initialized
        });

        let market_pubkeys: Vec<Pubkey> = market_ids
            .iter()
            .map(|x| {
                velocity
                    .program_data()
                    .perp_market_config_by_index(x.index())
                    .unwrap()
                    .pubkey
            })
            .collect();

        let priority_fee_subscriber =
            PriorityFeeSubscriber::new(velocity.rpc().url(), &market_pubkeys);
        let priority_fee_subscriber = priority_fee_subscriber.subscribe();

        let filler_subaccount = velocity.wallet.sub_account(config.sub_account_id);

        // SWIFT_WS_URL overrides the swift ws server base url (velocity-rs appends
        // `/ws?pubkey=`). Velocity runs swift-ws-server-app in-cluster; without this
        // override velocity-rs falls back to the dead drift host (master.swift.drift.trade)
        // and connect_async panics on DNS lookup. None => SDK default.
        let swift_ws_url = std::env::var("SWIFT_WS_URL").ok();
        log::info!(target: TARGET, "subscribing swift orders (ws url override: {swift_ws_url:?})");
        let swift_order_stream = velocity
            .subscribe_swift_orders(&market_ids, Some(true), None, swift_ws_url)
            .await
            .expect("subscribed swift orders");
        log::info!(target: TARGET, "subscribed swift orders");

        velocity.subscribe_blockhashes().await.expect("subscribed");
        let slot_rx = setup_grpc(
            velocity.clone(),
            dlob,
            tx_worker_ref.clone(),
            market_ids.clone(),
        )
        .await;
        log::info!(target: TARGET, "subscribed gRPC");

        let pyth_price_feed = if !config.no_pyth {
            let pyth_access_token = std::env::var("PYTH_LAZER_TOKEN").expect("pyth access token");
            let pyth_feed_cli = pyth_lazer_client::LazerClient::new(
                "wss://pyth-lazer.dourolabs.app/v1/stream",
                pyth_access_token.as_str(),
            )
            .expect("pyth price feed connects");
            let feed = crate::util::subscribe_price_feeds(pyth_feed_cli, &market_ids, &[], &[]);
            log::info!(target: TARGET, "subscribed pyth price feeds");
            Some(feed)
        } else {
            log::info!(target: TARGET, "pyth price feed disabled");
            None
        };

        FillerBot {
            velocity,
            dlob,
            filler_subaccount,
            slot_rx,
            swift_order_stream,
            limiter: OrderSlotLimiter::new(),
            market_ids,
            config,
            tx_worker_ref,
            priority_fee_subscriber,
            pyth_price_feed,
            metrics,
        }
    }

    pub async fn run(self) {
        let mut swift_order_stream = self.swift_order_stream;
        let mut slot_rx = self.slot_rx;
        let mut limiter = self.limiter;
        let velocity: &'static VelocityClient = Box::leak(Box::new(self.velocity));
        let dlob = self.dlob;
        let market_ids = self.market_ids;
        let filler_subaccount = self.filler_subaccount;
        let config = self.config.clone();
        let tx_worker_ref = self.tx_worker_ref.clone();
        let priority_fee_subscriber = Arc::clone(&self.priority_fee_subscriber);
        let metrics = Arc::clone(&self.metrics);
        // reused per-slot scratch buffer for triggerable order ids (avoids per-slot allocation)
        let mut triggerable_buf: Vec<(Pubkey, u32)> = Vec::new();
        let mut slot = 0;
        let mut use_median_trigger_price = velocity
            .state_account()
            .map(|s| s.has_median_trigger_price_feature())
            .unwrap_or(false);
        let mut slots_before_stale_for_amm = velocity
            .state_account()
            .map(|s| s.oracle_guard_rails.validity.slots_before_stale_for_amm)
            .unwrap_or(10);
        let mut pyth_oracle_prices = BTreeMap::<u16, PythPriceUpdate>::new();

        // Create a dummy receiver that never sends when pyth is disabled
        let (_dummy_tx, dummy_rx) = tokio::sync::mpsc::channel::<PythPriceUpdate>(1);
        let mut pyth_price_feed = self.pyth_price_feed.unwrap_or(dummy_rx);

        // Swift retry mechanism
        const MAX_SWIFT_RECONNECT_RETRIES: u32 = 10;
        let mut retries = 0u32;
        loop {
            tokio::select! {
                biased;
                swift_order = swift_order_stream.next() => {
                    match swift_order {
                        Some(signed_order) => {
                            // reset
                            retries = 0;

                            let order_params = signed_order.order_params();
                            let market_index = order_params.market_index;
                            log::info!(target: TARGET, "new swift order. uuid={}, market={}", signed_order.order_uuid_str(), market_index);
                            log::debug!(target: TARGET, "details: {signed_order:?}");
                            let perp_market = velocity.try_get_perp_market_account(market_index).unwrap();
                            let oracle_price_data = velocity.try_get_mmoracle_for_perp_market(market_index, slot).expect("got oracle price");

                            // try an immediate fill against resting liquidity
                            match evaluate_swift_crosses(dlob, &signed_order, &perp_market, oracle_price_data.price, oracle_price_data.delay, slot, slots_before_stale_for_amm) {
                                SwiftEval::Fillable(crosses) => {
                                    log::info!(target: TARGET, "found resting cross. crosses={crosses:?}");
                                    let pf = priority_fee_subscriber.priority_fee_nth(0.6);
                                    try_swift_fill(
                                        velocity,
                                        pf,
                                        config.swift_cu_limit,
                                        filler_subaccount,
                                        signed_order,
                                        crosses,
                                        tx_worker_ref.clone(),
                                    ).await;
                                }
                                SwiftEval::NotFillable => {
                                    // Well-formed but not marketable yet. Rather than dropping it,
                                    // place it on-chain (no fill) so it becomes a regular resting
                                    // order that the normal per-slot fill path will pick up while
                                    // it remains live. Skip if it can no longer be placed (the
                                    // program would reject/no-op it) to avoid wasting gas.
                                    let now_ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
                                    let order_slot = signed_order.slot();
                                    let auction_duration = order_params.auction_duration.unwrap_or(0);
                                    let max_ts = order_params.max_ts.unwrap_or(0);
                                    if swift_placement_expired(order_slot, auction_duration, max_ts, slot, now_ts) {
                                        log::debug!(target: TARGET, "swift order past placement window, not placing. uuid={}", signed_order.order_uuid_str());
                                        metrics.swift_place_skipped.inc();
                                    } else {
                                        log::info!(target: TARGET, "swift order not fillable yet, placing on-chain. uuid={}", signed_order.order_uuid_str());
                                        let pf = priority_fee_subscriber.priority_fee_nth(0.6);
                                        try_swift_place(
                                            velocity,
                                            pf,
                                            config.swift_cu_limit,
                                            filler_subaccount,
                                            signed_order,
                                            slot,
                                            tx_worker_ref.clone(),
                                        ).await;
                                        metrics.swift_placed.inc();
                                    }
                                }
                                SwiftEval::Drop => {
                                    // malformed / unsupported; already logged in evaluate_swift_crosses
                                }
                            }
                        }
                        None => {
                            retries += 1;
                            if retries <= MAX_SWIFT_RECONNECT_RETRIES {
                                    let backoff = 2u64.pow(retries).min(30);
                                    log::warn!(target: "swift", "feed disconnected, retry {retries}/{MAX_SWIFT_RECONNECT_RETRIES} in {backoff}s");
                                    tokio::time::sleep(Duration::from_secs(backoff)).await;

                                    match velocity
                                        .subscribe_swift_orders(&market_ids, Some(true), None, None)
                                        .await
                                    {
                                        Ok(stream) => swift_order_stream = stream,
                                        Err(e) => {
                                            log::error!(target: "swift", "resubscribe failed: {e:?}");
                                            continue;
                                        }
                                    }
                                } else {
                                    log::error!(target: TARGET, "swift order stream finished after {MAX_SWIFT_RECONNECT_RETRIES} retries");
                                    break;
                                }
                        }
                    }
                }
                new_slot = slot_rx.recv() => {
                    if new_slot.is_none() {
                        log::error!(target: TARGET, "slot subscriber failed");
                        break;
                    }
                    slot = new_slot.expect("got slot update");
                    log::trace!(target: TARGET, "got slot update: {slot}");

                    let priority_fee = priority_fee_subscriber.priority_fee_nth(0.5) + slot % 2; // add entropy to produce unique tx hash on conseuctive tx resubmission
                    let t0 = std::time::SystemTime::now();
                    let unix_now = t0.duration_since(std::time::SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64;

                    // check for auction and limit crosses in all markets
                    for market in &market_ids {
                        let market_index = market.index();

                        let perp_market = velocity.try_get_perp_market_account(market_index).expect("got perp market");
                        let chain_oracle_data = velocity.try_get_mmoracle_for_perp_market(market_index, slot).expect("got oracle price");
                        log::debug!(target: "oracle", "oracle price: delay:{:?},market:{:?},oracle:{:?},amm:{:?}", chain_oracle_data.delay, market, chain_oracle_data.price, perp_market.market_stats.mm_oracle_price);
                        let oracle_stale_for_amm = chain_oracle_data.delay > slots_before_stale_for_amm;
                        log::debug!(target: TARGET, "oracle_stale_for_amm={} (delay={}, market={})", oracle_stale_for_amm, chain_oracle_data.delay, market_index);
                        let mut oracle_price = chain_oracle_data.price as u64;
                        let trigger_price = perp_market.get_trigger_price(oracle_price as i64, unix_now, use_median_trigger_price).unwrap_or(oracle_price);
                        let mut pyth_update = None;
                        if let Some(p) = pyth_oracle_prices.get(&market_index) {
                            if oracle_price != p.price {
                                oracle_price = p.price;
                                pyth_update = Some(p.clone());
                            }
                        }

                        let mut crosses_and_top_makers = dlob.find_crosses_for_auctions(market_index, MarketType::Perp, slot, oracle_price, Some(&perp_market), trigger_price, None);
                        crosses_and_top_makers.crosses.retain(|(o, _)| limiter.allow_event(slot, o.order_id));

                        // Trigger orders that already cross are triggered+filled atomically by
                        // the auction path below; capture their ids so the standalone trigger
                        // pass doesn't double-trigger (and waste) them. Keyed on the full
                        // (user, order_id) identity: order_id is a per-user counter, so a bare
                        // order_id collides across users and would wrongly suppress another
                        // user's trigger.
                        let crossing_trigger_ids: HashSet<(Pubkey, u32)> = crosses_and_top_makers
                            .crosses
                            .iter()
                            .filter(|(o, _)| matches!(o.kind, OrderKind::TriggerMarket | OrderKind::TriggerLimit))
                            .map(|(o, _)| (o.user, o.order_id))
                            .collect();

                        if !crosses_and_top_makers.crosses.is_empty() {
                            log::info!(target: TARGET, "found auction crosses. market: {},{crosses_and_top_makers:?}", market.index());
                            try_auction_fill(
                                velocity,
                                priority_fee,
                                config.fill_cu_limit,
                                market_index,
                                filler_subaccount,
                                crosses_and_top_makers,
                                tx_worker_ref.clone(),
                                pyth_update,
                                trigger_price,
                                move |maker_cross| {
                                    perp_market.has_too_much_drawdown().unwrap_or(false) && amm_wants_to_jit_make(&perp_market.amm, perp_market.order_step_size, maker_cross.taker_direction)
                                },
                                perp_market,
                                oracle_stale_for_amm,
                            ).await;
                        }

                        // Trigger-only pass: trigger orders whose condition is met but that do
                        // not (yet) cross any liquidity. `find_crosses_for_auctions` only
                        // surfaces trigger orders whose post-trigger price immediately crosses,
                        // so without this pass e.g. stop/take-profit *limit* orders that rest
                        // after triggering would never be triggered. The send path simulates
                        // first, so an order that isn't actually triggerable on-chain (oracle
                        // view drift) is dropped at simulation rather than wasting a real tx.
                        dlob.find_triggerable_orders(market_index, MarketType::Perp, trigger_price, &mut triggerable_buf);
                        if !triggerable_buf.is_empty() {
                            log::info!(target: TARGET, "found {} triggerable order(s) (market: {market_index})", triggerable_buf.len());
                        }
                        for (taker_subaccount, order_id) in triggerable_buf.drain(..) {
                            // already handled atomically by the auction fill above
                            if crossing_trigger_ids.contains(&(taker_subaccount, order_id)) {
                                continue;
                            }
                            // Rate-limit re-sends by the full (user, order_id) identity. The
                            // limiter keys on u32, so fold the user pubkey in to avoid colliding
                            // with another user's order_id (or an auction fill's bare order_id).
                            if !limiter.allow_event(slot, order_dedup_key(&taker_subaccount, order_id)) {
                                continue;
                            }
                            try_trigger_order(
                                velocity,
                                priority_fee,
                                config.trigger_cu_limit,
                                market_index,
                                filler_subaccount,
                                taker_subaccount,
                                order_id,
                                slot + 1,
                                tx_worker_ref.clone(),
                            ).await;
                        }

                        // ghetto rate limit
                        if slot % 2 == 0 {
                            if let Some(crosses) = dlob.find_crossing_region(oracle_price, market_index, MarketType::Perp, Some(&perp_market)) {
                                log::info!(target: TARGET, "found limit crosses (market: {market_index}), top bid: {:?}, top ask: {:?}", crosses.crossing_bids.first(), crosses.crossing_asks.first());
                                try_uncross(velocity, slot + 1, priority_fee, config.fill_cu_limit, market_index, filler_subaccount, crosses, &tx_worker_ref).await;
                            }
                        }

                        // check state config ~every minute
                        if slot % 300 == 0 {
                            use_median_trigger_price = velocity
                                .state_account()
                                .map(|s| s.has_median_trigger_price_feature())
                                .unwrap_or(false);
                            slots_before_stale_for_amm = velocity
                                .state_account()
                                .map(|s| s.oracle_guard_rails.validity.slots_before_stale_for_amm)
                                .unwrap_or(10);
                        }
                    }
                    let duration = std::time::SystemTime::now().duration_since(t0).unwrap().as_millis();
                    log::trace!(target: TARGET, "⏱️ checked fills at {slot}: {:?}ms", duration);
                }
                new_price = pyth_price_feed.recv() => {
                    match new_price {
                        Some(update) => {
                            pyth_oracle_prices.insert(update.market_id, update);
                        }
                        None => {
                            log::error!(target: TARGET, "pyth price feed disconnected, shutting down");
                            break;  // exits the loop
                        }
                    }
                }
            }
        }
        velocity.grpc_unsubscribe();
        log::info!(target: TARGET, "filler shutting down...");
    }
}

fn on_transaction_update_fn(
    tx_worker_ref: TxSender,
) -> impl Fn(&TransactionUpdate) + Send + Sync + 'static {
    move |tx: &TransactionUpdate| {
        if let Some(sig) = tx.transaction.signatures.first() {
            tx_worker_ref.confirm_tx((sig.as_slice().try_into()).expect("valid signature"));
        } else {
            log::warn!(target: TARGET, "received tx without sig: {tx:?}");
        }
    }
}

fn on_slot_update_fn(
    velocity: VelocityClient,
    market_ids: Vec<MarketId>,
    dlob_notifier: DLOBNotifier,
    slot_tx: tokio::sync::mpsc::Sender<u64>,
) -> impl Fn(u64) + Send + Sync + 'static {
    move |new_slot| {
        for market in market_ids.iter() {
            let oracle_price_data = velocity
                .try_get_mmoracle_for_perp_market(market.index(), new_slot)
                .unwrap();
            dlob_notifier.slot_and_oracle_update(*market, new_slot, oracle_price_data.price as u64);
        }
        if let Err(err) = slot_tx.try_send(new_slot) {
            log::debug!(target: TARGET, "failed slot update: {err:?}");
        }
    }
}

fn on_account_update_fn(
    dlob_notifier: DLOBNotifier,
    velocity: VelocityClient,
) -> impl Fn(&AccountUpdate) + Send + Sync + 'static {
    move |update| {
        let new_user = velocity_rs::utils::deser_zero_copy::<User>(update.data);
        if let Some(ref existing) = velocity
            .backend()
            .account_map()
            .account_data_and_slot::<User>(&update.pubkey)
        {
            if existing.slot <= update.slot {
                dlob_notifier.user_update(
                    update.pubkey,
                    Some(&existing.data),
                    &new_user,
                    update.slot,
                );
            } else {
                log::warn!(
                    "out of order user update: {} > {}",
                    existing.slot,
                    update.slot
                );
            }
        } else {
            dlob_notifier.user_update(update.pubkey, None, &new_user, update.slot);
        }
    }
}

/// Evaluate whether a swift order crosses resting liquidity / the vAMM at the current slot.
///
/// Returns `Some(crosses)` when the order is fillable right now, or `None` when it isn't (so
/// the caller can queue it for retry). This is the shared core used both on arrival and on
/// each retry tick, so the fill decision stays identical across the two paths.
///
/// `oracle_price` is the chain mm-oracle price (i64) for the market; `oracle_delay` its age in
/// slots, used to skip vAMM-only fills when the oracle is stale for the AMM.
fn evaluate_swift_crosses(
    dlob: &DLOB,
    signed_order: &SignedOrderInfo,
    perp_market: &PerpMarket,
    oracle_price: i64,
    oracle_delay: i64,
    slot: u64,
    slots_before_stale_for_amm: i64,
) -> SwiftEval {
    let mut order_params = signed_order.order_params();
    let _ = order_params.update_perp_auction_params(perp_market, oracle_price, true);

    if order_params.order_type == OrderType::Limit && order_params.post_only != PostOnlyParam::None
    {
        log::warn!(target: TARGET, "swift order limit post only: uuid={}", signed_order.order_uuid_str());
        // TODO: search for immediate fill
        return SwiftEval::Drop;
    }

    let (start_price, end_price, duration) = (
        order_params.auction_start_price.unwrap_or_default(),
        order_params.auction_end_price.unwrap_or_default(),
        order_params.auction_duration.unwrap_or_default(),
    );
    let order = Order {
        slot: slot + 1,
        price: order_params.price,
        base_asset_amount: order_params.base_asset_amount,
        trigger_price: order_params.trigger_price.unwrap_or_default(),
        auction_duration: duration,
        auction_start_price: start_price,
        auction_end_price: end_price,
        max_ts: order_params.max_ts.unwrap_or_default(),
        oracle_price_offset: order_params.oracle_price_offset.unwrap_or_default(),
        market_index: order_params.market_index,
        order_type: order_params.order_type,
        market_type: order_params.market_type,
        direction: order_params.direction,
        reduce_only: order_params.reduce_only,
        post_only: order_params.post_only != PostOnlyParam::None,
        immediate_or_cancel: order_params.immediate_or_cancel(),
        trigger_condition: order_params.trigger_condition,
        bit_flags: order_params.bit_flags,
        ..Default::default()
    };

    let reserve_price = perp_market.amm.reserve_price().unwrap_or(0);
    let vamm_price = if order_params.direction == PositionDirection::Long {
        perp_market
            .amm
            .ask_price(
                reserve_price,
                perp_market.amm.long_spread,
                perp_market.amm.reference_price_offset,
            )
            .unwrap_or(0)
    } else {
        perp_market
            .amm
            .bid_price(
                reserve_price,
                perp_market.amm.short_spread,
                perp_market.amm.reference_price_offset,
            )
            .unwrap_or(0)
    };

    let price = match order_params.order_type {
        OrderType::Market | OrderType::Oracle => {
            match calculate_auction_price(
                &order,
                slot + 1,
                perp_market.price_tick(),
                Some(oracle_price),
            ) {
                Ok(p) => p,
                Err(err) => {
                    log::warn!(target: TARGET, "could not get auction price {err:?}, params: {order_params:?}, dropping...");
                    return SwiftEval::Drop;
                }
            }
        }
        OrderType::Limit => {
            match order.get_limit_price(
                Some(oracle_price),
                Some(vamm_price),
                slot + 1,
                perp_market.price_tick(),
            ) {
                Ok(Some(p)) => p,
                _ => {
                    log::warn!(target: TARGET, "could not get limit price: {order_params:?}, dropping...");
                    return SwiftEval::Drop;
                }
            }
        }
        // Swift orders should never be trigger/unknown types; previously this panicked via
        // `unreachable!()`. Defensively drop instead so untrusted feed input can't crash the bot.
        other => {
            log::warn!(target: TARGET, "unsupported swift order type {other:?}, dropping. uuid={}", signed_order.order_uuid_str());
            return SwiftEval::Drop;
        }
    };

    let taker_order = TakerOrder::from_order_params(order_params, price);
    let crosses = dlob.find_crosses_for_taker_order(
        slot + 1,
        oracle_price as u64,
        taker_order,
        Some(perp_market),
        None,
    );
    // Well-formed but not (yet) fillable -> NotFillable, so the caller can place it on-chain.
    if crosses.is_empty() {
        return SwiftEval::NotFillable;
    }
    // vAMM-only cross with a stale oracle: don't fill against the vAMM now, but the order is
    // still well-formed, so let the caller place it (it may fill once the oracle refreshes).
    if crosses.orders.is_empty()
        && crosses.has_vamm_cross
        && oracle_delay > slots_before_stale_for_amm
    {
        log::info!(target: TARGET, "skip swift vAMM fill: oracle stale (delay={oracle_delay})");
        return SwiftEval::NotFillable;
    }
    SwiftEval::Fillable(crosses)
}

/// Outcome of evaluating a swift order against current liquidity.
enum SwiftEval {
    /// Crosses resting liquidity / vAMM right now: fill it immediately.
    Fillable(MakerCrosses),
    /// Well-formed but not marketable yet: place it on-chain so the slot loop can fill it later.
    NotFillable,
    /// Malformed / unsupported (bad price, post-only limit, non-market/limit type): drop it.
    Drop,
}

/// Trigger a single trigger order whose condition is met but that does not yet cross.
///
/// Sends a standalone `trigger_order` tx (no fill). The triggered order then becomes a regular
/// on-chain order that the normal per-slot auction-fill path will pick up. Failures to load the
/// accounts are logged and skipped rather than panicking.
async fn try_trigger_order(
    velocity: &'static VelocityClient,
    priority_fee: u64,
    cu_limit: u32,
    market_index: u16,
    filler_subaccount: Pubkey,
    taker_subaccount: Pubkey,
    order_id: u32,
    slot: u64,
    tx_worker_ref: TxSender,
) {
    let filler_account_data = match velocity.try_get_account::<User>(&filler_subaccount) {
        Ok(a) => a,
        Err(err) => {
            log::warn!(target: TARGET, "trigger: failed to load filler account: {err:?}");
            return;
        }
    };
    let taker_account_data = match velocity.try_get_account::<User>(&taker_subaccount) {
        Ok(a) => a,
        Err(err) => {
            log::warn!(target: TARGET, "trigger: failed to load taker account {taker_subaccount}: {err:?}");
            return;
        }
    };

    log::info!(target: TARGET, "attempting standalone trigger: order_id={order_id}, taker={taker_subaccount}");
    let tx_builder = TransactionBuilder::new(
        velocity.program_data(),
        filler_subaccount,
        std::borrow::Cow::Borrowed(&filler_account_data),
        false,
    )
    .with_priority_fee(priority_fee, Some(cu_limit))
    .trigger_order(
        taker_subaccount,
        &taker_account_data,
        order_id,
        (market_index, MarketType::Perp),
    );
    let tx = tx_builder.build();

    tx_worker_ref
        .send_tx(
            tx,
            TxIntent::Trigger {
                market_index,
                order_id,
                slot,
            },
            cu_limit as u64,
        )
        .await;
}

/// Try to fill a swift order
async fn try_swift_fill(
    velocity: &'static VelocityClient,
    priority_fee: u64,
    cu_limit: u32,
    filler_subaccount: Pubkey,
    swift_order: SignedOrderInfo,
    crosses: MakerCrosses,
    tx_worker_ref: TxSender,
) {
    log::info!(target: TARGET, "try fill swift order: {}", swift_order.order_uuid_str());
    let taker_order = swift_order.order_params();
    let taker_subaccount = swift_order.taker_subaccount();
    let taker_authority = swift_order.taker_authority;

    let filler_account_data = velocity
        .try_get_account::<User>(&filler_subaccount)
        .expect("filler account");
    let taker_stats = Wallet::derive_stats_account(&taker_authority);
    let (taker_account_data, taker_stats) = tokio::try_join!(
        velocity.get_account_value::<User>(&taker_subaccount),
        velocity.get_account_value::<UserStats>(&taker_stats)
    )
    .unwrap();
    let tx_builder = TransactionBuilder::new(
        velocity.program_data(),
        filler_subaccount,
        std::borrow::Cow::Borrowed(&filler_account_data),
        false,
    );

    let maker_accounts: Vec<User> = crosses
        .orders
        .iter()
        .filter(|m| m.0.user != taker_subaccount) // can't fill itself
        .map(|(m, _fill_size)| {
            velocity
                .try_get_account::<User>(&m.user)
                .expect("maker account syncd")
        })
        .collect();

    if maker_accounts.is_empty() && !crosses.has_vamm_cross {
        log::warn!("invalid cross: {crosses:?}");
        return;
    }

    // let taker_order_id = taker_account_data.next_order_id;
    let mut tx_builder = tx_builder
        .with_priority_fee(priority_fee, Some(cu_limit))
        .place_swift_order(&swift_order, &taker_account_data)
        .fill_perp_order(
            taker_order.market_index,
            taker_subaccount,
            &taker_account_data,
            &taker_stats,
            None, // Some(taker_order_id), // assuming we're fast enough that its the taker_order_id, should be ok for retail
            maker_accounts.as_slice(),
            Some(swift_order.has_builder()),
        );

    // large accounts list, bump CU limit to compensate
    if let Some(ix) = tx_builder.ixs().last() {
        if ix.accounts.len() >= 30 {
            tx_builder = tx_builder.set_ix(
                1,
                ComputeBudgetInstruction::set_compute_unit_limit(cu_limit * 2),
            );
        }
    }
    let tx = tx_builder.build();

    tx_worker_ref
        .send_tx(
            tx,
            TxIntent::SwiftFill {
                uuid: swift_order.order_uuid(),
                market_index: taker_order.market_index,
                maker_crosses: crosses,
            },
            cu_limit as u64,
        )
        .await;
}

/// Place a swift order on-chain without filling it.
///
/// Used when the order is not immediately fillable on arrival: placing it makes it a regular
/// resting on-chain order that the normal per-slot fill path (and other keepers) can fill while
/// it remains live, instead of dropping it. Emits a `swift_place` wide event at tx
/// confirmation so the gas spent on placements can be measured against the fills they yield.
async fn try_swift_place(
    velocity: &'static VelocityClient,
    priority_fee: u64,
    cu_limit: u32,
    filler_subaccount: Pubkey,
    swift_order: SignedOrderInfo,
    slot: u64,
    tx_worker_ref: TxSender,
) {
    let market_index = swift_order.order_params().market_index;
    let taker_subaccount = swift_order.taker_subaccount();

    let filler_account_data = match velocity.try_get_account::<User>(&filler_subaccount) {
        Ok(a) => a,
        Err(err) => {
            log::warn!(target: TARGET, "swift place: failed to load filler account: {err:?}");
            return;
        }
    };
    let taker_account_data = match velocity.get_account_value::<User>(&taker_subaccount).await {
        Ok(a) => a,
        Err(err) => {
            log::warn!(target: TARGET, "swift place: failed to load taker account {taker_subaccount}: {err:?}");
            return;
        }
    };

    let tx = TransactionBuilder::new(
        velocity.program_data(),
        filler_subaccount,
        std::borrow::Cow::Borrowed(&filler_account_data),
        false,
    )
    .with_priority_fee(priority_fee, Some(cu_limit))
    .place_swift_order(&swift_order, &taker_account_data)
    .build();

    tx_worker_ref
        .send_tx(
            tx,
            TxIntent::SwiftPlace {
                uuid: swift_order.order_uuid(),
                market_index,
                slot,
            },
            cu_limit as u64,
        )
        .await;
}

/// Try to fill an auction order
///
/// - `auction_crosses` list of one or more crosses to fill
async fn try_auction_fill(
    velocity: &'static VelocityClient,
    priority_fee: u64,
    cu_limit: u32,
    market_index: u16,
    filler_subaccount: Pubkey,
    auction_crosses: CrossesAndTopMakers,
    tx_worker_ref: TxSender,
    oracle_update: Option<PythPriceUpdate>,
    trigger_price: u64,
    is_vamm_inactive: impl Fn(&MakerCrosses) -> bool,
    perp_market: PerpMarket,
    oracle_stale_for_amm: bool,
) {
    let filler_account_data = velocity
        .try_get_account::<User>(&filler_subaccount)
        .expect("filler account");

    let top_maker_asks: Vec<User> = auction_crosses
        .top_maker_asks
        .iter()
        .map(|m| {
            velocity
                .try_get_account::<User>(m)
                .expect("maker account syncd")
        })
        .collect();

    let top_maker_bids: Vec<User> = auction_crosses
        .top_maker_bids
        .iter()
        .map(|m| {
            velocity
                .try_get_account::<User>(m)
                .expect("maker account syncd")
        })
        .collect();
    let mut sent_oracle_update = false;
    for (taker_order, crosses) in auction_crosses.crosses {
        log::info!(target: TARGET, "try fill auction order: {taker_order:?}");
        let taker_subaccount = taker_order.user;

        let taker_account_data = velocity
            .try_get_account::<User>(&taker_subaccount)
            .expect("taker account");

        let taker_stats = velocity.try_get_account::<UserStats>(&Wallet::derive_stats_account(
            &taker_account_data.authority,
        ));

        if taker_stats.is_err() {
            log::warn!(target: TARGET, "failed to fetch taker stats: {:?}", taker_account_data.authority);
            continue;
        }

        let mut tx_builder = TransactionBuilder::new(
            velocity.program_data(),
            filler_subaccount,
            std::borrow::Cow::Borrowed(&filler_account_data),
            false,
        );

        tx_builder = tx_builder.with_priority_fee(priority_fee, Some(cu_limit));

        if let Some(ref update_msg) = oracle_update {
            if !sent_oracle_update {
                tx_builder = tx_builder
                    .post_pyth_lazer_oracle_update(&[update_msg.feed_id], &update_msg.message);
                sent_oracle_update = true;
            }
        }

        let taker_is_trigger = matches!(
            taker_order.kind,
            OrderKind::TriggerMarket | OrderKind::TriggerLimit
        );
        if taker_is_trigger {
            // The order may have been triggered/filled/cancelled between the DLOB snapshot and
            // this fetch; skip rather than panic the run loop.
            let actual_order = match taker_account_data
                .orders
                .iter()
                .find(|o| o.order_id == taker_order.order_id)
            {
                Some(o) => o,
                None => {
                    log::debug!(target: TARGET, "trigger order {} gone before fill, skipping", taker_order.order_id);
                    continue;
                }
            };

            let trigger_above = matches!(
                actual_order.trigger_condition,
                OrderTriggerCondition::Above | OrderTriggerCondition::TriggeredAbove
            );

            let can_trigger = if trigger_above && trigger_price > actual_order.trigger_price {
                true
            } else if !trigger_above && trigger_price < actual_order.trigger_price {
                true
            } else {
                false
            };
            if !can_trigger {
                continue;
            }
            log::info!(
                target: TARGET,
                "attempting trigger and fill: trigger_price={trigger_price}, order_price={}, {:?}/{:?}",
                actual_order.trigger_price,
                taker_order.order_id,
                taker_order.user
            );
            tx_builder = tx_builder.trigger_order(
                taker_subaccount,
                &taker_account_data,
                taker_order.order_id,
                (market_index, MarketType::Perp),
            );
        }

        let mut maker_accounts: Vec<User> = crosses
            .orders
            .iter()
            .filter(|m| m.0.user != taker_subaccount) // can't fill itself
            // drop makers not yet in cache rather than panicking; a missing maker just
            // shrinks the cross (handled by the empty-cross check below)
            .filter_map(|(m, _fill_size)| velocity.try_get_account::<User>(&m.user).ok())
            .collect();

        let effective_vamm_cross = crosses.has_vamm_cross && !oracle_stale_for_amm;
        if effective_vamm_cross {
            if is_vamm_inactive(&crosses) {
                log::debug!(target: TARGET, "skip inactive vamm cross: {crosses:?}");
                continue;
            }

            if let (Ok(pos), Some(order)) = (
                taker_account_data.get_perp_position(market_index),
                taker_account_data
                    .orders
                    .iter()
                    .find(|o| o.order_id == taker_order.order_id),
            ) {
                if let Ok((base_asset_amount, _limit_price)) =
                    velocity_rs::program::math::orders::calculate_base_asset_amount_for_amm_to_fulfill(
                        order,
                        &perp_market,
                        None,
                        None,
                        pos.base_asset_amount,
                        &FeeTier::default(),
                    )
                {
                    // if user position is less than min order size, step size is the threshold
                    let amm_size_threshold = if !taker_order.is_reduce_only()
                        && pos.base_asset_amount.unsigned_abs()
                            > perp_market.market_stats.min_order_size
                    {
                        perp_market.market_stats.min_order_size
                    } else {
                        perp_market.order_step_size
                    };
                    if base_asset_amount < amm_size_threshold {
                        log::info!(target: TARGET, "skip vamm cross too small: {crosses:?}");
                        continue;
                    }
                }
            }
        }
        if !effective_vamm_cross && maker_accounts.is_empty() {
            if oracle_stale_for_amm && crosses.has_vamm_cross {
                log::info!(target: TARGET, "skip vAMM fill: oracle stale for AMM (market={market_index})");
            } else {
                log::debug!(target: TARGET, "skip empty maker cross: {crosses:?}");
            }
            continue;
        }

        if maker_accounts.len() < 3 {
            if crosses.taker_direction == PositionDirection::Long {
                maker_accounts = top_maker_asks.clone();
            } else {
                maker_accounts = top_maker_bids.clone();
            }
        }

        tx_builder = tx_builder.fill_perp_order(
            market_index,
            taker_subaccount,
            &taker_account_data,
            &taker_stats.unwrap(),
            Some(taker_order.order_id),
            maker_accounts.as_slice(),
            None,
        );

        // large accounts list, bump CU limit to compensate
        if let Some(ix) = tx_builder.ixs().last() {
            if ix.accounts.len() >= 20 {
                tx_builder = tx_builder.set_ix(
                    1,
                    ComputeBudgetInstruction::set_compute_unit_limit(cu_limit * 2),
                );
            }
        }

        let tx = tx_builder.build();

        tx_worker_ref
            .send_tx(
                tx,
                TxIntent::AuctionFill {
                    market_index,
                    taker_order_id: taker_order.order_id,
                    maker_crosses: crosses,
                    has_trigger: taker_is_trigger,
                },
                cu_limit as u64,
            )
            .await;
    }
}

/// Try to uncross top of book
///
/// - `crosses` list of one or more crosses to fill
async fn try_uncross(
    velocity: &VelocityClient,
    slot: u64,
    priority_fee: u64,
    cu_limit: u32,
    market_index: u16,
    filler_subaccount: Pubkey,
    crosses: CrossingRegion,
    tx_worker_ref: &TxSender,
) {
    let filler_account_data = velocity
        .try_get_account::<User>(&filler_subaccount)
        .expect("filler account");

    let best_bid = &crosses.crossing_bids.first();
    let best_ask = &crosses.crossing_asks.first();

    if best_bid.is_none() || best_ask.is_none() {
        return;
    }

    let best_bid = best_bid.unwrap();
    let best_ask = best_ask.unwrap();

    let maker_asks: Vec<User> = crosses
        .crossing_asks
        .iter()
        .take(3)
        .filter_map(|x| {
            let maker = x.user;
            if maker != best_bid.user {
                velocity.try_get_account::<User>(&maker).ok()
            } else {
                None
            }
        })
        .collect();

    let maker_bids: Vec<User> = crosses
        .crossing_bids
        .iter()
        .take(3)
        .filter_map(|x| {
            let maker = x.user;
            if maker != best_ask.user {
                velocity.try_get_account::<User>(&maker).ok()
            } else {
                None
            }
        })
        .collect();

    log::info!(target: TARGET, "try uncross book={market_index},slot={slot}");
    log::debug!(
        target: TARGET,
        "X asks: {:?}, X bids: {:?}",
        &crosses.crossing_asks.iter().take(3),
        &crosses.crossing_bids.iter().take(3),
    );

    // try valid combinations of taker/maker with all crossing asks/bids
    for (taker_order, makers) in [(best_ask, maker_bids), (best_bid, maker_asks)] {
        if taker_order.is_post_only() {
            continue;
        }

        if makers.is_empty() {
            log::debug!(target: TARGET, "no makers to uncross");
            continue;
        }

        let taker_order_id = taker_order.order_id;
        let taker_subaccount = taker_order.user;
        let taker_account_data = velocity
            .try_get_account::<User>(&taker_subaccount)
            .expect("taker account");

        let taker_stats = velocity.try_get_account::<UserStats>(&Wallet::derive_stats_account(
            &taker_account_data.authority,
        ));
        if taker_stats.is_err() {
            log::warn!(target: TARGET, "failed to fetch taker stats: {:?}", taker_account_data.authority);
            continue;
        }

        let mut tx_builder = TransactionBuilder::new(
            velocity.program_data(),
            filler_subaccount,
            std::borrow::Cow::Borrowed(&filler_account_data),
            false,
        );
        tx_builder = tx_builder
            .with_priority_fee(priority_fee, Some(cu_limit))
            .fill_perp_order(
                market_index,
                taker_subaccount,
                &taker_account_data,
                &taker_stats.unwrap(),
                Some(taker_order_id),
                makers.as_slice(),
                None,
            );

        // large accounts list, bump CU limit to compensate
        if let Some(ix) = tx_builder.ixs().last() {
            if ix.accounts.len() >= 40 {
                tx_builder = tx_builder.set_ix(
                    1,
                    ComputeBudgetInstruction::set_compute_unit_limit((cu_limit * 25) / 10),
                );
            }
        }
        let tx = tx_builder.build();

        tx_worker_ref
            .send_tx(
                tx,
                TxIntent::LimitUncross {
                    slot,
                    market_index,
                    taker_order_id,
                    maker_order_id: 0,
                },
                cu_limit as u64,
            )
            .await;
    }
}

/// Fold a `(user, order_id)` pair into a single u32 for the `OrderSlotLimiter` (which keys on
/// u32). `order_id` is a per-user counter, so a bare order_id collides across users; mixing in
/// the user pubkey prefix makes cross-user collisions negligible.
fn order_dedup_key(user: &Pubkey, order_id: u32) -> u32 {
    let b = user.to_bytes();
    u32::from_le_bytes([b[0], b[1], b[2], b[3]]) ^ order_id
}

fn amm_wants_to_jit_make(
    amm: &AMM,
    order_step_size: u64,
    taker_direction: PositionDirection,
) -> bool {
    let amm_wants_to_jit_make = match taker_direction {
        PositionDirection::Long => amm.base_asset_amount_with_amm < -(order_step_size as i128),
        PositionDirection::Short => amm.base_asset_amount_with_amm > order_step_size as i128,
    };
    amm_wants_to_jit_make && amm.amm_jit_intensity > 0
}

/// Setup gRPC subscriptions
///
/// Syncs User orders and UserStat accounts
pub async fn setup_grpc(
    velocity: VelocityClient,
    dlob: &'static DLOB,
    tx_worker_ref: TxSender,
    market_ids: Vec<MarketId>,
) -> tokio::sync::mpsc::Receiver<u64> {
    let dlob_notifier = dlob.spawn_notifier();

    let _ = tokio::try_join!(
        sync_stats_accounts(&velocity),
        sync_user_accounts(&velocity, &dlob_notifier),
    );

    let (slot_tx, slot_rx) = tokio::sync::mpsc::channel(64);

    subscribe_grpc(velocity, dlob_notifier, slot_tx, tx_worker_ref, market_ids).await;

    slot_rx
}

pub async fn sync_stats_accounts(
    velocity: &VelocityClient,
) -> Result<(), solana_rpc_client_api::client_error::Error> {
    let stats_sync_result = velocity
        .rpc()
        .get_program_accounts_with_config(
            &PROGRAM_ID,
            RpcProgramAccountsConfig {
                filters: Some(vec![velocity_rs::memcmp::get_user_stats_filter()]),
                account_config: RpcAccountInfoConfig {
                    encoding: Some(UiAccountEncoding::Base64Zstd),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .await;

    match stats_sync_result {
        Ok(accounts) => {
            for (pubkey, account) in accounts {
                velocity.backend().account_map().on_account_fn()(&AccountUpdate {
                    pubkey,
                    data: &account.data,
                    lamports: account.lamports,
                    owner: PROGRAM_ID,
                    rent_epoch: u64::MAX,
                    executable: false,
                    slot: 0,
                    write_version: 0,
                });
            }
            log::info!(target: "dlob", "syncd stats accounts");
            Ok(())
        }
        Err(err) => {
            log::error!(target: "dlob", "dlob sync error: {err:?}");
            Err(err)
        }
    }
}

pub async fn sync_user_accounts(
    velocity: &VelocityClient,
    dlob_notifier: &DLOBNotifier,
) -> Result<(), solana_rpc_client_api::client_error::Error> {
    let sync_result = velocity
        .rpc()
        .get_program_accounts_with_config(
            &PROGRAM_ID,
            RpcProgramAccountsConfig {
                filters: Some(vec![
                    velocity_rs::memcmp::get_non_idle_user_filter(),
                    velocity_rs::memcmp::get_user_filter(),
                ]),
                account_config: RpcAccountInfoConfig {
                    encoding: Some(UiAccountEncoding::Base64Zstd),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .await;

    match sync_result {
        Ok(accounts) => {
            for (pubkey, account) in accounts {
                let user = velocity_rs::utils::deser_zero_copy::<User>(&account.data);
                dlob_notifier.user_update(pubkey, None, &user, 0);
                velocity.backend().account_map().on_account_fn()(&AccountUpdate {
                    pubkey,
                    data: &account.data,
                    lamports: account.lamports,
                    owner: PROGRAM_ID,
                    rent_epoch: u64::MAX,
                    executable: false,
                    slot: 0,
                    write_version: 0,
                });
            }
            log::info!(target: "dlob", "synced initial orders");
            Ok(())
        }
        Err(err) => {
            log::error!(target: "dlob", "dlob sync error: {err:?}");
            Err(err)
        }
    }
}

async fn subscribe_grpc(
    velocity: VelocityClient,
    dlob_notifier: DLOBNotifier,
    slot_tx: tokio::sync::mpsc::Sender<u64>,
    transaction_tx: TxSender,
    market_ids: Vec<MarketId>,
) {
    let _res = velocity
        .grpc_subscribe(
            std::env::var("GRPC_ENDPOINT")
                .unwrap_or_else(|_| "https://api.rpcpool.com".to_string())
                .into(),
            std::env::var("GRPC_X_TOKEN").expect("GRPC_X_TOKEN set"),
            GrpcSubscribeOpts::default()
                .commitment(solana_commitment_config::CommitmentLevel::Processed)
                .connection_opts(GrpcConnectionOpts::default().enable_compression())
                .usermap_on()
                .statsmap_on()
                .transaction_include_accounts(vec![velocity.wallet().default_sub_account()])
                .on_transaction(on_transaction_update_fn(transaction_tx.clone()))
                .on_slot(on_slot_update_fn(
                    velocity.clone(),
                    market_ids,
                    dlob_notifier.clone(),
                    slot_tx.clone(),
                ))
                .on_account(
                    AccountFilter::partial().with_discriminator(User::DISCRIMINATOR),
                    on_account_update_fn(dlob_notifier.clone(), velocity.clone()),
                ),
            true,
        )
        .await;
}

pub enum TxWork {
    Send {
        tx: VersionedTransaction,
        ts: u64,
        intent: TxIntent,
        cu_limit: u64,
    },
    Confirm {
        tx: Signature,
        ts: u64,
    },
}

pub struct TxWorker {
    velocity: &'static VelocityClient,
    pending_txs: Arc<RwLock<PendingTxs<1024>>>,
    metrics: Arc<Metrics>,
    dry_run: bool,
    txs_in_flight: Option<Arc<DashMap<Pubkey, HashSet<Signature>>>>,
    tx_sig_to_collateral: Option<Arc<DashMap<Signature, (u128, u64)>>>,
    free_collateral_per_subaccount: Option<Arc<DashMap<Pubkey, u128>>>,
}

impl TxWorker {
    pub fn new(
        velocity: VelocityClient,
        metrics: Arc<Metrics>,
        dry_run: bool,
        txs_in_flight: Option<Arc<DashMap<Pubkey, HashSet<Signature>>>>,
        tx_sig_to_collateral: Option<Arc<DashMap<Signature, (u128, u64)>>>,
        free_collateral_per_subaccount: Option<Arc<DashMap<Pubkey, u128>>>,
    ) -> Self {
        Self {
            velocity: Box::leak(Box::new(velocity)),
            pending_txs: Arc::new(RwLock::new(PendingTxs::new())),
            metrics,
            dry_run,
            txs_in_flight,
            tx_sig_to_collateral,
            free_collateral_per_subaccount,
        }
    }

    pub fn run(self, rt: tokio::runtime::Handle) -> TxSender {
        let (tx, rx) = crossbeam::channel::bounded(1024);
        let velocity = self.velocity;
        std::thread::spawn(move || {
            let _ = env_logger::try_init();
            while let Ok(work) = rx.recv() {
                match work {
                    TxWork::Send {
                        tx,
                        ts: _,
                        intent,
                        cu_limit,
                    } => {
                        if self.dry_run {
                            log::debug!(target: TARGET, "skip tx dry run: {intent:?}");
                            continue;
                        }
                        self.send_tx(&rt, tx, intent, cu_limit);
                    }
                    TxWork::Confirm { tx, ts: _ } => {
                        self.confirm_tx(&rt, tx);
                    }
                }
            }
        });
        TxSender { tx, velocity }
    }

    fn send_tx(
        &self,
        rt: &Handle,
        signed_tx: VersionedTransaction,
        intent: TxIntent,
        cu_limit: u64,
    ) {
        log::debug!(target: TARGET, "txworker send tx: {intent:?}");
        let velocity = self.velocity;
        let pending_txs = Arc::clone(&self.pending_txs);
        let metrics = self.metrics.clone();
        let intent_label = intent.label();

        metrics.tx_sent.with_label_values(&[intent_label]).inc();
        metrics
            .fill_expected
            .with_label_values(&[intent_label])
            .inc();
        if intent.expected_trigger() {
            metrics.trigger_expected.inc();
        }

        rt.spawn(async move {
            // simulate first
            match velocity.simulate_tx(signed_tx.message.clone()).await {
                Ok(sim_result) => {
                    if let Some(err) = sim_result.err {
                        log::warn!(
                            target: TARGET,
                            "sim failed: {err:?}, intent: {intent_label}, liquidatee: {:?}, slot: {:?}",
                            intent.liquidatee(),
                            intent.slot()
                        );
                        // Log simulation logs for liquidation intents to help diagnose failures
                        if intent.is_liquidation() {
                            if let Some(logs) = sim_result.logs {
                                for log_line in &logs {
                                    if log_line.contains("Error") || log_line.contains("error") || log_line.contains("failed") || log_line.contains("Program log:") {
                                        log::warn!(target: TARGET, "  sim log: {}", log_line);
                                    }
                                }
                            }
                        }
                        metrics
                            .tx_failed
                            .with_label_values(&[intent_label, "sim_failed"])
                            .inc();
                        emit_tx_event(
                            &intent,
                            None,
                            "sim_failed",
                            intent.crosses_and_slot().1,
                            None,
                            intent.expected_fill_count(),
                            0,
                            false,
                            cu_limit,
                            None,
                            None,
                            Some(&format!("{err:?}")),
                        );
                        return;
                    }
                }
                Err(err) => {
                    log::warn!(
                        target: TARGET,
                        "sim rpc error: {err}, intent: {intent_label}, liquidatee: {:?}",
                        intent.liquidatee()
                    );
                    metrics
                        .tx_failed
                        .with_label_values(&[intent_label, "sim_rpc_error"])
                        .inc();
                    emit_tx_event(
                        &intent,
                        None,
                        "sim_rpc_error",
                        intent.crosses_and_slot().1,
                        None,
                        intent.expected_fill_count(),
                        0,
                        false,
                        cu_limit,
                        None,
                        None,
                        Some(&format!("{err}")),
                    );
                    return;
                }
            }

            let config = RpcSendTransactionConfig {
                skip_preflight: true,
                max_retries: Some(0),
                ..Default::default()
            };

            match velocity
                .rpc()
                .send_transaction_with_config(&signed_tx, config)
                .await
            {
                Ok(sig) => {
                    log::info!(
                        target: TARGET,
                        r#"{{"intent": "{}", "txn": "{}", "observed_slot": {}}}"#,
                        intent_label,
                        sig,
                        intent.slot().unwrap_or(0)
                    );
                    let mut pending = pending_txs.write().await;
                    pending.insert(PendingTxMeta::new(sig, intent, cu_limit));
                }
                Err(err) => {
                    log::info!(target: TARGET, "fill failed 🐢: {err}");
                    metrics
                        .tx_failed
                        .with_label_values(&[intent_label, "send_error"])
                        .inc();
                    emit_tx_event(
                        &intent,
                        None,
                        "send_error",
                        intent.crosses_and_slot().1,
                        None,
                        intent.expected_fill_count(),
                        0,
                        false,
                        cu_limit,
                        None,
                        None,
                        Some(&format!("{err}")),
                    );
                }
            }
        });
    }

    fn confirm_tx(&self, rt: &Handle, tx: Signature) {
        // TODO: if CU limit is too low send it again with higher amount
        log::debug!(target: TARGET, "txworker confirm tx: {tx:?}");
        let velocity = self.velocity;
        let pending_txs = Arc::clone(&self.pending_txs);
        let metrics = self.metrics.clone();

        let txs_in_flight = self.txs_in_flight.clone();
        let tx_sig_to_collateral = self.tx_sig_to_collateral.clone();
        let free_collateral = self.free_collateral_per_subaccount.clone();

        rt.spawn(async move {
            let pending_tx_meta = {
                let mut pending = pending_txs.write().await;
                pending.confirm(&tx)
            };
            if pending_tx_meta.is_none() {
                return;
            }
            let PendingTxMeta {
                signature,
                intent,
                cu_limit: sent_cu_limit,
                ts: _,
            } = pending_tx_meta.unwrap();

            let intent_label = intent.label();
            let expected_fill_count = intent.expected_fill_count();
            let (_, sent_slot) = intent.crosses_and_slot();
            let _ = tokio::time::sleep(Duration::from_secs(1)).await;
            match velocity
                .rpc()
                .get_transaction_with_config(
                    &tx,
                    RpcTransactionConfig {
                        encoding: Some(UiTransactionEncoding::Base64),
                        commitment: Some(CommitmentConfig::confirmed()),
                        max_supported_transaction_version: Some(0),
                    },
                )
                .await
            {
                Ok(tx_log) => {
                    if let Some(meta) = tx_log.transaction.meta {
                        match meta.err.map(TransactionError::from) {
                            None => {
                                // tx confirmed ok
                                let sig = tx.to_string();
                                let logs = meta.log_messages.unwrap();
                                let tx_confirmed_slot = tx_log.slot;
                                let mut actual_fills = 0;
                                let mut triggered = false;
                                for (tx_idx, log) in logs.iter().enumerate() {
                                    if let Some(event) = velocity_rs::event_subscriber::try_parse_log(
                                        log.as_str(),
                                        &sig,
                                        tx_idx,
                                    ) {
                                        if let VelocityEvent::OrderFill { ..} = event
                                        {
                                            actual_fills += 1;
                                        } else if let VelocityEvent::OrderTrigger { .. } = event {
                                            triggered = true;
                                            metrics.trigger_actual.inc();
                                        } else if log.as_str().contains("exceeded CUs meter") {
                                            metrics
                                            .tx_failed
                                            .with_label_values(&[
                                                intent_label,
                                                "insufficient_cus",
                                            ])
                                            .inc();
                                        }
                                    }
                                }
                                let confirmation_slots = tx_confirmed_slot - sent_slot;
                                log::debug!(target: TARGET, "txworker: {tx:?} confirmed after {confirmation_slots} slots");
                                metrics
                                    .fill_actual
                                    .with_label_values(&[intent_label])
                                    .inc();
                                metrics
                                    .confirmation_slots
                                    .with_label_values(&[intent_label])
                                    .observe(confirmation_slots as f64);
                                let cu_consumed: Option<u64> =
                                    meta.compute_units_consumed.clone().into();
                                let cus_spent = sent_cu_limit - cu_consumed.unwrap_or(0);
                                metrics
                                    .cu_spent
                                    .with_label_values(&[intent_label])
                                    .observe(cus_spent as f64);

                                // For placement/trigger intents, success is not measured by
                                // fills, so don't mislabel them "no_fills". Detect the program's
                                // silent no-ops (uuid dedup / past placement window for a swift
                                // place; already-triggered for a trigger) so wasted gas is
                                // distinguishable from a real placement/trigger in the events.
                                let status = if expected_fill_count == 0 {
                                    match &intent {
                                        TxIntent::SwiftPlace { .. } => {
                                            if logs.iter().any(|l| l.contains("already exists")) {
                                                "place_noop_dup"
                                            } else if logs.iter().any(|l| l.contains("max_slot")) {
                                                "place_noop_expired"
                                            } else {
                                                "placed"
                                            }
                                        }
                                        TxIntent::Trigger { .. } => {
                                            if triggered {
                                                "triggered"
                                            } else {
                                                "trigger_noop"
                                            }
                                        }
                                        _ => "ok",
                                    }
                                } else if actual_fills == 0 {
                                    "no_fills"
                                } else if actual_fills < expected_fill_count as u64 {
                                    "partial"
                                } else {
                                    "ok"
                                };
                                metrics
                                    .tx_confirmed
                                    .with_label_values(&[intent_label, status])
                                    .inc();

                                emit_tx_event(
                                    &intent,
                                    Some(&sig),
                                    status,
                                    sent_slot,
                                    Some(tx_confirmed_slot),
                                    expected_fill_count,
                                    actual_fills,
                                    triggered,
                                    sent_cu_limit,
                                    cu_consumed,
                                    Some(meta.fee),
                                    None,
                                );

                                match intent {
                                    TxIntent::LiquidateWithFill { .. } => {
                                        metrics.liquidation_success.with_label_values(&["perp"]).inc();
                                    }
                                    TxIntent::LiquidateSpot { .. } => {
                                        metrics.liquidation_success.with_label_values(&["spot"]).inc();
                                    }
                                    _ => {}
                                }
                            }
                            Some(
                                TransactionError::InsufficientFundsForFee
                                | TransactionError::InsufficientFundsForRent { .. },
                            ) => {
                                log::error!(target: TARGET, "bot needs more SOL!");
                                metrics
                                    .tx_failed
                                    .with_label_values(&[
                                        intent_label,
                                        "insufficient_funds",
                                    ])
                                    .inc();
                                emit_tx_event(
                                    &intent,
                                    Some(&tx.to_string()),
                                    "insufficient_funds",
                                    sent_slot,
                                    Some(tx_log.slot),
                                    expected_fill_count,
                                    0,
                                    false,
                                    sent_cu_limit,
                                    meta.compute_units_consumed.clone().into(),
                                    Some(meta.fee),
                                    None,
                                );
                            }
                            Some(err) => {
                                log::warn!(
                                    target: TARGET,
                                    "tx failed: {err:?}, intent: {intent_label}, liquidatee: {:?}, sig: {signature}",
                                    intent.liquidatee()
                                );
                                // Log program logs from failed liquidation txs
                                if intent.is_liquidation() {
                                    let logs: Option<Vec<String>> = meta.log_messages.clone().into();
                                    if let Some(logs) = logs {
                                        for log_line in &logs {
                                            if log_line.contains("Error") || log_line.contains("error") || log_line.contains("failed") || log_line.contains("Program log:") {
                                                log::warn!(target: TARGET, "  tx log: {}", log_line);
                                            }
                                        }
                                    }
                                }
                                // tx failed with error
                                metrics
                                    .tx_failed
                                    .with_label_values(&[
                                        intent_label,
                                        &format!("{:?}", err),
                                    ])
                                    .inc();
                                emit_tx_event(
                                    &intent,
                                    Some(&signature.to_string()),
                                    "failed",
                                    sent_slot,
                                    Some(tx_log.slot),
                                    expected_fill_count,
                                    0,
                                    false,
                                    sent_cu_limit,
                                    meta.compute_units_consumed.clone().into(),
                                    Some(meta.fee),
                                    Some(&format!("{err:?}")),
                                );
                                match intent {
                                    TxIntent::LiquidateWithFill { .. } => {
                                        metrics.liquidation_failed.with_label_values(&["perp"]).inc();
                                    }
                                    TxIntent::LiquidateSpot { .. } => {
                                        metrics.liquidation_failed.with_label_values(&["spot"]).inc();
                                    }
                                    _ => {}
                                }

                                if let (Some(tx_sig_map), Some(txs_map), Some(free_map)) =
                                    (&tx_sig_to_collateral, &txs_in_flight, &free_collateral)
                                {
                                    if let Some((_sig, (collateral, _ts))) = tx_sig_map.remove(&signature) {
                                        for mut entry in txs_map.iter_mut() {
                                            if entry.value_mut().remove(&signature) {
                                                if let Some(mut free) = free_map.get_mut(entry.key()) {
                                                    *free = free.saturating_add(collateral);
                                                }
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        log::warn!(target: TARGET, "tx metadata missing");
                        metrics
                            .tx_failed
                            .with_label_values(&[intent_label, "metadata_missing"])
                            .inc();
                        emit_tx_event(
                            &intent,
                            Some(&tx.to_string()),
                            "metadata_missing",
                            sent_slot,
                            Some(tx_log.slot),
                            expected_fill_count,
                            0,
                            false,
                            sent_cu_limit,
                            None,
                            None,
                            None,
                        );
                    }
                }
                Err(err) => {
                    log::info!(target: TARGET, "tx confirmation failed 🐢: {err}");
                    metrics
                        .tx_failed
                        .with_label_values(&[intent_label, "confirmation_failed"])
                        .inc();
                    emit_tx_event(
                        &intent,
                        Some(&tx.to_string()),
                        "confirmation_failed",
                        sent_slot,
                        None,
                        expected_fill_count,
                        0,
                        false,
                        sent_cu_limit,
                        None,
                        None,
                        Some(&format!("{err}")),
                    );
                }
            }
        });
    }
}

/// Emit a single wide structured event (one JSON line, log target `tx_event`) capturing the
/// full outcome of a transaction.
///
/// This is the canonical per-tx event: every order placement, fill and trigger the bot sends
/// produces exactly one terminal event here (at confirmation, or at sim/send failure), carrying
/// enough dimensions — intent, market, order id / swift uuid, expected vs actual fills, trigger
/// flag, CU limit/consumed, and the exact `fee_lamports` paid — to attribute gas spend. In
/// particular it makes it possible to measure how much gas the `swift_place` (place-on-chain)
/// path costs versus the fills those placements ultimately yield.
#[allow(clippy::too_many_arguments)]
fn emit_tx_event(
    intent: &TxIntent,
    sig: Option<&str>,
    status: &str,
    sent_slot: u64,
    confirmed_slot: Option<u64>,
    expected_fills: usize,
    actual_fills: u64,
    triggered: bool,
    cu_limit: u64,
    cu_consumed: Option<u64>,
    fee_lamports: Option<u64>,
    error: Option<&str>,
) {
    let latency_slots = confirmed_slot.map(|c| c.saturating_sub(sent_slot));
    let uuid = intent
        .swift_uuid()
        .map(|u| String::from_utf8_lossy(&u).into_owned());
    let event = serde_json::json!({
        "event": "tx",
        "intent": intent.label(),
        "market": intent.market_index(),
        "order_id": intent.order_id(),
        "uuid": uuid,
        "sig": sig,
        "status": status,
        "sent_slot": sent_slot,
        "confirmed_slot": confirmed_slot,
        "latency_slots": latency_slots,
        "expected_fills": expected_fills,
        "actual_fills": actual_fills,
        "triggered": triggered,
        "cu_limit": cu_limit,
        "cu_consumed": cu_consumed,
        "fee_lamports": fee_lamports,
        "error": error,
    });
    log::info!(target: "tx_event", "{event}");
}

#[derive(Clone)]
pub struct TxSender {
    tx: crossbeam::channel::Sender<TxWork>,
    velocity: &'static VelocityClient,
}

impl TxSender {
    pub fn confirm_tx(&self, tx: Signature) {
        self.tx
            .send(TxWork::Confirm {
                tx,
                ts: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
            })
            .expect("sent");
    }

    pub async fn send_tx(
        &self,
        tx: VersionedMessage,
        intent: TxIntent,
        cu_limit: u64,
    ) -> Option<Signature> {
        let blockhash = self.velocity.get_latest_blockhash().await.unwrap();
        let signed_tx = self.velocity.wallet().sign_tx(tx, blockhash).ok()?;
        let sig = signed_tx.signatures[0];

        self.tx
            .send(TxWork::Send {
                tx: signed_tx,
                ts: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
                intent,
                cu_limit,
            })
            .ok()?;

        Some(sig)
    }
}

#[cfg(test)]
mod tests {
    use super::{order_dedup_key, Pubkey};

    #[test]
    fn order_dedup_key_distinguishes_users_with_same_order_id() {
        let a = Pubkey::new_from_array([1u8; 32]);
        let b = Pubkey::new_from_array([2u8; 32]);
        // stable for the same (user, order_id)
        assert_eq!(order_dedup_key(&a, 3), order_dedup_key(&a, 3));
        // order_id is per-user: the same id under different users must NOT collide, otherwise
        // one user's trigger would suppress another's (regression guard for the H1 bug).
        assert_ne!(order_dedup_key(&a, 3), order_dedup_key(&b, 3));
        // different order_id under the same user must differ too
        assert_ne!(order_dedup_key(&a, 3), order_dedup_key(&a, 4));
    }
}
