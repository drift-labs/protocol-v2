//! Filler Bot
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anchor_lang::Discriminator;
use dashmap::DashMap;
use drift::math::auction::calculate_auction_price;
use drift_rs::{
    constants::PROGRAM_ID,
    dlob::{
        CrossesAndTopMakers, CrossingRegion, DLOBNotifier, MakerCrosses, OrderKind, TakerOrder,
        DLOB,
    },
    event_subscriber::DriftEvent,
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
    DriftClient, GrpcSubscribeOpts, Pubkey, TransactionBuilder, Wallet,
};
use futures_util::StreamExt;
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_rpc_client_api::config::{
    RpcAccountInfoConfig, RpcProgramAccountsConfig, RpcTransactionConfig,
};
use solana_sdk::{signature::Signature, transaction::TransactionError};
use solana_transaction_status_client_types::UiTransactionEncoding;
use tokio::{runtime::Handle, sync::RwLock};

use crate::{
    http::Metrics,
    util::{OrderSlotLimiter, PendingTxMeta, PendingTxs, PythPriceUpdate, TxIntent},
    Config, UseMarkets,
};

const TARGET: &str = "filler";

pub struct FillerBot {
    drift: DriftClient,
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
}

impl FillerBot {
    pub async fn new(config: Config, drift: DriftClient, metrics: Arc<Metrics>) -> Self {
        let dlob: &'static DLOB = Box::leak(Box::new(DLOB::default()));
        let tx_worker = TxWorker::new(drift.clone(), metrics, config.dry, None, None, None);
        let rt = tokio::runtime::Handle::current();
        let tx_worker_ref = tx_worker.run(rt);

        let mut market_ids = match config.use_markets() {
            UseMarkets::All => drift.get_all_perp_market_ids(),
            UseMarkets::Subset(m) => m,
        };
        // remove bet perp markets
        market_ids.retain(|x| {
            let market = drift
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
                drift
                    .program_data()
                    .perp_market_config_by_index(x.index())
                    .unwrap()
                    .pubkey
            })
            .collect();

        let priority_fee_subscriber =
            PriorityFeeSubscriber::new(drift.rpc().url(), &market_pubkeys);
        let priority_fee_subscriber = priority_fee_subscriber.subscribe();

        let filler_subaccount = drift.wallet.sub_account(config.sub_account_id);

        log::info!(target: TARGET, "subscribing swift orders");
        let swift_order_stream = drift
            .subscribe_swift_orders(&market_ids, Some(true), None, None)
            .await
            .expect("subscribed swift orders");
        log::info!(target: TARGET, "subscribed swift orders");

        drift.subscribe_blockhashes().await.expect("subscribed");
        let slot_rx = setup_grpc(
            drift.clone(),
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
            drift,
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
        }
    }

    pub async fn run(self) {
        let mut swift_order_stream = self.swift_order_stream;
        let mut slot_rx = self.slot_rx;
        let mut limiter = self.limiter;
        let drift: &'static DriftClient = Box::leak(Box::new(self.drift));
        let dlob = self.dlob;
        let market_ids = self.market_ids;
        let filler_subaccount = self.filler_subaccount;
        let config = self.config.clone();
        let tx_worker_ref = self.tx_worker_ref.clone();
        let priority_fee_subscriber = Arc::clone(&self.priority_fee_subscriber);
        let mut slot = 0;
        let mut use_median_trigger_price = drift
            .state_account()
            .map(|s| s.has_median_trigger_price_feature())
            .unwrap_or(false);
        let mut slots_before_stale_for_amm = drift
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

                            // try swift fill against resting liquidity
                            let mut order_params = signed_order.order_params();
                            log::info!(target: TARGET, "new swift order. uuid={}, market={}", signed_order.order_uuid_str(), order_params.market_index);
                            log::debug!(target: TARGET, "details: {signed_order:?}");
                            let perp_market = drift.try_get_perp_market_account(order_params.market_index).unwrap();
                            let oracle_price_data = drift.try_get_mmoracle_for_perp_market(order_params.market_index, slot).expect("got oracle price");
                            let oracle_price = oracle_price_data.price;
                            log::trace!(target: TARGET, "oracle price: slot:{:?},market:{:?},price:{:?}", slot, order_params.market_index, oracle_price);
                            order_params.update_perp_auction_params(
                                &perp_market,
                                oracle_price,
                                true,
                            );
                            if order_params.order_type == OrderType::Limit && order_params.post_only != PostOnlyParam::None {
                                log::warn!(target: TARGET, "swift order limit post only: {signed_order:?}");
                                // TODO: search for immediate fill
                                continue;
                            }
                            let (start_price, end_price, duration) = (order_params.auction_start_price.unwrap_or_default(), order_params.auction_end_price.unwrap_or_default(), order_params.auction_duration.unwrap_or_default());
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
                                    match calculate_auction_price(&order, slot + 1, perp_market.price_tick(), Some(oracle_price)) {
                                        Ok(p) => p,
                                        Err(err) => {
                                            log::warn!(target: TARGET, "could not get auction price {err:?}, params: {order_params:?}, skipping...");
                                            continue;
                                        }
                                    }
                                }
                                OrderType::Limit => {
                                    match order.get_limit_price(Some(oracle_price), Some(vamm_price), slot + 1, perp_market.price_tick()) {
                                        Ok(Some(p)) => p,
                                        _ => {
                                            log::warn!(target: TARGET, "could not get limit price: {order_params:?}, skipping...");
                                            continue;
                                        },
                                    }
                                }
                                _ => {
                                    log::warn!(target: TARGET, "invalid swift order type");
                                    unreachable!();
                                }
                            };
                            let taker_order = TakerOrder::from_order_params(order_params, price);
                            let crosses = dlob.find_crosses_for_taker_order(slot + 1, oracle_price as u64, taker_order, Some(&perp_market), None);
                            if !crosses.is_empty() {
                                // skip vAMM-only swift fills when oracle is stale
                                if crosses.orders.is_empty() && crosses.has_vamm_cross {
                                    if oracle_price_data.delay > slots_before_stale_for_amm {
                                        log::info!(target: TARGET, "skip swift vAMM fill: oracle stale (delay={})", oracle_price_data.delay);
                                        continue;
                                    }
                                }
                                log::info!(target: TARGET, "found resting cross. crosses={crosses:?}");
                                let pf = priority_fee_subscriber.priority_fee_nth(0.6);
                                try_swift_fill(
                                    drift,
                                    pf,
                                    config.swift_cu_limit,
                                    filler_subaccount,
                                    signed_order,
                                    crosses,
                                    tx_worker_ref.clone(),
                                ).await;
                            }
                        }
                        None => {
                            retries += 1;
                            if retries <= MAX_SWIFT_RECONNECT_RETRIES {
                                    let backoff = 2u64.pow(retries).min(30);
                                    log::warn!(target: "swift", "feed disconnected, retry {retries}/{MAX_SWIFT_RECONNECT_RETRIES} in {backoff}s");
                                    tokio::time::sleep(Duration::from_secs(backoff)).await;

                                    match drift
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

                        let perp_market = drift.try_get_perp_market_account(market_index).expect("got perp market");
                        let chain_oracle_data = drift.try_get_mmoracle_for_perp_market(market_index, slot).expect("got oracle price");
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

                        if !crosses_and_top_makers.crosses.is_empty() {
                            log::info!(target: TARGET, "found auction crosses. market: {},{crosses_and_top_makers:?}", market.index());
                            try_auction_fill(
                                drift,
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

                        // ghetto rate limit
                        if slot % 2 == 0 {
                            if let Some(crosses) = dlob.find_crossing_region(oracle_price, market_index, MarketType::Perp, Some(&perp_market)) {
                                log::info!(target: TARGET, "found limit crosses (market: {market_index}), top bid: {:?}, top ask: {:?}", crosses.crossing_bids.first(), crosses.crossing_asks.first());
                                try_uncross(drift, slot + 1, priority_fee, config.fill_cu_limit, market_index, filler_subaccount, crosses, &tx_worker_ref).await;
                            }
                        }

                        // check state config ~every minute
                        if slot % 300 == 0 {
                            use_median_trigger_price = drift
                                .state_account()
                                .map(|s| s.has_median_trigger_price_feature())
                                .unwrap_or(false);
                            slots_before_stale_for_amm = drift
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
        drift.grpc_unsubscribe();
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
    drift: DriftClient,
    market_ids: Vec<MarketId>,
    dlob_notifier: DLOBNotifier,
    slot_tx: tokio::sync::mpsc::Sender<u64>,
) -> impl Fn(u64) + Send + Sync + 'static {
    move |new_slot| {
        for market in market_ids.iter() {
            let oracle_price_data = drift
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
    drift: DriftClient,
) -> impl Fn(&AccountUpdate) + Send + Sync + 'static {
    move |update| {
        let new_user = drift_rs::utils::deser_zero_copy::<User>(update.data);
        if let Some(ref existing) = drift
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

/// Try to fill a swift order
async fn try_swift_fill(
    drift: &'static DriftClient,
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

    let filler_account_data = drift
        .try_get_account::<User>(&filler_subaccount)
        .expect("filler account");
    let taker_stats = Wallet::derive_stats_account(&taker_authority);
    let (taker_account_data, taker_stats) = tokio::try_join!(
        drift.get_account_value::<User>(&taker_subaccount),
        drift.get_account_value::<UserStats>(&taker_stats)
    )
    .unwrap();
    let tx_builder = TransactionBuilder::new(
        drift.program_data(),
        filler_subaccount,
        std::borrow::Cow::Borrowed(&filler_account_data),
        false,
    );

    let maker_accounts: Vec<User> = crosses
        .orders
        .iter()
        .filter(|m| m.0.user != taker_subaccount) // can't fill itself
        .map(|(m, _fill_size)| {
            drift
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
                maker_crosses: crosses,
            },
            cu_limit as u64,
        )
        .await;
}

/// Try to fill an auction order
///
/// - `auction_crosses` list of one or more crosses to fill
async fn try_auction_fill(
    drift: &'static DriftClient,
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
    let filler_account_data = drift
        .try_get_account::<User>(&filler_subaccount)
        .expect("filler account");

    let top_maker_asks: Vec<User> = auction_crosses
        .top_maker_asks
        .iter()
        .map(|m| {
            drift
                .try_get_account::<User>(m)
                .expect("maker account syncd")
        })
        .collect();

    let top_maker_bids: Vec<User> = auction_crosses
        .top_maker_bids
        .iter()
        .map(|m| {
            drift
                .try_get_account::<User>(m)
                .expect("maker account syncd")
        })
        .collect();
    let mut sent_oracle_update = false;
    for (taker_order, crosses) in auction_crosses.crosses {
        log::info!(target: TARGET, "try fill auction order: {taker_order:?}");
        let taker_subaccount = taker_order.user;

        let taker_account_data = drift
            .try_get_account::<User>(&taker_subaccount)
            .expect("taker account");

        let taker_stats = drift.try_get_account::<UserStats>(&Wallet::derive_stats_account(
            &taker_account_data.authority,
        ));

        if taker_stats.is_err() {
            log::warn!(target: TARGET, "failed to fetch taker stats: {:?}", taker_account_data.authority);
            continue;
        }

        let mut tx_builder = TransactionBuilder::new(
            drift.program_data(),
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
            let actual_order = taker_account_data
                .orders
                .iter()
                .find(|o| o.order_id == taker_order.order_id)
                .expect("trigger order exists");

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
                return;
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
            .map(|(m, _fill_size)| {
                drift
                    .try_get_account::<User>(&m.user)
                    .expect("maker account syncd")
            })
            .collect();

        let effective_vamm_cross = crosses.has_vamm_cross && !oracle_stale_for_amm;
        if effective_vamm_cross {
            if is_vamm_inactive(&crosses) {
                log::debug!(target: TARGET, "skip inactive vamm cross: {crosses:?}");
                return;
            }

            if let Ok(pos) = taker_account_data.get_perp_position(market_index) {
                if let Ok((base_asset_amount, _limit_price)) =
                    drift::math::orders::calculate_base_asset_amount_for_amm_to_fulfill(
                        taker_account_data
                            .orders
                            .iter()
                            .find(|o| o.order_id == taker_order.order_id)
                            .unwrap(),
                        &perp_market,
                        None,
                        None,
                        pos.base_asset_amount,
                        &FeeTier::default(),
                    )
                {
                    // if user position is less than min order size, step size is the threshold
                    let amm_size_threshold = if !taker_order.is_reduce_only()
                        && pos.base_asset_amount.unsigned_abs() > perp_market.market_stats.min_order_size
                    {
                        perp_market.market_stats.min_order_size
                    } else {
                        perp_market.order_step_size
                    };
                    if base_asset_amount < amm_size_threshold {
                        log::info!(target: TARGET, "skip vamm cross too small: {crosses:?}");
                        return;
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
            return;
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
    drift: &DriftClient,
    slot: u64,
    priority_fee: u64,
    cu_limit: u32,
    market_index: u16,
    filler_subaccount: Pubkey,
    crosses: CrossingRegion,
    tx_worker_ref: &TxSender,
) {
    let filler_account_data = drift
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
                drift.try_get_account::<User>(&maker).ok()
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
                drift.try_get_account::<User>(&maker).ok()
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
        let taker_account_data = drift
            .try_get_account::<User>(&taker_subaccount)
            .expect("taker account");

        let taker_stats = drift.try_get_account::<UserStats>(&Wallet::derive_stats_account(
            &taker_account_data.authority,
        ));
        if taker_stats.is_err() {
            log::warn!(target: TARGET, "failed to fetch taker stats: {:?}", taker_account_data.authority);
            continue;
        }

        let mut tx_builder = TransactionBuilder::new(
            drift.program_data(),
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
    drift: DriftClient,
    dlob: &'static DLOB,
    tx_worker_ref: TxSender,
    market_ids: Vec<MarketId>,
) -> tokio::sync::mpsc::Receiver<u64> {
    let dlob_notifier = dlob.spawn_notifier();

    let _ = tokio::try_join!(
        sync_stats_accounts(&drift),
        sync_user_accounts(&drift, &dlob_notifier),
    );

    let (slot_tx, slot_rx) = tokio::sync::mpsc::channel(64);

    subscribe_grpc(drift, dlob_notifier, slot_tx, tx_worker_ref, market_ids).await;

    slot_rx
}

pub async fn sync_stats_accounts(
    drift: &DriftClient,
) -> Result<(), solana_rpc_client_api::client_error::Error> {
    let stats_sync_result = drift
        .rpc()
        .get_program_accounts_with_config(
            &PROGRAM_ID,
            RpcProgramAccountsConfig {
                filters: Some(vec![drift_rs::memcmp::get_user_stats_filter()]),
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
                drift.backend().account_map().on_account_fn()(&AccountUpdate {
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
    drift: &DriftClient,
    dlob_notifier: &DLOBNotifier,
) -> Result<(), solana_rpc_client_api::client_error::Error> {
    let sync_result = drift
        .rpc()
        .get_program_accounts_with_config(
            &PROGRAM_ID,
            RpcProgramAccountsConfig {
                filters: Some(vec![
                    drift_rs::memcmp::get_non_idle_user_filter(),
                    drift_rs::memcmp::get_user_filter(),
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
                let user = drift_rs::utils::deser_zero_copy::<User>(&account.data);
                dlob_notifier.user_update(pubkey, None, &user, 0);
                drift.backend().account_map().on_account_fn()(&AccountUpdate {
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
    drift: DriftClient,
    dlob_notifier: DLOBNotifier,
    slot_tx: tokio::sync::mpsc::Sender<u64>,
    transaction_tx: TxSender,
    market_ids: Vec<MarketId>,
) {
    let _res = drift
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
                .transaction_include_accounts(vec![drift.wallet().default_sub_account()])
                .on_transaction(on_transaction_update_fn(transaction_tx.clone()))
                .on_slot(on_slot_update_fn(
                    drift.clone(),
                    market_ids,
                    dlob_notifier.clone(),
                    slot_tx.clone(),
                ))
                .on_account(
                    AccountFilter::partial().with_discriminator(User::DISCRIMINATOR),
                    on_account_update_fn(dlob_notifier.clone(), drift.clone()),
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
    drift: &'static DriftClient,
    pending_txs: Arc<RwLock<PendingTxs<1024>>>,
    metrics: Arc<Metrics>,
    dry_run: bool,
    txs_in_flight: Option<Arc<DashMap<Pubkey, HashSet<Signature>>>>,
    tx_sig_to_collateral: Option<Arc<DashMap<Signature, (u128, u64)>>>,
    free_collateral_per_subaccount: Option<Arc<DashMap<Pubkey, u128>>>,
}

impl TxWorker {
    pub fn new(
        drift: DriftClient,
        metrics: Arc<Metrics>,
        dry_run: bool,
        txs_in_flight: Option<Arc<DashMap<Pubkey, HashSet<Signature>>>>,
        tx_sig_to_collateral: Option<Arc<DashMap<Signature, (u128, u64)>>>,
        free_collateral_per_subaccount: Option<Arc<DashMap<Pubkey, u128>>>,
    ) -> Self {
        Self {
            drift: Box::leak(Box::new(drift)),
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
        let drift = self.drift;
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
        TxSender { tx, drift }
    }

    fn send_tx(
        &self,
        rt: &Handle,
        signed_tx: VersionedTransaction,
        intent: TxIntent,
        cu_limit: u64,
    ) {
        log::debug!(target: TARGET, "txworker send tx: {intent:?}");
        let drift = self.drift;
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
            match drift.simulate_tx(signed_tx.message.clone()).await {
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
                    return;
                }
            }

            let config = RpcSendTransactionConfig {
                skip_preflight: true,
                max_retries: Some(0),
                ..Default::default()
            };

            match drift
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
                }
            }
        });
    }

    fn confirm_tx(&self, rt: &Handle, tx: Signature) {
        // TODO: if CU limit is too low send it again with higher amount
        log::debug!(target: TARGET, "txworker confirm tx: {tx:?}");
        let drift = self.drift;
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
            let _ = tokio::time::sleep(Duration::from_secs(1)).await;
            match drift
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
                                let (_, sent_slot) = intent.crosses_and_slot();
                                let mut actual_fills = 0;
                                for (tx_idx, log) in logs.iter().enumerate() {
                                    if let Some(event) = drift_rs::event_subscriber::try_parse_log(
                                        log.as_str(),
                                        &sig,
                                        tx_idx,
                                    ) {
                                        if let DriftEvent::OrderFill { ..} = event
                                        {
                                            actual_fills += 1;
                                        } else if let DriftEvent::OrderTrigger { .. } = event {
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
                                let cus_spent =
                                    sent_cu_limit - meta.compute_units_consumed.unwrap();
                                metrics
                                    .cu_spent
                                    .with_label_values(&[intent_label])
                                    .observe(cus_spent as f64);

                                if actual_fills == 0 {
                                    metrics
                                        .tx_confirmed
                                        .with_label_values(&[intent_label, "no_fills"])
                                        .inc();
                                } else if actual_fills < expected_fill_count as u64 {
                                    metrics
                                        .tx_confirmed
                                        .with_label_values(&[intent_label, "partial"])
                                        .inc();
                                } else {
                                        metrics
                                        .tx_confirmed
                                        .with_label_values(&[intent_label, "ok"])
                                        .inc();
                                }

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
                    }
                }
                Err(err) => {
                    log::info!(target: TARGET, "tx confirmation failed 🐢: {err}");
                    metrics
                        .tx_failed
                        .with_label_values(&[intent_label, "confirmation_failed"])
                        .inc();
                }
            }
        });
    }
}

#[derive(Clone)]
pub struct TxSender {
    tx: crossbeam::channel::Sender<TxWork>,
    drift: &'static DriftClient,
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
        let blockhash = self.drift.get_latest_blockhash().await.unwrap();
        let signed_tx = self.drift.wallet().sign_tx(tx, blockhash).ok()?;
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
