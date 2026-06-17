//! Example Liquidator Bot
//!
//! Subscribes to drift accounts, market, and oracles via gRPC.
//! Identifies liquidatable accounts and forwards them to a strategy impl
//! for processing.
//!
//! The default strategy tries to liquidate perp positions against resting orders
//!
use anchor_lang::Discriminator;
use dashmap::DashMap;
use futures_util::FutureExt;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::mpsc::error::TryRecvError;

use drift_rs::{
    dlob::{DLOBNotifier, DLOB},
    grpc::{
        grpc_subscriber::{AccountFilter, GrpcConnectionOpts},
        TransactionUpdate,
    },
    jupiter::SwapMode,
    market_state::{MarketStateData, SimplifiedMarginCalculation},
    math::{
        constants::{
            BASE_PRECISION, MARGIN_PRECISION_U128, PRICE_PRECISION, QUOTE_PRECISION,
            SPOT_WEIGHT_PRECISION_U128,
        },
        liquidation::{calculate_collateral, CollateralInfo},
        tiers::{perp_tier_is_as_safe_as, AssetTierExt, ContractTierExt},
    },
    priority_fee_subscriber::PriorityFeeSubscriber,
    titan,
    types::{
        accounts::{PerpMarket, SpotMarket, User},
        MarginRequirementType, MarketId, MarketStatus, MarketType, OraclePriceData, OracleSource,
        OrderParams, OrderType, PerpPosition, PositionDirection, SpotBalanceType, SpotPosition,
    },
    DriftClient, GrpcSubscribeOpts, MarketState, Pubkey, TransactionBuilder,
};
use drift_rs::{jupiter::JupiterSwapApi, titan::TitanSwapApi};
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_sdk::{account::Account, clock::Slot, signature::Signature};

use crate::{
    filler::{TxSender, TxWorker},
    http::{
        DashboardState, DashboardStateRef, HighRiskUser, MarginStatus, Metrics, OraclePriceInfo,
        UserMarginStatus,
    },
    util::{PythPriceUpdate, TxIntent},
    Config, UseMarkets,
};

/// min slots between successive liquidation attempts on same user
const LIQUIDATION_SLOT_RATE_LIMIT: u64 = 5; // ~2s

/// Maximum time allowed for a liquidation attempt in milliseconds
const LIQUIDATION_DEADLINE_MS: u64 = 1_000;

/// Maximum age for liquidation entries in milliseconds
const MAX_LIQUIDATION_AGE_MS: u64 = 1_000;

/// Maximum number of consecutive failed liquidation attempts before applying extended cooldown
const MAX_CONSECUTIVE_FAILURES: u32 = 3;

/// Base cooldown in milliseconds after a failed liquidation (doubles each failure)
const FAILURE_COOLDOWN_BASE_MS: u64 = 5_000;

/// Maximum cooldown in milliseconds (cap for exponential backoff) — 5 minutes
const FAILURE_COOLDOWN_MAX_MS: u64 = 300_000;

const TARGET: &str = "liquidator";

/// Tracks per-account liquidation attempt history for backoff
#[derive(Clone, Debug)]
struct LiquidationAttemptTracker {
    /// Number of consecutive failed/no-effect attempts
    consecutive_failures: u32,
    /// Timestamp (ms) of the last attempt
    last_attempt_ms: u64,
    /// Slot of the last attempt
    last_attempt_slot: u64,
}

impl LiquidationAttemptTracker {
    fn new(slot: u64) -> Self {
        Self {
            consecutive_failures: 0,
            last_attempt_ms: current_time_millis(),
            last_attempt_slot: slot,
        }
    }

    /// Returns the cooldown duration in ms based on consecutive failures
    fn cooldown_ms(&self) -> u64 {
        if self.consecutive_failures == 0 {
            return 0;
        }
        let cooldown = FAILURE_COOLDOWN_BASE_MS * (1u64 << (self.consecutive_failures - 1).min(10));
        cooldown.min(FAILURE_COOLDOWN_MAX_MS)
    }

    /// Whether enough time has passed since the last attempt
    fn is_cooled_down(&self, now_ms: u64) -> bool {
        now_ms.saturating_sub(self.last_attempt_ms) >= self.cooldown_ms()
    }

    fn record_attempt(&mut self, slot: u64) {
        self.last_attempt_ms = current_time_millis();
        self.last_attempt_slot = slot;
        self.consecutive_failures += 1;
    }

    fn reset(&mut self) {
        self.consecutive_failures = 0;
    }
}

/// Threshold for considering a user high-risk: free margin < 10% of margin requirement
const HIGH_RISK_FREE_MARGIN_RATIO: f64 = 0.1;

/// Maximum age for user accounts in slots before considering stale (~40 seconds at 400ms/slot)
const MAX_USER_AGE_SLOTS: u64 = 100;
/// Maximum age for oracle prices in slots before considering stale (~20 seconds)
const MAX_ORACLE_AGE_SLOTS: u64 = 50;
/// Maximum age for Pyth prices in milliseconds before considering stale
const MAX_PYTH_AGE_MS: u64 = 5000;

/// Permanently blocked spot markets (untradable tokens)
const BLOCKED_SPOT_MARKETS: &[u16] = &[40];

/// Metadata tracking for user accounts to detect staleness
#[derive(Clone, Debug)]
struct UserAccountMetadata {
    user: User,
    last_updated_slot: u64,
    last_updated_timestamp_ms: u64,
}

/// Metadata tracking for oracle prices to detect staleness
#[derive(Clone, Debug)]
struct OraclePriceMetadata {
    price_data: OraclePriceData,
    last_updated_slot: u64,
    last_updated_timestamp_ms: u64,
}

/// Errors indicating data staleness
#[derive(Debug, Clone)]
enum StalenessError {
    UserAccountStale { age_slots: u64 },
    OraclePriceStale { market: MarketId, age_slots: u64 },
    PythPriceStale { market_id: u16, age_ms: u64 },
}

/// Helper to get current time in milliseconds since epoch
fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Validate that user account and required oracle prices are fresh enough
fn validate_data_freshness(
    user_meta: &UserAccountMetadata,
    oracle_prices: &HashMap<MarketId, OraclePriceMetadata>,
    current_slot: u64,
) -> Result<(), StalenessError> {
    // Check user account age
    let user_age_slots = current_slot.saturating_sub(user_meta.last_updated_slot);
    if user_age_slots > MAX_USER_AGE_SLOTS {
        return Err(StalenessError::UserAccountStale {
            age_slots: user_age_slots,
        });
    }

    // Check oracle prices for all markets user has positions in
    for pos in &user_meta.user.perp_positions {
        if pos.base_asset_amount != 0 {
            let market_id = MarketId::perp(pos.market_index);
            if let Some(oracle_meta) = oracle_prices.get(&market_id) {
                let oracle_age_slots = current_slot.saturating_sub(oracle_meta.last_updated_slot);
                if oracle_age_slots > MAX_ORACLE_AGE_SLOTS {
                    return Err(StalenessError::OraclePriceStale {
                        market: market_id,
                        age_slots: oracle_age_slots,
                    });
                }
            }
        }
    }

    for pos in &user_meta.user.spot_positions {
        if !pos.is_available() {
            let market_id = MarketId::spot(pos.market_index);
            if let Some(oracle_meta) = oracle_prices.get(&market_id) {
                let oracle_age_slots = current_slot.saturating_sub(oracle_meta.last_updated_slot);
                if oracle_age_slots > MAX_ORACLE_AGE_SLOTS {
                    return Err(StalenessError::OraclePriceStale {
                        market: market_id,
                        age_slots: oracle_age_slots,
                    });
                }
            }
        }
    }

    Ok(())
}

/// Validate Pyth price freshness
fn validate_pyth_price_freshness(pyth_update: &PythPriceUpdate) -> Result<(), StalenessError> {
    let now_ms = current_time_millis();
    // Pyth timestamp is in microseconds, convert to milliseconds
    let pyth_ts_ms = pyth_update.ts.0 / 1000;
    let age_ms = now_ms.saturating_sub(pyth_ts_ms);

    if age_ms > MAX_PYTH_AGE_MS {
        return Err(StalenessError::PythPriceStale {
            market_id: pyth_update.market_id,
            age_ms,
        });
    }

    Ok(())
}

/// Update dashboard state with current high-risk users and oracle prices
async fn update_dashboard_state(
    drift: &DriftClient,
    dashboard_state: &DashboardStateRef,
    users: &BTreeMap<Pubkey, UserAccountMetadata>,
    oracle_prices: &HashMap<MarketId, OraclePriceMetadata>,
    high_risk: &HashSet<Pubkey>,
    current_slot: u64,
    market_state: &'static MarketState,
    liquidation_margin_buffer_ratio: u32,
) {
    let now_ms = current_time_millis();
    let mut high_risk_users = Vec::new();

    for pubkey in high_risk {
        if let Some(user_meta) = users.get(pubkey) {
            let margin_info = match market_state.calculate_simplified_margin_requirement(
                &user_meta.user,
                MarginRequirementType::Maintenance,
                Some(liquidation_margin_buffer_ratio),
            ) {
                Ok(info) => info,
                Err(e) => {
                    std::mem::forget(e);
                    continue;
                }
            };

            let free_margin = margin_info.total_collateral - margin_info.margin_requirement as i128;
            let free_margin_ratio = if margin_info.margin_requirement > 0 {
                free_margin as f64 / margin_info.margin_requirement as f64
            } else {
                0.0
            };

            let status = check_margin_status(&margin_info);
            let display_status = if status.is_liquidatable() {
                MarginStatus::Liquidatable
            } else if status.is_at_risk() {
                MarginStatus::HighRisk
            } else {
                continue;
            };

            let mut positions = Vec::new();
            for pos in &user_meta.user.perp_positions {
                if pos.base_asset_amount != 0 {
                    positions.push(crate::http::PositionInfo {
                        market_type: crate::http::MarketType::Perp,
                        market_index: pos.market_index,
                        base_asset_amount: pos.base_asset_amount,
                        quote_asset_amount: pos.quote_asset_amount,
                    });
                }
            }
            for pos in &user_meta.user.spot_positions {
                if pos.scaled_balance != 0 {
                    // Calculate quote_asset_amount = base_asset_amount * spot oracle price
                    // Note: base_asset_amount calculation would require spot market access
                    // which isn't directly available from MarketState in this context.
                    // We'll calculate an approximation using scaled_balance and oracle price.
                    let spot_market = match drift.try_get_spot_market_account(pos.market_index) {
                        Ok(market) => market,
                        Err(_) => continue,
                    };
                    let (base, quote) = if let Some(oracle_meta) =
                        oracle_prices.get(&MarketId::spot(pos.market_index))
                    {
                        let base = match pos.get_signed_token_amount(&spot_market) {
                            Ok(amount) => amount,
                            Err(_) => continue,
                        };
                        (base, base * oracle_meta.price_data.price as i128)
                    } else {
                        (0, 0) // No oracle price available
                    };

                    positions.push(crate::http::PositionInfo {
                        market_type: crate::http::MarketType::Spot,
                        market_index: pos.market_index,
                        base_asset_amount: base as i64,
                        quote_asset_amount: quote as i64,
                    });
                }
            }

            high_risk_users.push(HighRiskUser {
                pubkey: pubkey.to_string(),
                authority: user_meta.user.authority.to_string(),
                total_collateral: margin_info.total_collateral,
                margin_requirement: margin_info.margin_requirement,
                free_margin,
                free_margin_ratio,
                status: display_status,
                last_updated_slot: user_meta.last_updated_slot,
                last_updated_ms: user_meta.last_updated_timestamp_ms,
                positions,
            });
        }
    }

    let mut oracle_price_infos = Vec::new();
    for (market_id, oracle_meta) in oracle_prices {
        let age_slots = current_slot.saturating_sub(oracle_meta.last_updated_slot);
        let age_ms = now_ms.saturating_sub(oracle_meta.last_updated_timestamp_ms);
        let is_stale = age_slots > MAX_ORACLE_AGE_SLOTS;

        oracle_price_infos.push(OraclePriceInfo {
            market_type: if market_id.is_perp() {
                crate::http::MarketType::Perp
            } else {
                crate::http::MarketType::Spot
            },
            market_index: market_id.index(),
            price: oracle_meta.price_data.price,
            last_updated_slot: oracle_meta.last_updated_slot,
            last_updated_ms: oracle_meta.last_updated_timestamp_ms,
            age_slots,
            age_ms,
            is_stale,
        });
    }

    let dashboard_data = DashboardState {
        high_risk_users,
        oracle_prices: oracle_price_infos,
        current_slot,
        last_updated_ms: now_ms,
    };

    *dashboard_state.write().await = Some(dashboard_data);
}

/// Check margin status (liquidatable, high-risk, or safe)
fn check_margin_status(margin_info: &SimplifiedMarginCalculation) -> UserMarginStatus {
    const LIQUIDATION_BUFFER: f64 = 1.0;
    let mut isolated = Vec::with_capacity(8);

    // Check isolated positions
    for calc in &margin_info.isolated_margin_calculations {
        if calc.is_empty() {
            continue;
        }

        if calc.total_collateral <= 0 {
            continue;
        }

        let buffered_iso_margin_req = (calc.margin_requirement as f64 * LIQUIDATION_BUFFER) as i128;
        if calc.total_collateral < buffered_iso_margin_req {
            isolated.push((calc.market_index, MarginStatus::Liquidatable));
        } else {
            let free_margin = calc.total_collateral - calc.margin_requirement as i128;
            if calc.margin_requirement > 0 && free_margin > 0 {
                let free_margin_ratio = free_margin as f64 / calc.margin_requirement as f64;
                if free_margin_ratio < HIGH_RISK_FREE_MARGIN_RATIO {
                    isolated.push((calc.market_index, MarginStatus::HighRisk));
                }
            }
        }
    }

    // Check cross margin
    let buffered_margin_req = (margin_info.margin_requirement as f64 * LIQUIDATION_BUFFER) as i128;
    let cross = if margin_info.total_collateral < buffered_margin_req {
        MarginStatus::Liquidatable
    } else {
        let free_margin = margin_info.total_collateral - margin_info.margin_requirement as i128;
        if margin_info.margin_requirement > 0 && free_margin > 0 {
            let free_margin_ratio = free_margin as f64 / margin_info.margin_requirement as f64;
            if free_margin_ratio < HIGH_RISK_FREE_MARGIN_RATIO {
                MarginStatus::HighRisk
            } else {
                MarginStatus::Safe
            }
        } else {
            MarginStatus::Safe
        }
    };

    UserMarginStatus { cross, isolated }
}

/// Outcome of a liquidation attempt, used to drive backoff decisions
#[derive(Debug, Clone)]
pub enum LiquidationOutcome {
    /// A transaction was built and sent to the tx worker
    TxSent,
    /// Liquidation was skipped due to missing data, no positions, no makers, etc.
    Skipped(&'static str),
}

impl LiquidationOutcome {
    pub fn is_sent(&self) -> bool {
        matches!(self, Self::TxSent)
    }

    pub fn reason(&self) -> &'static str {
        match self {
            Self::TxSent => "sent",
            Self::Skipped(reason) => reason,
        }
    }
}

/// Trait for pluggable liquidation strategies
pub trait LiquidationStrategy {
    /// Execute liquidation logic a user, including selecting makers and sending txs.
    fn liquidate_user<'a>(
        &'a self,
        liquidatee: Pubkey,
        user_account: Arc<User>,
        tx_sender: TxSender,
        priority_fee: u64,
        cu_limit: u32,
        slot: u64,
        pyth_price_update: Option<PythPriceUpdate>,
        status: UserMarginStatus,
    ) -> futures_util::future::BoxFuture<'a, LiquidationOutcome>;
}

pub enum GrpcEvent {
    OracleUpdate {
        oracle_price_data: OraclePriceData,
        market: MarketId,
        slot: Slot,
    },
    SpotMarketUpdate {
        market: SpotMarket,
        slot: Slot,
    },
    PerpMarketUpdate {
        market: PerpMarket,
        slot: Slot,
    },
    UserUpdate {
        pubkey: Pubkey,
        user: User,
        slot: Slot,
    },
}

pub struct LiquidatorBot {
    drift: DriftClient,
    dlob_notifier: DLOBNotifier,
    config: Config,
    /// stores drift perp+spot market metadata and oracle prices
    market_state: Arc<RwLock<MarketState>>,
    /// receives new updates from grpc
    events_rx: tokio::sync::mpsc::Receiver<GrpcEvent>,
    /// sends liquidatable accounts to work thread (pubkey, user, slot, timestamp_ms, pyth price)
    liq_tx: tokio::sync::mpsc::Sender<(
        Pubkey,
        User,
        u64,
        u64,
        Option<PythPriceUpdate>,
        UserMarginStatus,
    )>,
    pyth_price_feed: Option<tokio::sync::mpsc::Receiver<PythPriceUpdate>>,
    /// Dashboard state for HTTP API
    dashboard_state: DashboardStateRef,
    subaccount_pubkeys: Vec<Pubkey>,
    /// Track collateral info per subaccount
    collateral_info_per_subaccount: Arc<DashMap<Pubkey, CollateralInfo>>,
    /// In flight txs tracking
    txs_in_flight: Arc<DashMap<Pubkey, HashSet<Signature>>>,
    // Map(Signature,(collateral, ts))
    tx_sig_to_collateral: Arc<DashMap<Signature, (u128, u64)>>,
    free_collateral_per_subaccount: Arc<DashMap<Pubkey, u128>>,
}

impl LiquidatorBot {
    pub async fn new(
        config: Config,
        drift: DriftClient,
        metrics: Arc<Metrics>,
        dashboard_state: DashboardStateRef,
    ) -> Self {
        let dlob: &'static DLOB = Box::leak(Box::new(DLOB::default()));

        let mut perp_market_ids = match config.use_markets() {
            UseMarkets::All => drift.get_all_perp_market_ids(),
            UseMarkets::Subset(m) => m,
        };

        let spot_market_ids: Vec<MarketId> = drift
            .program_data()
            .spot_market_configs()
            .iter()
            .map(|m| MarketId::spot(m.market_index))
            .collect();

        // remove bet perp markets
        perp_market_ids.retain(|x| {
            let market = drift
                .program_data()
                .perp_market_config_by_index(x.index())
                .unwrap();
            let name = core::str::from_utf8(&market.name)
                .unwrap()
                .to_ascii_lowercase();

            !name.contains("bet") && market.status != MarketStatus::Initialized
        });

        let market_pubkeys: Vec<Pubkey> = perp_market_ids
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

        let subaccounts: Vec<Pubkey> = config
            .get_subaccounts()
            .iter()
            .map(|id| drift.wallet.sub_account(*id))
            .collect();

        log::info!(target: TARGET, "liquidator 🫠 bot started: authority={:?}, subaccount={:?}", drift.wallet.authority(), subaccounts);

        drift.subscribe_blockhashes().await.expect("subscribed");

        let subaccount_pubkeys: Vec<Pubkey> = config
            .get_subaccounts()
            .iter()
            .map(|id| drift.wallet.sub_account(*id))
            .collect();

        let collateral_info_per_subaccount =
            Arc::new(get_collateral_info_per_subaccount(&drift, &subaccount_pubkeys).await);

        // In flight txs tracking to prevent over committing
        let (txs_in_flight, free_collateral_per_subaccount) = {
            let txs = DashMap::new();
            let free = DashMap::new();
            for &subaccount in &subaccount_pubkeys {
                txs.insert(subaccount, HashSet::new());
                if let Some(info) = collateral_info_per_subaccount.get(&subaccount) {
                    free.insert(subaccount, info.free.max(0) as u128);
                }
            }
            (Arc::new(txs), Arc::new(free))
        };

        let tx_sig_to_collateral: Arc<DashMap<Signature, (u128, u64)>> = Arc::new(DashMap::new());

        let tx_worker = TxWorker::new(
            drift.clone(),
            Arc::clone(&metrics),
            config.dry,
            Some(Arc::clone(&txs_in_flight)),
            Some(Arc::clone(&tx_sig_to_collateral)),
            Some(Arc::clone(&free_collateral_per_subaccount)),
        );
        let rt = tokio::runtime::Handle::current();
        let tx_sender = tx_worker.run(rt);

        let dlob_notifier = dlob.spawn_notifier();
        let events_rx = setup_grpc(
            drift.clone(),
            dlob_notifier.clone(),
            tx_sender.clone(),
            perp_market_ids.clone(),
        )
        .await;
        log::info!(target: TARGET, "subscribed gRPC");

        // populate market data
        let mut market_state = MarketStateData::default();
        // Only use pyth price when it differs from oracle by >5 bps
        market_state.pyth_oracle_diff_threshold_bps = 5;

        for market in drift.program_data().perp_market_configs() {
            market_state.set_perp_market(*market);
            if let Some(oracle) = drift
                .backend()
                .oracle_map()
                .get_by_market(&MarketId::perp(market.market_index))
            {
                market_state.set_perp_oracle_price(market.market_index, oracle.data);
            }
        }

        for market in drift.program_data().spot_market_configs() {
            market_state.set_spot_market(*market);
            if let Some(oracle) = drift
                .backend()
                .oracle_map()
                .get_by_market(&MarketId::spot(market.market_index))
            {
                market_state.set_spot_oracle_price(market.market_index, oracle.data);
            }
        }

        let market_state = Arc::new(RwLock::new(MarketState::new(market_state)));

        let pyth_access_token = std::env::var("PYTH_LAZER_TOKEN").expect("pyth access token");
        let pyth_feed_cli = pyth_lazer_client::LazerClient::new(
            "wss://pyth-lazer.dourolabs.app/v1/stream",
            pyth_access_token.as_str(),
        )
        .expect("pyth price feed connects");

        let pyth_price_feed: tokio::sync::mpsc::Receiver<_> = if config.use_spot_liquidation {
            crate::util::subscribe_price_feeds(
                pyth_feed_cli,
                &perp_market_ids,
                &spot_market_ids,
                &[],
            )
        } else {
            crate::util::subscribe_price_feeds(pyth_feed_cli, &perp_market_ids, &[], &[])
        };

        log::info!(target: TARGET, "subscribed pyth price feeds");

        let cu_limit = std::env::var("FILL_CU_LIMIT")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(config.fill_cu_limit);

        // start liquidation worker
        let (liq_tx, liq_rx) = tokio::sync::mpsc::channel::<(
            Pubkey,
            User,
            u64,
            u64,
            Option<PythPriceUpdate>,
            UserMarginStatus,
        )>(102400);
        spawn_liquidation_worker(
            tx_sender.clone(),
            Arc::new(PrimaryLiquidationStrategy {
                dlob,
                drift: drift.clone(),
                market_state: Arc::clone(&market_state),
                subaccounts: subaccounts.clone(),
                metrics: Arc::clone(&metrics),
                use_spot_liquidation: config.use_spot_liquidation,
                txs_in_flight: Arc::clone(&txs_in_flight),
                tx_sig_to_collateral: Arc::clone(&tx_sig_to_collateral),
                free_collateral_per_subaccount: Arc::clone(&free_collateral_per_subaccount),
            }),
            liq_rx,
            cu_limit,
            Arc::clone(&priority_fee_subscriber),
            Arc::clone(&metrics),
        );

        log::info!(target: TARGET, "spawned liquidation worker");

        spawn_derisk_loop(
            drift.clone(),
            tx_sender.clone(),
            subaccounts,
            Arc::clone(&priority_fee_subscriber),
            cu_limit,
        );

        log::info!(target: TARGET, "spawned derisk worker");

        let tx_sig_to_collateral_clone = Arc::clone(&tx_sig_to_collateral);
        let txs_in_flight_clone = Arc::clone(&txs_in_flight);
        let free_collateral_per_subaccount_clone = Arc::clone(&free_collateral_per_subaccount);

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            loop {
                interval.tick().await;
                clean_stale_in_flight_txs(
                    Arc::clone(&tx_sig_to_collateral_clone),
                    Arc::clone(&txs_in_flight_clone),
                    Arc::clone(&free_collateral_per_subaccount_clone),
                );
            }
        });

        log::info!(target: TARGET, "spawned stale in flight txs cleanup worker");

        LiquidatorBot {
            drift,
            dlob_notifier,
            events_rx,
            config,
            market_state,
            liq_tx,
            pyth_price_feed: Some(pyth_price_feed),
            dashboard_state,
            subaccount_pubkeys,
            collateral_info_per_subaccount,
            txs_in_flight,
            tx_sig_to_collateral,
            free_collateral_per_subaccount,
        }
    }

    pub async fn run(self) {
        let mut events_rx = self.events_rx;
        let drift: &'static DriftClient = Box::leak(Box::new(self.drift));
        let config = self.config.clone();
        let dlob_notifier = self.dlob_notifier;
        let mut current_slot = 0;
        let mut users = BTreeMap::<Pubkey, UserAccountMetadata>::new();
        let mut oracle_prices = HashMap::<MarketId, OraclePriceMetadata>::new();
        let mut high_risk = HashSet::<Pubkey>::new();
        let liquidation_margin_buffer_ratio = drift
            .state_account()
            .map(|x| x.liquidation_margin_buffer_ratio)
            .expect("State has liquidation_margin_buffer_ratio");

        const RECHECK_CYCLE_INTERVAL: u32 = 1024;

        let mut cycle_count = 0u32;

        // initialize local User storage
        let mut exclude_count = 0;
        let mut initial_high_risk_count = 0;

        let mut last_collateral_refresh_ms: u64 = 0;
        const COLLATERAL_REFRESH_INTERVAL_MS: u64 = 5_000;

        log::info!(target: TARGET, "starting user account initialization");

        drift
            .backend()
            .account_map()
            .iter_accounts_with::<User>(|pubkey, user, _slot| {
                let margin_info = match self
                    .market_state
                    .read()
                    .unwrap()
                    .calculate_simplified_margin_requirement(
                        user,
                        MarginRequirementType::Maintenance,
                        Some(liquidation_margin_buffer_ratio),
                    ) {
                    Ok(info) => info,
                    Err(e) => {
                        std::mem::forget(e);
                        log::warn!(target: TARGET, "margin calc failed for {:?}", pubkey);
                        return;
                    }
                };

                if margin_info.total_collateral < config.min_collateral as i128
                    && margin_info.margin_requirement < config.min_collateral as u128
                {
                    exclude_count += 1;
                    // log::debug!(target: TARGET, "excluding user: {:?}. insignificant collateral: {}/{}", user.authority, margin_info.total_collateral, margin_info.margin_requirement);
                } else {
                    let now_ms = current_time_millis();
                    users.insert(
                        *pubkey,
                        UserAccountMetadata {
                            user: *user,
                            last_updated_slot: 0, // Will be updated when we get first update
                            last_updated_timestamp_ms: now_ms,
                        },
                    );
                    // Check margin status and add to high-risk set if needed
                    let status = check_margin_status(&margin_info);

                    if status.is_at_risk() {
                        high_risk.insert(*pubkey);
                        initial_high_risk_count += 1;
                    }
                }
            });

        log::info!(target: TARGET, "filtered #{exclude_count} accounts with dust collateral");
        log::info!(target: TARGET, "identified #{initial_high_risk_count} high-risk accounts for monitoring");

        // main loop
        let mut event_buffer = Vec::<GrpcEvent>::with_capacity(64);
        let mut oracle_update;

        // Pyth Feed
        let mut pyth_price_feed = match self.pyth_price_feed {
            Some(rx) => rx,
            None => {
                log::error!(target: TARGET, "pyth price feed not initialized");
                return;
            }
        };
        let mut pyth_perp_prices = BTreeMap::<u16, PythPriceUpdate>::new();

        log::info!(target: TARGET, "entering main event loop");

        loop {
            oracle_update = false;

            // Drain pyth updates first (non-blocking)
            'pyth: loop {
                match pyth_price_feed.try_recv() {
                    Ok(update) => {
                        let market_id = update.market_id;
                        let price = update.price;

                        match update.market_type {
                            MarketType::Perp => {
                                pyth_perp_prices.insert(market_id, update);
                                // Update market state with perp pyth price for margin calculation
                                if price > 0 {
                                    self.market_state
                                        .write()
                                        .unwrap()
                                        .set_perp_pyth_price(market_id, price as i64);
                                }
                            }
                            MarketType::Spot => {
                                // Update market state with spot pyth price for margin calculation
                                if price > 0 {
                                    self.market_state
                                        .write()
                                        .unwrap()
                                        .set_spot_pyth_price(market_id, price as i64);
                                }
                            }
                        }
                    }
                    Err(TryRecvError::Disconnected) => {
                        log::error!(target: TARGET, "pyth price feed disconnected");
                        return;
                    }
                    Err(TryRecvError::Empty) => break 'pyth,
                }
            }

            events_rx.recv_many(&mut event_buffer, 64).await;
            for event in event_buffer.drain(..) {
                match event {
                    GrpcEvent::UserUpdate {
                        pubkey,
                        user,
                        slot: update_slot,
                    } => {
                        let now_ms = current_time_millis();
                        if now_ms.saturating_sub(last_collateral_refresh_ms)
                            >= COLLATERAL_REFRESH_INTERVAL_MS
                        {
                            last_collateral_refresh_ms = now_ms;

                            // Update collaterals
                            let new_collateral = get_collateral_info_per_subaccount(
                                &drift,
                                &self.subaccount_pubkeys,
                            )
                            .await;

                            self.collateral_info_per_subaccount.clear();

                            for (subaccount_pubkey, collateral_info) in new_collateral {
                                self.collateral_info_per_subaccount
                                    .insert(subaccount_pubkey, collateral_info);
                            }

                            // Update free collateral accounting for in flight txs
                            for entry in self.collateral_info_per_subaccount.iter() {
                                let subaccount_pubkey = entry.key();
                                let collateral_info = entry.value();
                                let mut free = collateral_info.free;

                                if let Some(in_flight) = self.txs_in_flight.get(subaccount_pubkey) {
                                    for sig in in_flight.value().iter() {
                                        if let Some(reserved) = self.tx_sig_to_collateral.get(sig) {
                                            free = free.saturating_sub(reserved.value().0 as i128);
                                        }
                                    }
                                }
                                self.free_collateral_per_subaccount
                                    .insert(*subaccount_pubkey, free.max(0) as u128);
                            }
                        }

                        let old_user = users.get(&pubkey).map(|m| &m.user);
                        dlob_notifier.user_update(pubkey, old_user, &user, update_slot);
                        let now_ms = current_time_millis();
                        users.insert(
                            pubkey,
                            UserAccountMetadata {
                                user: user.clone(),
                                last_updated_slot: update_slot,
                                last_updated_timestamp_ms: now_ms,
                            },
                        );

                        // Log staleness warnings but allow recalculation
                        if let Some(user_meta) = users.get(&pubkey) {
                            if let Err(staleness_err) =
                                validate_data_freshness(user_meta, &oracle_prices, current_slot)
                            {
                                match staleness_err {
                                    StalenessError::UserAccountStale { age_slots: _ } => {
                                        // log::debug!(
                                        //     target: TARGET,
                                        //     "Recalculating margin for stale user {:?}: user account {} slots old",
                                        //     pubkey, age_slots
                                        // );
                                    }
                                    StalenessError::OraclePriceStale {
                                        market: _,
                                        age_slots: _,
                                    } => {
                                        // log::debug!(
                                        //     target: TARGET,
                                        //     "Recalculating margin for {:?} with stale oracle: {:?} is {} slots old",
                                        //     pubkey, market, age_slots
                                        // );
                                    }
                                    StalenessError::PythPriceStale { .. } => {
                                        // Pyth staleness checked separately
                                    }
                                }
                            }

                            // calculate user margin after update
                            let margin_info = match self
                                .market_state
                                .read()
                                .unwrap()
                                .calculate_simplified_margin_requirement(
                                    &user,
                                    MarginRequirementType::Maintenance,
                                    Some(liquidation_margin_buffer_ratio),
                                ) {
                                Ok(info) => info,
                                Err(e) => {
                                    std::mem::forget(e);
                                    log::warn!(target: TARGET, "margin calc failed for {:?}", pubkey);
                                    continue;
                                }
                            };

                            if margin_info.total_collateral < config.min_collateral as i128
                                && margin_info.margin_requirement < config.min_collateral as u128
                            {
                                // log::debug!(target: TARGET, "filtered account with dust collateral: {pubkey:?}");
                                high_risk.remove(&pubkey);
                                users.remove(&pubkey);
                            } else {
                                let status = check_margin_status(&margin_info);
                                if status.is_liquidatable() {
                                    // log::debug!(target: TARGET, "found liquidatable user: {pubkey:?}, margin:{margin_info:?}");
                                    high_risk.insert(pubkey);
                                } else if status.is_at_risk() {
                                    high_risk.insert(pubkey);
                                } else {
                                    high_risk.remove(&pubkey);
                                }
                            }
                        }
                    }
                    GrpcEvent::OracleUpdate {
                        oracle_price_data,
                        market,
                        slot,
                    } => {
                        log::debug!(target: TARGET, "oracle update received: market={:?}, slot={}", market, slot);
                        if slot >= current_slot {
                            if market.is_perp() {
                                if oracle_price_data.price > 0 {
                                    self.market_state
                                        .write()
                                        .unwrap()
                                        .set_perp_oracle_price(market.index(), oracle_price_data);
                                }
                            } else {
                                if oracle_price_data.price > 0 {
                                    self.market_state
                                        .write()
                                        .unwrap()
                                        .set_spot_oracle_price(market.index(), oracle_price_data);
                                }
                            }
                            let now_ms = current_time_millis();
                            oracle_prices.insert(
                                market,
                                OraclePriceMetadata {
                                    price_data: oracle_price_data,
                                    last_updated_slot: slot,
                                    last_updated_timestamp_ms: now_ms,
                                },
                            );
                            current_slot = slot;
                            oracle_update = true;
                        }
                    }
                    GrpcEvent::PerpMarketUpdate { market, slot } => {
                        if slot >= current_slot {
                            self.market_state.write().unwrap().set_perp_market(market);
                            current_slot = slot;
                        }
                    }
                    GrpcEvent::SpotMarketUpdate { market, slot } => {
                        if slot >= current_slot {
                            self.market_state.write().unwrap().set_spot_market(market);
                            current_slot = slot;
                        }
                    }
                }
            }

            // Only recheck margin for high-risk users on oracle price updates
            // Process in batches to avoid blocking the main event loop
            if oracle_update {
                let _high_risk_count = high_risk.len();

                let _t0 = current_time_millis();
                let mut liquidatable_users = Vec::new();

                // Update dashboard state
                // update_dashboard_state(
                //     drift,
                //     &self.dashboard_state,
                //     &users,
                //     &oracle_prices,
                //     &high_risk,
                //     current_slot,
                //     self.market_state,
                //     liquidation_margin_buffer_ratio,
                // )
                // .await;

                for pubkey in &high_risk {
                    if let Some(user_meta) = users.get(&pubkey) {
                        // Log staleness warnings but allow recalculation
                        if let Err(staleness_err) =
                            validate_data_freshness(user_meta, &oracle_prices, current_slot)
                        {
                            match staleness_err {
                                StalenessError::UserAccountStale { age_slots: _ } => {
                                    // log::debug!(
                                    //     target: TARGET,
                                    //     "Recalculating margin for stale user {:?}: user account {} slots old",
                                    //     pubkey, age_slots
                                    // );
                                }
                                StalenessError::OraclePriceStale {
                                    market: _,
                                    age_slots: _,
                                } => {
                                    // log::debug!(
                                    //     target: TARGET,
                                    //     "Recalculating margin for {:?} with stale oracle: {:?} is {} slots old",
                                    //     pubkey, market, age_slots
                                    // );
                                }
                                StalenessError::PythPriceStale { .. } => {
                                    // Pyth staleness checked separately
                                }
                            }
                        }

                        let margin_info = match self
                            .market_state
                            .read()
                            .unwrap()
                            .calculate_simplified_margin_requirement(
                                &user_meta.user,
                                MarginRequirementType::Maintenance,
                                Some(liquidation_margin_buffer_ratio),
                            ) {
                            Ok(info) => info,
                            Err(e) => {
                                std::mem::forget(e);
                                log::warn!(target: TARGET, "margin calc failed for {:?}", pubkey);
                                continue;
                            }
                        };

                        let status = check_margin_status(&margin_info);
                        if status.is_liquidatable() {
                            // log::debug!(target: TARGET, "found liquidatable user: {pubkey:?}, margin:{margin_info:?}");
                            liquidatable_users.push((pubkey, user_meta.user.clone(), status));
                        }
                    }
                }

                // Send liquidations outside the loop
                for (pubkey, user, status) in liquidatable_users {
                    let pyth_price_update = user
                        .perp_positions
                        .iter()
                        .filter(|p| p.base_asset_amount != 0)
                        .max_by_key(|p| p.quote_asset_amount.abs())
                        .and_then(|p| {
                            pyth_perp_prices.get(&p.market_index).and_then(|pyth_update| {
                                // Validate Pyth price freshness
                                if validate_pyth_price_freshness(pyth_update).is_ok() {
                                    Some(pyth_update.clone())
                                } else {
                                    log::debug!(
                                        target: TARGET,
                                        "Skipping stale Pyth price for market {} in liquidation",
                                        p.market_index
                                    );
                                    None
                                }
                            })
                        });

                    match self.liq_tx.try_send((
                        *pubkey,
                        user,
                        current_slot,
                        current_time_millis(),
                        pyth_price_update,
                        status,
                    )) {
                        Ok(()) => {}
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                            log::warn!(
                                target: TARGET,
                                "liquidation channel full, dropping liquidation for {:?}",
                                pubkey
                            );
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                            log::error!(target: TARGET, "liquidation channel closed");
                        }
                    }
                }

                // log::debug!(
                //     target: TARGET,
                //     "processed {} high-risk margin updates in {}ms",
                //     high_risk_count,
                //     current_time_millis() - t0,
                // );

                // Update high_risk set synchronously but quickly (just remove safe users)
                let _t0 = current_time_millis();
                high_risk.retain(|pubkey| {
                    if let Some(user_meta) = users.get(pubkey) {
                        // Log staleness but still check margin status
                        if let Err(staleness_err) =
                            validate_data_freshness(user_meta, &oracle_prices, current_slot)
                        {
                            match staleness_err {
                                StalenessError::UserAccountStale { age_slots: _ } => {
                                    // log::debug!(
                                    //     target: TARGET,
                                    //     "Checking stale user {:?} for high-risk status: {} slots old",
                                    //     pubkey, age_slots
                                    // );
                                }
                                StalenessError::OraclePriceStale {
                                    market: _,
                                    age_slots: _,
                                } => {
                                    // log::debug!(
                                    //     target: TARGET,
                                    //     "Checking {:?} with stale oracle {:?}: {} slots old",
                                    //     pubkey, market, age_slots
                                    // );
                                }
                                StalenessError::PythPriceStale { .. } => {}
                            }
                        }

                        let margin_info = match self
                            .market_state
                            .read()
                            .unwrap()
                            .calculate_simplified_margin_requirement(
                                &user_meta.user,
                                MarginRequirementType::Maintenance,
                                Some(liquidation_margin_buffer_ratio),
                            ) {
                            Ok(info) => info,
                            Err(e) => {
                                std::mem::forget(e);
                                return false;
                            }
                        };

                        check_margin_status(&margin_info).is_at_risk()
                    } else {
                        false
                    }
                });

                // log::debug!(
                //     target: TARGET,
                //     "updated high_risk set in {}ms (now {} users)",
                //     current_time_millis() - t0,
                //     high_risk.len(),
                // );
            }

            // Every RECHECK_CYCLE_INTERVAL cycles, recheck all users to find new high-risk users
            cycle_count += 1;
            if cycle_count % RECHECK_CYCLE_INTERVAL == 0 {
                let t0 = current_time_millis();
                let mut newly_high_risk = 0;

                // Update dashboard state periodically
                // update_dashboard_state(
                //     drift,
                //     &self.dashboard_state,
                //     &users,
                //     &oracle_prices,
                //     &high_risk,
                //     current_slot,
                //     self.market_state,
                //     liquidation_margin_buffer_ratio,
                // )
                // .await;

                for (pubkey, user_meta) in users.iter() {
                    if high_risk.contains(pubkey) {
                        continue;
                    }

                    // Log staleness warnings but allow recalculation
                    if let Err(staleness_err) =
                        validate_data_freshness(user_meta, &oracle_prices, current_slot)
                    {
                        match staleness_err {
                            StalenessError::UserAccountStale { age_slots: _ } => {
                                // log::debug!(
                                //     target: TARGET,
                                //     "Recalculating margin for stale user {:?}: user account {} slots old",
                                //     pubkey, age_slots
                                // );
                            }
                            StalenessError::OraclePriceStale {
                                market: _,
                                age_slots: _,
                            } => {
                                // log::debug!(
                                //     target: TARGET,
                                //     "Recalculating margin for {:?} with stale oracle: {:?} is {} slots old",
                                //     pubkey, market, age_slots
                                // );
                            }
                            StalenessError::PythPriceStale { .. } => {
                                // Pyth staleness checked separately
                            }
                        }
                    }

                    let margin_info = match self
                        .market_state
                        .read()
                        .unwrap()
                        .calculate_simplified_margin_requirement(
                            &user_meta.user,
                            MarginRequirementType::Maintenance,
                            Some(liquidation_margin_buffer_ratio),
                        ) {
                        Ok(info) => info,
                        Err(e) => {
                            std::mem::forget(e);
                            log::warn!(target: TARGET, "margin calc failed for {:?}", pubkey);
                            continue;
                        }
                    };

                    let status = check_margin_status(&margin_info);

                    if status.is_liquidatable() {
                        high_risk.insert(*pubkey);
                        newly_high_risk += 1;
                        log::info!(target: TARGET, "found liquidatable user: {pubkey:?}, margin:{margin_info:?}");

                        let pyth_price_update = user_meta
                                .user
                                .perp_positions
                                .iter()
                                .filter(|p| p.base_asset_amount != 0)
                                .max_by_key(|p| p.quote_asset_amount.abs())
                                .and_then(|p| {
                                    pyth_perp_prices.get(&p.market_index).and_then(|pyth_update| {
                                        // Validate Pyth price freshness
                                        if validate_pyth_price_freshness(pyth_update).is_ok() {
                                            Some(pyth_update.clone())
                                        } else {
                                            log::debug!(
                                                target: TARGET,
                                                "Skipping stale Pyth price for market {} in liquidation",
                                                p.market_index
                                            );
                                            None
                                        }
                                    })
                                });

                        match self.liq_tx.try_send((
                            *pubkey,
                            user_meta.user.clone(),
                            current_slot,
                            current_time_millis(),
                            pyth_price_update,
                            status,
                        )) {
                            Ok(()) => {}
                            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                log::warn!(
                                    target: TARGET,
                                    "liquidation channel full, dropping liquidation for {:?}",
                                    pubkey
                                );
                            }
                            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                                log::error!(target: TARGET, "liquidation channel closed");
                            }
                        }
                    } else if status.is_at_risk() {
                        high_risk.insert(*pubkey);
                        newly_high_risk += 1;
                    }
                }

                // log::debug!(
                //     target: TARGET,
                //     "margin recheck: checked {} users, {newly_high_risk} newly high-risk, took {}ms",
                //     users.len(),
                //     current_time_millis() - t0
                // );
            }
        }
    }
}

fn clean_stale_in_flight_txs(
    tx_sig_to_collateral: Arc<DashMap<Signature, (u128, u64)>>,
    txs_in_flight: Arc<DashMap<Pubkey, HashSet<Signature>>>,
    free_collateral_per_subaccount: Arc<DashMap<Pubkey, u128>>,
) {
    let now = current_time_millis();
    let timeout_ms = 60_000;

    let stale: Vec<(Signature, u128)> = tx_sig_to_collateral
        .iter()
        .filter_map(|entry| {
            if now.saturating_sub(entry.value().1) > timeout_ms {
                Some((*entry.key(), entry.value().0))
            } else {
                None
            }
        })
        .collect();

    for (sig, collateral) in stale {
        tx_sig_to_collateral.remove(&sig);
        for mut entry in txs_in_flight.iter_mut() {
            if entry.value_mut().remove(&sig) {
                if let Some(mut free) = free_collateral_per_subaccount.get_mut(entry.key()) {
                    *free = free.saturating_add(collateral);
                }
                break;
            }
        }
    }
}

async fn derisk_subaccount(
    drift: &DriftClient,
    tx_sender: &TxSender,
    subaccount: Pubkey,
    priority_fee: u64,
    cu_limit: u32,
) {
    let user = match drift.try_get_account::<User>(&subaccount) {
        Ok(u) => u,
        Err(_) => return,
    };

    for position in user.perp_positions.iter() {
        if position.base_asset_amount == 0 && position.quote_asset_amount == 0 {
            continue;
        }

        let mut tx_builder = TransactionBuilder::new(
            drift.program_data(),
            subaccount,
            std::borrow::Cow::Owned(user.clone()),
            false,
        )
        .with_priority_fee(priority_fee, Some(cu_limit));

        if position.base_asset_amount != 0 {
            let direction = if position.base_asset_amount > 0 {
                PositionDirection::Short
            } else {
                PositionDirection::Long
            };

            tx_builder = tx_builder.place_orders(vec![OrderParams {
                order_type: OrderType::Market,
                market_type: MarketType::Perp,
                direction,
                base_asset_amount: position.base_asset_amount.unsigned_abs(),
                market_index: position.market_index,
                reduce_only: true,
                max_ts: Some((current_time_millis() / 1000 + 15) as i64), // ~15s
                ..Default::default()
            }]);

            tx_sender
                .send_tx(
                    tx_builder.build(),
                    TxIntent::Derisk {
                        market_index: position.market_index,
                        subaccount,
                    },
                    cu_limit as u64,
                )
                .await;
        } else {
            tx_builder = tx_builder.settle_pnl(position.market_index, None, None);

            tx_sender
                .send_tx(
                    tx_builder.build(),
                    TxIntent::SettlePnl {
                        market_index: position.market_index,
                        subaccount,
                    },
                    cu_limit as u64,
                )
                .await;
        }
    }

    // TODO: Add spot derisking, swap any position back to USDC using jupiter/titan
}

fn spawn_derisk_loop(
    drift: DriftClient,
    tx_sender: TxSender,
    subaccounts: Vec<Pubkey>,
    priority_fee_subscriber: Arc<PriorityFeeSubscriber>,
    cu_limit: u32,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            let priority_fee = priority_fee_subscriber.priority_fee_nth(0.6);
            for subaccount in &subaccounts {
                derisk_subaccount(&drift, &tx_sender, *subaccount, priority_fee, cu_limit).await;
            }
        }
    });
}

async fn get_collateral_info_per_subaccount(
    drift: &DriftClient,
    subaccounts: &[Pubkey],
) -> DashMap<Pubkey, CollateralInfo> {
    let collateral_info_per_subaccount = DashMap::<Pubkey, CollateralInfo>::new();
    for &subaccount_pubkey in subaccounts {
        match drift.get_user_account(&subaccount_pubkey).await {
            Ok(user_account) => {
                match calculate_collateral(
                    &drift,
                    &user_account,
                    MarginRequirementType::Maintenance,
                ) {
                    Ok(collateral_info) => {
                        collateral_info_per_subaccount.insert(subaccount_pubkey, collateral_info);
                        log::debug!(
                            target: TARGET,
                            "Subaccount {}: free_collateral = {}, total_collateral = {}",
                            subaccount_pubkey,
                            collateral_info.free,
                            collateral_info.total
                        );
                    }
                    Err(e) => {
                        log::warn!(
                            target: TARGET,
                            "Failed to calculate collateral for subaccount {}: {:?}",
                            subaccount_pubkey,
                            e
                        );
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    target: TARGET,
                    "Failed to load subaccount {}: {:?}",
                    subaccount_pubkey,
                    e
                );
            }
        }
    }
    collateral_info_per_subaccount
}

fn on_transaction_update_fn(
    tx_sender: TxSender,
) -> impl Fn(&TransactionUpdate) + Send + Sync + 'static {
    move |tx: &TransactionUpdate| {
        if let Some(sig) = tx.transaction.signatures.first() {
            tx_sender.confirm_tx((sig.as_slice().try_into()).expect("valid signature"));
        } else {
            log::warn!(target: TARGET, "received tx without sig: {tx:?}");
        }
    }
}

fn on_slot_update_fn(
    dlob_notifier: DLOBNotifier,
    drift: DriftClient,
    market_ids: &[MarketId],
) -> impl Fn(u64) + Send + Sync + 'static {
    let market_ids: Vec<MarketId> = market_ids.to_vec();
    move |new_slot| {
        for market in market_ids.iter() {
            let oracle_price_data = drift
                .try_get_mmoracle_for_perp_market(market.index(), new_slot)
                .unwrap();
            dlob_notifier.slot_and_oracle_update(*market, new_slot, oracle_price_data.price as u64);
        }
    }
}

async fn setup_grpc(
    drift: DriftClient,
    dlob_notifier: DLOBNotifier,
    transaction_tx: TxSender,
    market_ids: Vec<MarketId>,
) -> tokio::sync::mpsc::Receiver<GrpcEvent> {
    let (tx, rx) = tokio::sync::mpsc::channel(102400);

    let _ = tokio::try_join!(
        crate::filler::sync_stats_accounts(&drift),
        crate::filler::sync_user_accounts(&drift, &dlob_notifier),
    );

    let mut oracle_to_market = HashMap::<Pubkey, Vec<(MarketId, OracleSource)>>::default();

    for (market, (oracle, source)) in drift.backend().oracle_map().oracle_by_market.iter() {
        oracle_to_market
            .entry(*oracle)
            .and_modify(|f| f.push((*market, *source)))
            .or_insert(vec![(*market, *source)]);
    }

    log::info!(target: TARGET, "oracle map has {} oracles", oracle_to_market.len());

    let _res = drift
        .grpc_subscribe(
            std::env::var("GRPC_ENDPOINT")
                .unwrap_or_else(|_| "https://api.rpcpool.com".to_string())
                .into(),
            std::env::var("GRPC_X_TOKEN").expect("GRPC_X_TOKEN set"),
            GrpcSubscribeOpts::default()
                .connection_opts(GrpcConnectionOpts::default().enable_compression())
                .commitment(solana_commitment_config::CommitmentLevel::Processed)
                .transaction_include_accounts(vec![drift.wallet().default_sub_account()])
                .on_transaction(on_transaction_update_fn(transaction_tx.clone()))
                .on_slot(on_slot_update_fn(
                    dlob_notifier,
                    drift.clone(),
                    market_ids.as_ref(),
                ))
                .usermap_on()
                .statsmap_on()
                .on_account(
                    AccountFilter::partial().with_discriminator(User::DISCRIMINATOR),
                    {
                        let tx = tx.clone();
                        move |acc| {
                            let user = drift_rs::utils::deser_zero_copy::<User>(acc.data);
                            if let Err(err) = tx.try_send(GrpcEvent::UserUpdate {
                                pubkey: acc.pubkey,
                                user,
                                slot: acc.slot,
                            }) {
                                log::error!(target: TARGET, "failed to forward user update event: {err:?}");
                            }
                        }
                    },
                )
                .on_account(
                    AccountFilter::partial().with_discriminator(PerpMarket::DISCRIMINATOR),
                    {
                        let tx = tx.clone();
                        move |acc| {
                            let market = drift_rs::utils::deser_zero_copy::<PerpMarket>(&acc.data);
                            if let Err(err) = tx.try_send(GrpcEvent::PerpMarketUpdate {
                                market,
                                slot: acc.slot,
                            }) {
                                log::error!(target: TARGET, "failed to forward perp market update event: {err:?}");
                            }
                        }
                    },
                )
                .on_account(
                    AccountFilter::partial().with_discriminator(SpotMarket::DISCRIMINATOR),
                    {
                        let tx = tx.clone();
                        move |acc| {
                            let market = drift_rs::utils::deser_zero_copy::<SpotMarket>(acc.data);
                            if let Err(err) = tx.try_send(GrpcEvent::SpotMarketUpdate {
                                market,
                                slot: acc.slot,
                            }) {
                                log::error!(target: TARGET, "failed to forward spot market update event: {err:?}");
                            }
                        }
                    },
                )
                .on_oracle_update({
                    let tx = tx.clone();
                    move |acc| {
                        let oracle_markets = oracle_to_market
                            .get(&acc.pubkey)
                            .expect("oracle pubkey known");
                        let lamports = acc.lamports;
                        let slot = acc.slot;
                        for (market, oracle_source) in oracle_markets {
                            let mut data = acc.data.to_vec();
                            let mut lamports = lamports;
                            let owner = acc.owner;
                            let pubkey = acc.pubkey;
                            let account_info = anchor_lang::prelude::AccountInfo::new(
                                &pubkey,
                                false,
                                false,
                                &mut lamports,
                                &mut data,
                                &owner,
                                false,
                            );
                            let oracle_price_data = drift::state::oracle::get_oracle_price(
                                oracle_source,
                                &account_info,
                                slot,
                            )
                            .unwrap();
                            if let Err(err) = tx.try_send(GrpcEvent::OracleUpdate {
                                oracle_price_data,
                                market: *market,
                                slot: acc.slot,
                            }) {
                                log::error!(target: TARGET, "failed to forward oracle update event: {err:?}");
                            }
                        }
                    }
                }),
            true,
        )
        .await;

    rx
}

fn spawn_liquidation_worker(
    tx_sender: TxSender,
    strategy: Arc<dyn LiquidationStrategy + Send + Sync>,
    mut liq_rx: tokio::sync::mpsc::Receiver<(
        Pubkey,
        User,
        u64,
        u64,
        Option<PythPriceUpdate>,
        UserMarginStatus,
    )>,
    cu_limit: u32,
    priority_fee_subscriber: Arc<PriorityFeeSubscriber>,
    metrics: Arc<Metrics>,
) {
    let attempt_tracker = Arc::new(DashMap::<Pubkey, LiquidationAttemptTracker>::new());

    tokio::spawn(async move {
        // Periodically clean stale tracker entries (accounts no longer in the liquidation pipeline)
        let mut last_tracker_cleanup_ms = current_time_millis();
        const TRACKER_CLEANUP_INTERVAL_MS: u64 = 60_000;
        const TRACKER_ENTRY_MAX_AGE_MS: u64 = 600_000; // 10 minutes

        while let Some((liquidatee, user_account, slot, ts, pyth_price_update, status)) =
            liq_rx.recv().await
        {
            // Drop entries older than 1 second to handle backpressure
            let now = current_time_millis();
            if now.saturating_sub(ts) > MAX_LIQUIDATION_AGE_MS {
                continue;
            }

            // Clean up old tracker entries periodically
            if now.saturating_sub(last_tracker_cleanup_ms) > TRACKER_CLEANUP_INTERVAL_MS {
                attempt_tracker.retain(|_, tracker| {
                    now.saturating_sub(tracker.last_attempt_ms) < TRACKER_ENTRY_MAX_AGE_MS
                });
                last_tracker_cleanup_ms = now;
            }

            // Check slot-based rate limit AND failure-based cooldown
            if let Some(tracker) = attempt_tracker.get(&liquidatee) {
                // Basic slot rate limit
                if slot.abs_diff(tracker.last_attempt_slot) < LIQUIDATION_SLOT_RATE_LIMIT {
                    log::debug!(target: TARGET, "rate limited liquidation for {:?} (current: {})", liquidatee, slot);
                    continue;
                }

                // Exponential backoff for repeated failures
                if !tracker.is_cooled_down(now) {
                    let remaining_ms = tracker
                        .cooldown_ms()
                        .saturating_sub(now.saturating_sub(tracker.last_attempt_ms));
                    log::debug!(
                        target: TARGET,
                        "backoff: skipping {:?} (failures={}, cooldown={}ms, remaining={}ms)",
                        liquidatee,
                        tracker.consecutive_failures,
                        tracker.cooldown_ms(),
                        remaining_ms
                    );
                    metrics.liquidation_backoff_skips.inc();
                    continue;
                }
            }

            // Record this attempt (increment failure count preemptively; reset on TxSent)
            attempt_tracker
                .entry(liquidatee)
                .and_modify(|t| t.record_attempt(slot))
                .or_insert_with(|| LiquidationAttemptTracker::new(slot));

            let tracker_failures = attempt_tracker
                .get(&liquidatee)
                .map(|t| t.consecutive_failures)
                .unwrap_or(0);

            if tracker_failures > 1 {
                log::info!(
                    target: TARGET,
                    "retrying liquidation for {:?} (attempt #{})",
                    liquidatee,
                    tracker_failures
                );
            }

            let pf = priority_fee_subscriber.priority_fee_nth(0.6);
            let strategy_clone = Arc::clone(&strategy);
            let liquidatee_clone = liquidatee;
            let user_account_clone = Arc::new(user_account);
            let tx_sender_clone = tx_sender.clone();
            let tracker_clone = Arc::clone(&attempt_tracker);
            let metrics_clone = Arc::clone(&metrics);

            tokio::spawn(async move {
                let deadline = std::time::Duration::from_millis(LIQUIDATION_DEADLINE_MS);
                let start = std::time::Instant::now();
                let result = tokio::time::timeout(
                    deadline,
                    strategy_clone.liquidate_user(
                        liquidatee_clone,
                        user_account_clone,
                        tx_sender_clone,
                        pf,
                        cu_limit,
                        slot,
                        pyth_price_update,
                        status,
                    ),
                )
                .await;

                let elapsed = start.elapsed();
                match result {
                    Ok(outcome) => {
                        if elapsed.as_millis() > LIQUIDATION_DEADLINE_MS as u128 {
                            log::warn!(
                                target: TARGET,
                                "liquidation for {:?} took {}ms (exceeded {}ms deadline but completed)",
                                liquidatee_clone,
                                elapsed.as_millis(),
                                LIQUIDATION_DEADLINE_MS
                            );
                        }

                        match &outcome {
                            LiquidationOutcome::TxSent => {
                                // Tx was sent — reset the failure counter so we don't
                                // punish with backoff while the tx is in-flight.
                                // If the tx later fails on-chain, the account will stay
                                // liquidatable and get re-attempted (failure count starts
                                // from 0 again, giving it a fresh chance).
                                if let Some(mut tracker) = tracker_clone.get_mut(&liquidatee_clone)
                                {
                                    tracker.reset();
                                }
                            }
                            LiquidationOutcome::Skipped(reason) => {
                                // Strategy decided not to send a tx — keep the failure
                                // count incrementing so backoff kicks in.
                                log::info!(
                                    target: TARGET,
                                    "liquidation skipped for {:?}: {}",
                                    liquidatee_clone,
                                    reason
                                );
                                metrics_clone
                                    .liquidation_skipped
                                    .with_label_values(&[reason])
                                    .inc();
                            }
                        }
                    }
                    Err(_) => {
                        // Timeout — the backoff failure counter stays incremented
                        log::warn!(
                            target: TARGET,
                            "liquidation for {:?} exceeded {}ms deadline, cancelled",
                            liquidatee_clone,
                            LIQUIDATION_DEADLINE_MS
                        );
                        metrics_clone
                            .liquidation_skipped
                            .with_label_values(&["timeout"])
                            .inc();
                    }
                }
            });
        }
    });
}

enum LiquidationType {
    SettlePnl,
    PerpWithFill,
    PerpTakeover,
    PerpPnlForDeposit,
    BorrowForPerpPnl,
    SpotForSpot,
    Skip,
}

#[derive(Debug, Clone)]
struct PositionInfo {
    market_type: MarketType,
    market_index: u16,
    is_asset: bool,
    collateral_required: i128,
    base_amount: i64,
    quote_amount: i64,
}

/// Primary liquidation strategy
pub struct PrimaryLiquidationStrategy {
    pub drift: DriftClient,
    pub dlob: &'static DLOB,
    pub market_state: Arc<RwLock<MarketState>>,
    pub subaccounts: Vec<Pubkey>,
    pub metrics: Arc<Metrics>,
    pub use_spot_liquidation: bool,
    pub txs_in_flight: Arc<DashMap<Pubkey, HashSet<Signature>>>,
    // Map(Signature,(collateral, ts))
    pub tx_sig_to_collateral: Arc<DashMap<Signature, (u128, u64)>>,
    pub free_collateral_per_subaccount: Arc<DashMap<Pubkey, u128>>,
}

impl PrimaryLiquidationStrategy {
    /// Liquidation policy: Prefer takeover for small positions, use makers for large positions,
    /// fallback to takeover when no makers available. Skip if no makers and insufficient collateral.
    fn decide_perp_method(
        quote_asset_amount: u64,
        collateral_available: u128,
        collateral_required: u128,
        has_makers: bool,
    ) -> LiquidationType {
        // const POSITION_AMOUNT_THRESHOLD: u64 = 5_000 * QUOTE_PRECISION_U64;

        // let is_small_position = quote_asset_amount <= POSITION_AMOUNT_THRESHOLD;
        // let can_afford_takeover = collateral_available >= collateral_required;

        // if is_small_position && can_afford_takeover {
        //     LiquidationType::PerpTakeover
        // } else if has_makers {
        //     LiquidationType::PerpWithFill
        // } else if can_afford_takeover {
        //     LiquidationType::PerpTakeover
        // } else {
        //     LiquidationType::Skip
        // }

        // For testing just use Fill
        LiquidationType::PerpWithFill
    }

    fn decide_liquidation_type(
        liability: &PositionInfo,
        asset: Option<&PositionInfo>,
        has_pnl_only: bool,
    ) -> LiquidationType {
        if has_pnl_only {
            return LiquidationType::SettlePnl;
        }
        match (liability.market_type, asset.map(|a| a.market_type)) {
            (MarketType::Perp, None) => LiquidationType::PerpTakeover,
            (MarketType::Perp, Some(MarketType::Spot)) => LiquidationType::PerpPnlForDeposit,
            (MarketType::Spot, Some(MarketType::Perp)) => LiquidationType::BorrowForPerpPnl,
            (MarketType::Spot, Some(MarketType::Spot)) => LiquidationType::SpotForSpot,
            _ => LiquidationType::Skip,
        }
    }

    fn calculate_perp_collateral_requirement(
        market_state: Arc<RwLock<MarketState>>,
        market_index: u16,
        base_asset_amount: i64,
    ) -> Option<u128> {
        let state = market_state.read().unwrap().load();

        let perp_market = state.perp_market(market_index)?;
        let oracle = state.perp_oracle(market_index)?;

        let margin_ratio = perp_market
            .get_margin_ratio(
                base_asset_amount.unsigned_abs() as u128,
                MarginRequirementType::Initial,
            )
            .ok()?;

        let collateral = (base_asset_amount.abs() as u128)
            .saturating_mul(oracle.price as u128)
            .saturating_mul(QUOTE_PRECISION)
            .saturating_mul(margin_ratio as u128)
            .saturating_div(MARGIN_PRECISION_U128)
            .saturating_div(PRICE_PRECISION)
            .saturating_div(BASE_PRECISION);

        Some(collateral)
    }

    fn extract_collateral_params(
        market_state: Arc<RwLock<MarketState>>,
        liability: &PositionInfo,
        asset: &PositionInfo,
    ) -> (i64, u128, u128, u128, i64, u128, u128, u128) {
        let state = market_state.read().unwrap().load();

        let (liability_oracle, liability_precision) = if liability.market_type == MarketType::Spot {
            let oracle = state
                .spot_oracle(liability.market_index)
                .expect("liability oracle");
            let market = state
                .spot_market(liability.market_index)
                .expect("liability market");
            (oracle.price, 10_u128.pow(market.decimals))
        } else {
            let oracle = state.spot_oracle(0).expect("USDC oracle");
            (oracle.price, QUOTE_PRECISION)
        };

        let liability_weight = if liability.market_type == MarketType::Spot {
            let market = state
                .spot_market(liability.market_index)
                .expect("liability spot market");
            market.initial_liability_weight as u128
        } else {
            1u128
        };

        let (asset_oracle, asset_precision) = if asset.market_type == MarketType::Spot {
            let oracle = state.spot_oracle(asset.market_index).expect("asset oracle");
            let market = state.spot_market(asset.market_index).expect("asset market");
            (oracle.price, 10_u128.pow(market.decimals))
        } else {
            let oracle = state.spot_oracle(0).expect("USDC oracle");
            (oracle.price, QUOTE_PRECISION)
        };

        let (asset_weight, asset_weight_precision) = if asset.market_type == MarketType::Spot {
            let market = state
                .spot_market(asset.market_index)
                .expect("asset spot market");
            (
                market.initial_asset_weight as u128,
                SPOT_WEIGHT_PRECISION_U128,
            )
        } else {
            (SPOT_WEIGHT_PRECISION_U128, SPOT_WEIGHT_PRECISION_U128)
        };

        (
            liability_oracle,
            liability_precision,
            liability_weight,
            SPOT_WEIGHT_PRECISION_U128,
            asset_oracle,
            asset_precision,
            asset_weight,
            asset_weight_precision,
        )
    }

    fn calculate_net_collateral_requirement_with_params(
        liability_size: u128,
        liability: &PositionInfo,
        asset: &PositionInfo,
        liability_oracle_price: i64,
        liability_precision: u128,
        liability_weight: u128,
        liability_weight_precision: u128,
        asset_oracle_price: i64,
        asset_precision: u128,
        asset_weight: u128,
        asset_weight_precision: u128,
    ) -> i128 {
        let asset_amount_back_in_tokens = liability_size
            .saturating_mul(liability_oracle_price as u128)
            .saturating_div(asset_oracle_price as u128)
            .saturating_mul(asset_precision)
            .saturating_div(liability_precision);

        let asset_amount_back_in_collateral = asset_amount_back_in_tokens
            .saturating_mul(asset_oracle_price as u128)
            .saturating_mul(QUOTE_PRECISION)
            .saturating_mul(asset_weight)
            .saturating_div(asset_weight_precision)
            .saturating_div(asset_precision)
            .saturating_div(PRICE_PRECISION);

        let liability_collateral_impact = if liability.market_type == MarketType::Spot {
            liability_size
                .saturating_mul(liability_oracle_price as u128)
                .saturating_div(PRICE_PRECISION)
                .saturating_mul(QUOTE_PRECISION)
                .saturating_div(liability_precision)
                .saturating_mul(liability_weight)
                .saturating_div(liability_weight_precision)
        } else {
            liability
                .collateral_required
                .unsigned_abs()
                .min(liability_size)
        };

        let net_impact = liability_collateral_impact.saturating_sub(
            asset_amount_back_in_collateral.min(asset.collateral_required.unsigned_abs()),
        );

        net_impact as i128
    }

    fn calculate_net_collateral_requirement(
        liability_size: u128,
        liability: &PositionInfo,
        asset: &PositionInfo,
        market_state: Arc<RwLock<MarketState>>,
    ) -> i128 {
        let (l_oracle, l_prec, l_weight, l_weight_prec, a_oracle, a_prec, a_weight, a_weight_prec) =
            Self::extract_collateral_params(market_state, liability, asset);

        Self::calculate_net_collateral_requirement_with_params(
            liability_size,
            liability,
            asset,
            l_oracle,
            l_prec,
            l_weight,
            l_weight_prec,
            a_oracle,
            a_prec,
            a_weight,
            a_weight_prec,
        )
    }

    /// finds the max liquidation amount whose collateral impact fits within available collateral,
    /// allowing unused collateral up to `tolerance`.
    fn find_max_liq_amount<F>(
        max_amount: u128,
        available_collateral: i128,
        tolerance: i128,
        impact_fn: F,
    ) -> u128
    where
        F: Fn(u128) -> i128,
    {
        let mut low = 0u128;
        let mut high = max_amount;
        let mut best = 0u128;

        while low <= high {
            let mid = (low + high) / 2;
            let impact = impact_fn(mid);
            let difference = available_collateral - impact;

            if difference < 0 {
                if mid == 0 {
                    break;
                }
                high = mid - 1;
            } else {
                best = mid;

                if difference > tolerance {
                    low = mid + 1;
                } else {
                    break;
                }
            }
        }

        best
    }

    /// Calculate collateral requirement for all perp positions
    fn get_perp_positions_info(
        market_state: Arc<RwLock<MarketState>>,
        perp_positions: &[PerpPosition],
    ) -> Vec<PositionInfo> {
        let state = market_state.read().unwrap().load();

        perp_positions
            .iter()
            .filter(|p| p.base_asset_amount != 0 || p.quote_asset_amount != 0)
            .filter_map(|pos| {
                let perp_market = state.perp_market(pos.market_index)?;
                let oracle = state.perp_oracle(pos.market_index)?;

                if pos.base_asset_amount == 0 && pos.quote_asset_amount != 0 {
                    let _usdc = state.spot_market(0)?;

                    let claimable_pnl_available: i128 = match pos.get_claimable_pnl(oracle.price, 0)
                    {
                        Ok(pnl) => pnl.abs(),
                        Err(_) => 0,
                    };

                    Some(PositionInfo {
                        market_type: MarketType::Perp,
                        market_index: pos.market_index,
                        is_asset: claimable_pnl_available > 0,
                        collateral_required: claimable_pnl_available,
                        base_amount: 0,
                        quote_amount: pos.quote_asset_amount,
                    })
                } else {
                    let margin_ratio = perp_market
                        .get_margin_ratio(
                            pos.base_asset_amount.unsigned_abs() as u128,
                            MarginRequirementType::Initial,
                        )
                        .ok()?;

                    let collateral = (pos.base_asset_amount.abs() as u128)
                        .saturating_mul(oracle.price as u128)
                        .saturating_mul(QUOTE_PRECISION)
                        .saturating_mul(margin_ratio as u128)
                        .saturating_div(MARGIN_PRECISION_U128)
                        .saturating_div(PRICE_PRECISION)
                        .saturating_div(BASE_PRECISION);

                    Some(PositionInfo {
                        market_type: MarketType::Perp,
                        market_index: pos.market_index,
                        is_asset: pos.quote_asset_amount > 0,
                        collateral_required: collateral as i128,
                        base_amount: pos.base_asset_amount,
                        quote_amount: pos.quote_asset_amount,
                    })
                }
            })
            .collect()
    }

    /// Calculate collateral required for all spot positions
    fn get_spot_positions_info(
        market_state: Arc<RwLock<MarketState>>,
        spot_positions: &[SpotPosition],
    ) -> Vec<PositionInfo> {
        let state = market_state.read().unwrap().load();

        spot_positions
            .iter()
            .filter(|p| !p.is_available())
            .filter_map(|pos| {
                let spot_market = state.spot_market(pos.market_index)?;
                let oracle = state.spot_oracle(pos.market_index)?;

                let token_amount = pos.get_signed_token_amount(&spot_market).ok()?;

                let token_precision = 10_u128.pow(spot_market.decimals);
                let weight = if pos.balance_type == SpotBalanceType::Deposit {
                    spot_market.initial_asset_weight
                } else {
                    spot_market.initial_liability_weight
                };

                let collateral_impact = (token_amount.abs() as u128)
                    .saturating_mul(oracle.price as u128)
                    .saturating_div(PRICE_PRECISION)
                    .saturating_mul(QUOTE_PRECISION)
                    .saturating_div(token_precision)
                    .saturating_mul(weight as u128)
                    .saturating_div(SPOT_WEIGHT_PRECISION_U128);

                Some(PositionInfo {
                    market_type: MarketType::Spot,
                    market_index: pos.market_index,
                    is_asset: pos.balance_type == SpotBalanceType::Deposit,
                    collateral_required: collateral_impact as i128,
                    base_amount: token_amount as i64,
                    quote_amount: 0,
                })
            })
            .collect()
    }

    // Port of  https://github.com/drift-labs/protocol-v2/blob/master/sdk/src/user.ts#L3941-L3971
    fn get_safest_tiers(user_account: &User, drift: &DriftClient) -> (u8, u8) {
        let mut safest_perp_tier = 4;
        let mut safest_spot_tier = 4;

        for perp_position in user_account
            .perp_positions
            .iter()
            .filter(|p| !p.is_available())
        {
            if let Some(perp_market) = drift
                .program_data()
                .perp_market_config_by_index(perp_position.market_index)
            {
                safest_perp_tier = safest_perp_tier.min(perp_market.contract_tier.to_number());
            }
        }

        for spot_position in user_account
            .spot_positions
            .iter()
            .filter(|p| !p.is_available() && p.balance_type != SpotBalanceType::Deposit)
        {
            if let Some(spot_market) = drift
                .program_data()
                .spot_market_config_by_index(spot_position.market_index)
            {
                safest_spot_tier = safest_spot_tier.min(spot_market.asset_tier.to_number());
            }
        }

        (safest_perp_tier, safest_spot_tier)
    }

    /// Pick the largest liability and best matching asset
    fn pick_best_asset_liability_combo(
        market_state: Arc<RwLock<MarketState>>,
        perp_positions: &[PositionInfo],
        spot_positions: &[PositionInfo],
        safest_perp_tier: u8,
        safest_spot_tier: u8,
    ) -> Option<(PositionInfo, Option<PositionInfo>)> {
        let state = market_state.read().unwrap().load();

        let (mut liabilities, mut assets): (Vec<PositionInfo>, Vec<PositionInfo>) = perp_positions
            .iter()
            .chain(spot_positions)
            .cloned()
            .partition(|p| !p.is_asset);

        liabilities.sort_by(|a, b| {
            b.collateral_required
                .abs()
                .cmp(&a.collateral_required.abs())
        });

        assets.sort_by(|a, b| {
            b.collateral_required
                .abs()
                .cmp(&a.collateral_required.abs())
        });

        let largest_liability = liabilities.into_iter().find(|liability| {
            if liability.market_type == MarketType::Spot {
                true
            } else {
                match state.perp_market(liability.market_index) {
                    Some(perp_market) => perp_tier_is_as_safe_as(
                        perp_market.contract_tier.to_number(),
                        safest_perp_tier,
                        safest_spot_tier,
                    ),
                    None => false,
                }
            }
        })?;

        let best_asset = assets.first().cloned();

        Some((largest_liability, best_asset))
    }

    /// Returns the subaccount with most free collateral that has position room
    fn find_best_subaccount_for_liquidation(
        drift: &DriftClient,
        subaccounts: &[Pubkey],
        needs_perp_room: bool,
        needs_spot_room: bool,
        free_collateral_per_subaccount: &DashMap<Pubkey, u128>,
        min_collateral_required: u128,
    ) -> Option<Pubkey> {
        let mut candidates: Vec<(Pubkey, u128)> = subaccounts
            .iter()
            .filter_map(|&subaccount| {
                let Some(free_collateral_info) = free_collateral_per_subaccount.get(&subaccount)
                else {
                    return None;
                };

                if *free_collateral_info < min_collateral_required {
                    return None;
                }

                let user = drift.try_get_account::<User>(&subaccount).ok()?;

                if needs_perp_room {
                    let active_perp_positions = user
                        .perp_positions
                        .iter()
                        .filter(|p| p.base_asset_amount != 0 || p.quote_asset_amount != 0)
                        .count();

                    if active_perp_positions >= 8 {
                        return None;
                    }
                }

                if needs_spot_room {
                    let active_spot_positions = user
                        .spot_positions
                        .iter()
                        .filter(|p| !p.is_available())
                        .count();

                    if active_spot_positions >= 8 {
                        return None;
                    }
                }

                Some((subaccount, *free_collateral_info))
            })
            .collect();

        if candidates.is_empty() {
            return None;
        }

        candidates.sort_by_key(|&(_, free_collateral)| std::cmp::Reverse(free_collateral));

        Some(candidates[0].0)
    }

    /// Find top makers for a perp position
    fn find_top_makers(
        drift: &DriftClient,
        dlob: &'static DLOB,
        market_state: Arc<RwLock<MarketState>>,
        market_index: u16,
        base_asset_amount: i64,
    ) -> Option<Vec<User>> {
        let l3_book = dlob.get_l3_snapshot_safe(market_index, MarketType::Perp)?;

        let oracle_price = {
            let state = market_state.read().unwrap();
            match state.get_perp_oracle_price(market_index) {
                Some(data) if data.price > 0 => data.price as u64,
                _ => return None,
            }
        };

        let maker_pubkeys: Vec<Pubkey> = if base_asset_amount >= 0 {
            // only want maker orders so don't pass vamm or trigger price
            l3_book
                .asks(Some(oracle_price), None, None)
                .filter(|o| o.is_maker())
                .map(|m| m.user)
                .take(3)
                .collect()
        } else {
            l3_book
                .bids(Some(oracle_price), None, None)
                .filter(|o| o.is_maker())
                .map(|m| m.user)
                .take(3)
                .collect()
        };

        if maker_pubkeys.is_empty() {
            log::warn!(target: TARGET, "no makers found. market={}", market_index);
            return None;
        }

        let makers: Vec<User> = maker_pubkeys
            .iter()
            .filter_map(|p| drift.try_get_account::<User>(p).ok())
            .collect();

        if makers.is_empty() {
            log::warn!(target: TARGET, "no maker accounts. market={}", market_index);
            return None;
        }

        Some(makers)
    }

    /// Try to fill liquidation with order match
    async fn try_liquidate_with_match(
        drift: &DriftClient,
        market_index: u16,
        subaccount: Pubkey,
        liquidatee_subaccount: Pubkey,
        top_makers: &[User],
        tx_sender: TxSender,
        priority_fee: u64,
        cu_limit: u32,
        slot: u64,
        pyth_price_update: Option<PythPriceUpdate>,
    ) {
        if top_makers.is_empty() {
            log::debug!(target: TARGET, "skip empty maker cross. market={market_index} user={liquidatee_subaccount}");
            return;
        }

        let keeper_account_data = drift.try_get_account::<User>(&subaccount);
        if keeper_account_data.is_err() {
            log::debug!(target: TARGET, "keeper acc lookup failed={subaccount:?}");
            return;
        }
        let liquidatee_subaccount_data = drift.try_get_account::<User>(&liquidatee_subaccount);
        if liquidatee_subaccount_data.is_err() {
            log::debug!(target: TARGET, "liquidatee acc lookup failed={liquidatee_subaccount:?}");
            return;
        }

        let mut tx_builder = TransactionBuilder::new(
            drift.program_data(),
            subaccount,
            std::borrow::Cow::Owned(keeper_account_data.unwrap()),
            false,
        )
        .with_priority_fee(priority_fee, Some(cu_limit));

        if let Some(ref update) = pyth_price_update {
            tx_builder =
                tx_builder.post_pyth_lazer_oracle_update(&[update.feed_id], &update.message);
        }

        tx_builder = tx_builder.liquidate_perp_with_fill(
            market_index,
            &liquidatee_subaccount_data.unwrap(),
            top_makers,
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

        // Fill doesn't require collateral management
        tx_sender
            .send_tx(
                tx,
                TxIntent::LiquidateWithFill {
                    market_index,
                    liquidatee: liquidatee_subaccount,
                    slot,
                },
                cu_limit as u64,
            )
            .await;
    }

    /// Try to liquidate by taking over position
    async fn try_liquidate_with_collateral(
        &self,
        drift: &DriftClient,
        market_index: u16,
        subaccount: Pubkey,
        liquidatee_subaccount: Pubkey,
        base_asset_amount: u64,
        collateral_required: u128,
        tx_sender: TxSender,
        priority_fee: u64,
        cu_limit: u32,
        slot: u64,
        pyth_price_update: Option<PythPriceUpdate>,
    ) {
        let keeper_account_data = drift.try_get_account::<User>(&subaccount);
        if keeper_account_data.is_err() {
            log::debug!(target: TARGET, "keeper acc lookup failed={subaccount:?}");
            return;
        }
        let liquidatee_subaccount_data = drift.try_get_account::<User>(&liquidatee_subaccount);
        if liquidatee_subaccount_data.is_err() {
            log::debug!(target: TARGET, "liquidatee acc lookup failed={liquidatee_subaccount:?}");
            return;
        }

        let mut tx_builder = TransactionBuilder::new(
            drift.program_data(),
            subaccount,
            std::borrow::Cow::Owned(keeper_account_data.unwrap()),
            false,
        )
        .with_priority_fee(priority_fee, Some(cu_limit));

        if let Some(ref update) = pyth_price_update {
            tx_builder =
                tx_builder.post_pyth_lazer_oracle_update(&[update.feed_id], &update.message);
        }

        tx_builder = tx_builder.liquidate_perp(
            market_index,
            &liquidatee_subaccount_data.unwrap(),
            base_asset_amount,
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

        match tx_sender
            .send_tx(
                tx,
                TxIntent::LiquidatePerp {
                    market_index,
                    liquidatee: liquidatee_subaccount,
                    slot,
                },
                cu_limit as u64,
            )
            .await
        {
            Some(sig) => {
                self.txs_in_flight
                    .entry(subaccount)
                    .or_insert_with(HashSet::new)
                    .insert(sig);

                self.tx_sig_to_collateral
                    .insert(sig, (base_asset_amount as u128, current_time_millis()));

                if let Some(mut free) = self.free_collateral_per_subaccount.get_mut(&subaccount) {
                    *free = free.saturating_sub(collateral_required);
                }
            }
            None => return,
        };
    }

    /// Attempt perp liquidation with order matching or collateral
    async fn liquidate_perp(
        &self,
        drift: &DriftClient,
        dlob: &'static DLOB,
        market_state: Arc<RwLock<MarketState>>,
        metrics: Arc<Metrics>,
        subaccounts: &[Pubkey],
        liquidatee: Pubkey,
        user_account: Arc<User>,
        tx_sender: TxSender,
        priority_fee: u64,
        cu_limit: u32,
        slot: u64,
        pyth_price_update: Option<PythPriceUpdate>,
        status: &UserMarginStatus,
    ) {
        let Some(subaccount) = subaccounts.first() else {
            log::warn!(target: TARGET, "no subaccount configured");
            return;
        };

        // Check isolated liquidations first
        for (market_index, iso_status) in &status.isolated {
            if *iso_status == MarginStatus::Liquidatable {
                if let Some(pos) = user_account.perp_positions.iter().find(|p| {
                    p.market_index == *market_index && p.isolated_position_scaled_balance != 0
                }) {
                    metrics
                        .liquidation_attempts
                        .with_label_values(&["perp"])
                        .inc();

                    log::info!(
                        target: TARGET,
                        "attempting perp liquidation (isolated): user={:?}, market={}, base_asset_amount={}",
                        liquidatee,
                        market_index,
                        pos.base_asset_amount,
                    );

                    let Some(makers) = Self::find_top_makers(
                        drift,
                        dlob,
                        Arc::clone(&market_state),
                        *market_index,
                        pos.base_asset_amount,
                    ) else {
                        return;
                    };

                    let oracle_price = {
                        let state = market_state.read().unwrap();
                        match state.get_perp_oracle_price(pos.market_index) {
                            Some(data) if data.price > 0 => data.price as u64,
                            _ => {
                                log::warn!(target: TARGET, "invalid oracle price for market {}", pos.market_index);
                                return;
                            }
                        }
                    };

                    let pyth_update =
                        pyth_price_update.filter(|update| update.price != oracle_price);

                    Self::try_liquidate_with_match(
                        drift,
                        *market_index,
                        *subaccount,
                        liquidatee,
                        makers.as_slice(),
                        tx_sender,
                        priority_fee,
                        cu_limit,
                        slot,
                        pyth_update,
                    )
                    .await;
                    return;
                }
            }
        }

        // Cross margin
        if status.cross != MarginStatus::Liquidatable {
            return;
        }

        let Some(pos) = user_account
            .perp_positions
            .iter()
            .filter(|p| p.base_asset_amount != 0)
            .max_by_key(|p| p.quote_asset_amount)
        else {
            log::info!(
                target: TARGET,
                "no perp positions with base_asset_amount for {:?}, skipping perp liquidation",
                liquidatee
            );
            return;
        };

        log::info!(
            target: TARGET,
            "attempting perp liquidation: user={:?}, market={}, base_asset_amount={}, quote_asset_amount={}",
            liquidatee,
            pos.market_index,
            pos.base_asset_amount,
            pos.quote_asset_amount,
        );

        // Calculate collateral required
        let Some(collateral_required) = Self::calculate_perp_collateral_requirement(
            Arc::clone(&market_state),
            pos.market_index,
            pos.base_asset_amount,
        ) else {
            log::warn!(target: TARGET, "failed to calculate collateral requirement for market {}", pos.market_index);
            return;
        };

        // Check available collateral
        let Some(free_collateral) = self.free_collateral_per_subaccount.get(&subaccount) else {
            log::warn!(target: TARGET, "no free collateral for keeper subaccount");
            return;
        };

        // Get oracle price and pyth update once
        let oracle_price = {
            let state = market_state.read().unwrap();
            match state.get_perp_oracle_price(pos.market_index) {
                Some(data) if data.price > 0 => data.price as u64,
                _ => {
                    log::warn!(target: TARGET, "invalid oracle price for market {}", pos.market_index);
                    return;
                }
            }
        };

        // Find makers and decide method
        let makers = Self::find_top_makers(
            drift,
            dlob,
            Arc::clone(&market_state),
            pos.market_index,
            pos.base_asset_amount,
        );

        let pyth_update = pyth_price_update.filter(|update| update.price != oracle_price);

        let method = Self::decide_perp_method(
            pos.quote_asset_amount.try_into().unwrap(),
            *free_collateral,
            collateral_required,
            makers.is_some(),
        );

        metrics
            .liquidation_attempts
            .with_label_values(&["perp"])
            .inc();

        match method {
            LiquidationType::PerpWithFill => {
                Self::try_liquidate_with_match(
                    drift,
                    pos.market_index,
                    *subaccount,
                    liquidatee,
                    makers.unwrap().as_slice(),
                    tx_sender,
                    priority_fee,
                    cu_limit,
                    slot,
                    pyth_update,
                )
                .await;
            }
            LiquidationType::PerpTakeover => {
                let Some(subaccount) = Self::find_best_subaccount_for_liquidation(
                    drift,
                    subaccounts,
                    true,
                    false,
                    &self.free_collateral_per_subaccount,
                    collateral_required,
                ) else {
                    log::warn!(target: TARGET, "no subaccount available for takeover");
                    return;
                };

                let Some(free_collateral) = self.free_collateral_per_subaccount.get(&subaccount)
                else {
                    log::warn!(target: TARGET, "no free collateral for subaccount");
                    return;
                };

                let base_amount_to_liquidate = if *free_collateral >= collateral_required {
                    pos.base_asset_amount.unsigned_abs()
                } else {
                    let scaled_collateral = (*free_collateral as f64 * 0.9) as u128;
                    let scale_factor = scaled_collateral as f64 / collateral_required as f64;
                    (pos.base_asset_amount.unsigned_abs() as f64 * scale_factor) as u64
                };

                Self::try_liquidate_with_collateral(
                    &self,
                    &drift,
                    pos.market_index,
                    subaccount,
                    liquidatee,
                    base_amount_to_liquidate,
                    collateral_required,
                    tx_sender,
                    priority_fee,
                    cu_limit,
                    slot,
                    pyth_update,
                )
                .await;
            }
            _ => {
                log::info!(target: TARGET, "skipping liquidation for {:?}", liquidatee);
            }
        }
    }

    /// Attempt spot liquidation with Jupiter swap
    async fn liquidate_spot(
        drift: DriftClient,
        metrics: Arc<Metrics>,
        market_state: Arc<RwLock<MarketState>>,
        subaccounts: &[Pubkey],
        liquidatee: Pubkey,
        user_account: Arc<User>,
        tx_sender: TxSender,
        priority_fee: u64,
        cu_limit: u32,
        slot: u64,
    ) {
        let authority = drift.wallet.authority();
        let Some(subaccount) = subaccounts.first() else {
            log::warn!(target: TARGET, "no subaccount configured");
            return;
        };

        for pos in user_account
            .spot_positions
            .iter()
            .filter(|p| matches!(p.balance_type, SpotBalanceType::Borrow) && !p.is_available())
        {
            // skip permanently blocked markets
            if BLOCKED_SPOT_MARKETS.contains(&pos.market_index) {
                continue;
            }

            let spot_market = {
                let state = market_state.read().unwrap();
                let state_data = state.load();
                match state_data.spot_market(pos.market_index) {
                    Some(m) => *m,
                    None => continue,
                }
            };

            let token_amount = match pos.get_token_amount(&spot_market) {
                Ok(amount) => amount as u64,
                Err(_) => continue,
            };

            // Filter dust positions
            if token_amount < spot_market.min_order_size * 2 {
                // log::debug!(
                //     target: TARGET,
                //     "skip dust spot position. market={}, amount={}",
                //     pos.market_index,
                //     token_amount
                // );
                continue;
            }

            metrics
                .liquidation_attempts
                .with_label_values(&["spot"])
                .inc();

            // Find their largest deposit to use as collateral
            let Some(asset_market_index) = user_account
                .spot_positions
                .iter()
                .filter(|p| matches!(p.balance_type, SpotBalanceType::Deposit) && !p.is_available())
                .max_by_key(|p| p.scaled_balance)
                .map(|p| p.market_index)
            else {
                log::warn!(
                    target: TARGET,
                    "no asset found for user {:?}, skipping spot liquidation",
                    liquidatee
                );
                continue;
            };

            log::info!(
                target: TARGET,
                "attempting spot liquidation: user={:?}, asset_market={}, liability_market={}, amount={}",
                liquidatee,
                asset_market_index,
                pos.market_index,
                token_amount
            );

            // Fetch accounts once
            let keeper_account_data = match drift.try_get_account::<User>(&subaccount) {
                Ok(data) => data,
                Err(_) => {
                    log::info!(target: TARGET, "keeper account not found: {:?}", &subaccount);
                    continue;
                }
            };

            let liquidatee_account_data = match drift.try_get_account::<User>(&liquidatee) {
                Ok(data) => data,
                Err(_) => {
                    log::info!(target: TARGET, "liquidatee account not found: {liquidatee:?}");
                    continue;
                }
            };

            // Fetch market configs inside async block to avoid lifetime issues
            let asset_spot_market = drift
                .program_data()
                .spot_market_config_by_index(asset_market_index)
                .expect("asset spot market");

            let liability_market_index = pos.market_index;

            let liability_spot_market = drift
                .program_data()
                .spot_market_config_by_index(liability_market_index)
                .expect("liability spot market");

            let in_token_account =
                drift_rs::Wallet::derive_associated_token_address(authority, asset_spot_market);
            let out_token_account =
                drift_rs::Wallet::derive_associated_token_address(authority, liability_spot_market);

            let t0 = std::time::Instant::now();
            let (jupiter_result, titan_result) = tokio::join!(
                drift.jupiter_swap_query(
                    &authority,
                    token_amount,
                    SwapMode::ExactIn,
                    100,
                    asset_market_index,
                    liability_market_index,
                    Some(true),
                    None,
                    None,
                ),
                drift.titan_swap_query(
                    &authority,
                    token_amount,
                    Some(50),
                    titan::SwapMode::ExactIn,
                    100,
                    asset_market_index,
                    liability_market_index,
                    Some(true),
                    None,
                    None,
                )
            );

            let quote_latency_ms = t0.elapsed().as_millis() as i64;
            metrics.swap_quote_latency_ms.set(quote_latency_ms);

            if jupiter_result.is_err() && titan_result.is_err() {
                metrics.jupiter_quote_failures.inc();
                metrics.titan_quote_failures.inc();
                log::warn!(target: TARGET, "both quotes failed after {}ms", quote_latency_ms);
                continue;
            }

            let use_titan = match (&jupiter_result, &titan_result) {
                (Ok(jup), Ok(titan)) => {
                    let use_titan = titan.quote.out_amount > jup.quote.out_amount;
                    // log::debug!(
                    //     target: TARGET,
                    //     "got quotes in {}ms - jup: {}, titan: {} - using {}",
                    //     quote_latency_ms,
                    //     jup.quote.out_amount,
                    //     titan.quote.out_amount,
                    //     if use_titan { "titan" } else { "jupiter" }
                    // );
                    use_titan
                }
                (Ok(_), Err(e)) => {
                    metrics.titan_quote_failures.inc();
                    log::warn!(target: TARGET, "titan failed in {}ms, using jupiter: {:?}", quote_latency_ms, e);
                    false
                }
                (Err(e), Ok(_)) => {
                    metrics.jupiter_quote_failures.inc();
                    log::warn!(target: TARGET, "jupiter failed in {}ms, using titan: {:?}", quote_latency_ms, e);
                    true
                }
                _ => unreachable!(),
            };

            let tx = if use_titan {
                TransactionBuilder::new(
                    drift.program_data(),
                    *subaccount,
                    std::borrow::Cow::Owned(keeper_account_data),
                    false,
                )
                .with_priority_fee(priority_fee, Some(cu_limit))
                .titan_swap_liquidate(
                    titan_result.unwrap(),
                    asset_spot_market,
                    liability_spot_market,
                    &in_token_account,
                    &out_token_account,
                    asset_market_index,
                    liability_market_index,
                    &liquidatee_account_data,
                )
                .build()
            } else {
                TransactionBuilder::new(
                    drift.program_data(),
                    *subaccount,
                    std::borrow::Cow::Owned(keeper_account_data),
                    false,
                )
                .with_priority_fee(priority_fee, Some(cu_limit))
                .jupiter_swap_liquidate(
                    jupiter_result.unwrap(),
                    asset_spot_market,
                    liability_spot_market,
                    &in_token_account,
                    &out_token_account,
                    asset_market_index,
                    liability_market_index,
                    &liquidatee_account_data,
                )
                .build()
            };
            // log::debug!(
            //     target: TARGET,
            //     "sending spot liq tx: {liquidatee:?}, asset={asset_market_index}, liability={}",
            //     liability_market_index
            // );

            tx_sender
                .send_tx(
                    tx,
                    TxIntent::LiquidateSpot {
                        asset_market_index,
                        liability_market_index,
                        liquidatee,
                        slot,
                    },
                    cu_limit as u64,
                )
                .await;
        }
    }

    async fn try_liquidate_perp_pnl_for_deposit(
        &self,
        drift: &DriftClient,
        subaccount: Pubkey,
        liquidatee: Pubkey,
        liability: &PositionInfo,
        asset: &PositionInfo,
        liq_amount: u128,
        tx_sender: TxSender,
        priority_fee: u64,
        cu_limit: u32,
        slot: u64,
        pyth_price_update: Option<PythPriceUpdate>,
    ) {
        let keeper_account = match drift.try_get_account::<User>(&subaccount) {
            Ok(data) => data,
            Err(_) => {
                log::warn!(target: TARGET, "keeper account not found");
                return;
            }
        };

        let liquidatee_account = match drift.try_get_account::<User>(&liquidatee) {
            Ok(data) => data,
            Err(_) => {
                log::warn!(target: TARGET, "liquidatee account not found");
                return;
            }
        };

        let mut tx_builder = TransactionBuilder::new(
            drift.program_data(),
            subaccount,
            std::borrow::Cow::Owned(keeper_account),
            false,
        )
        .with_priority_fee(priority_fee, Some(cu_limit));

        if let Some(ref update) = pyth_price_update {
            tx_builder =
                tx_builder.post_pyth_lazer_oracle_update(&[update.feed_id], &update.message);
        }

        tx_builder = tx_builder.liquidate_perp_pnl_for_deposit(
            &liquidatee_account,
            liability.market_index,
            asset.market_index,
            u128::from(liq_amount),
            None,
        );

        let tx = tx_builder.build();

        match tx_sender
            .send_tx(
                tx,
                TxIntent::LiquidatePerpPnlForDeposit {
                    perp_market_index: liability.market_index,
                    spot_market_index: asset.market_index,
                    liquidatee,
                    slot,
                },
                cu_limit as u64,
            )
            .await
        {
            Some(sig) => {
                self.txs_in_flight
                    .entry(subaccount)
                    .or_insert_with(HashSet::new)
                    .insert(sig);

                self.tx_sig_to_collateral
                    .insert(sig, (liq_amount, current_time_millis()));

                if let Some(mut free) = self.free_collateral_per_subaccount.get_mut(&subaccount) {
                    *free = free.saturating_sub(liq_amount);
                }
            }
            None => return,
        };
    }

    /// Attempt perp pnl for deposit liquidation
    async fn liquidate_perp_pnl_for_deposit(
        &self,
        drift: &DriftClient,
        market_state: Arc<RwLock<MarketState>>,
        subaccounts: &[Pubkey],
        liquidatee: Pubkey,
        liability: PositionInfo,
        asset: PositionInfo,
        tx_sender: TxSender,
        priority_fee: u64,
        cu_limit: u32,
        slot: u64,
        pyth_price_update: Option<PythPriceUpdate>,
    ) {
        let net_collateral_req = Self::calculate_net_collateral_requirement(
            liability.collateral_required.unsigned_abs(),
            &liability,
            &asset,
            Arc::clone(&market_state),
        );

        let Some(subaccount) = Self::find_best_subaccount_for_liquidation(
            drift,
            subaccounts,
            false,
            true,
            &self.free_collateral_per_subaccount,
            net_collateral_req.max(0) as u128,
        ) else {
            return;
        };

        let Some(free_collateral) = self.free_collateral_per_subaccount.get(&subaccount) else {
            return;
        };

        let available = *free_collateral as i128;
        let tolerance = available / 10;

        let params = Self::extract_collateral_params(Arc::clone(&market_state), &liability, &asset);

        let liq_amount = if net_collateral_req <= available {
            liability.collateral_required.unsigned_abs()
        } else {
            Self::find_max_liq_amount(
                liability.collateral_required.unsigned_abs(),
                available,
                tolerance,
                |size| {
                    Self::calculate_net_collateral_requirement_with_params(
                        size, &liability, &asset, params.0, params.1, params.2, params.3, params.4,
                        params.5, params.6, params.7,
                    )
                },
            )
        };

        if liq_amount == 0 {
            return;
        }

        Self::try_liquidate_perp_pnl_for_deposit(
            &self,
            drift,
            subaccount,
            liquidatee,
            &liability,
            &asset,
            liq_amount,
            tx_sender,
            priority_fee,
            cu_limit,
            slot,
            pyth_price_update,
        )
        .await;
    }

    async fn try_liquidate_borrow_for_perp_pnl(
        &self,
        drift: &DriftClient,
        subaccount: Pubkey,
        liquidatee: Pubkey,
        liability: &PositionInfo,
        asset: &PositionInfo,
        liq_amount: u128,
        tx_sender: TxSender,
        priority_fee: u64,
        cu_limit: u32,
        slot: u64,
        pyth_price_update: Option<PythPriceUpdate>,
    ) {
        let keeper_account = match drift.try_get_account::<User>(&subaccount) {
            Ok(data) => data,
            Err(_) => {
                log::warn!(target: TARGET, "keeper account not found");
                return;
            }
        };

        let liquidatee_account = match drift.try_get_account::<User>(&liquidatee) {
            Ok(data) => data,
            Err(_) => {
                log::warn!(target: TARGET, "liquidatee account not found");
                return;
            }
        };

        let mut tx_builder = TransactionBuilder::new(
            drift.program_data(),
            subaccount,
            std::borrow::Cow::Owned(keeper_account),
            false,
        )
        .with_priority_fee(priority_fee, Some(cu_limit));

        if let Some(ref update) = pyth_price_update {
            tx_builder =
                tx_builder.post_pyth_lazer_oracle_update(&[update.feed_id], &update.message);
        }

        tx_builder = tx_builder.liquidate_borrow_for_perp_pnl(
            &liquidatee_account,
            asset.market_index,
            liability.market_index,
            u128::from(liq_amount),
            None,
        );

        let tx = tx_builder.build();

        match tx_sender
            .send_tx(
                tx,
                TxIntent::LiquidateBorrowForPerpPnl {
                    perp_market_index: asset.market_index,
                    spot_market_index: liability.market_index,
                    liquidatee,
                    slot,
                },
                cu_limit as u64,
            )
            .await
        {
            Some(sig) => {
                self.txs_in_flight
                    .entry(subaccount)
                    .or_insert_with(HashSet::new)
                    .insert(sig);

                self.tx_sig_to_collateral
                    .insert(sig, (liq_amount, current_time_millis()));

                if let Some(mut free) = self.free_collateral_per_subaccount.get_mut(&subaccount) {
                    *free = free.saturating_sub(liq_amount);
                }
            }
            None => return,
        };
    }

    /// Attempt borrow for perp pnl liquidation
    async fn liquidate_borrow_for_perp_pnl(
        &self,
        drift: &DriftClient,
        market_state: Arc<RwLock<MarketState>>,
        subaccounts: &[Pubkey],
        liquidatee: Pubkey,
        liability: PositionInfo,
        asset: PositionInfo,
        tx_sender: TxSender,
        priority_fee: u64,
        cu_limit: u32,
        slot: u64,
        pyth_price_update: Option<PythPriceUpdate>,
    ) {
        let net_collateral_req = Self::calculate_net_collateral_requirement(
            liability.base_amount.unsigned_abs() as u128,
            &liability,
            &asset,
            Arc::clone(&market_state),
        );

        let Some(subaccount) = Self::find_best_subaccount_for_liquidation(
            drift,
            subaccounts,
            true,
            false,
            &self.free_collateral_per_subaccount,
            net_collateral_req.max(0) as u128,
        ) else {
            return;
        };

        let Some(free_collateral) = self.free_collateral_per_subaccount.get(&subaccount) else {
            return;
        };

        let available = *free_collateral as i128;
        let tolerance = available / 10;

        let params = Self::extract_collateral_params(Arc::clone(&market_state), &liability, &asset);

        let liq_amount = if net_collateral_req <= available {
            liability.collateral_required.unsigned_abs()
        } else {
            Self::find_max_liq_amount(
                liability.collateral_required.unsigned_abs(),
                available,
                tolerance,
                |size| {
                    Self::calculate_net_collateral_requirement_with_params(
                        size, &liability, &asset, params.0, params.1, params.2, params.3, params.4,
                        params.5, params.6, params.7,
                    )
                },
            )
        };

        if liq_amount == 0 {
            return;
        }

        Self::try_liquidate_borrow_for_perp_pnl(
            &self,
            drift,
            subaccount,
            liquidatee,
            &liability,
            &asset,
            liq_amount,
            tx_sender,
            priority_fee,
            cu_limit,
            slot,
            pyth_price_update,
        )
        .await;
    }

    // Settle perp pnl
    async fn settle_perp_pnl(
        drift: &DriftClient,
        subaccount: Pubkey,
        liquidatee: Pubkey,
        market_indexes: &[u16],
        tx_sender: TxSender,
        priority_fee: u64,
        cu_limit: u32,
    ) {
        let keeper_account = match drift.try_get_account::<User>(&subaccount) {
            Ok(data) => data,
            Err(_) => {
                log::warn!(target: TARGET, "keeper account not found");
                return;
            }
        };

        let liquidatee_account = match drift.try_get_account::<User>(&liquidatee) {
            Ok(data) => data,
            Err(_) => {
                log::warn!(target: TARGET, "liquidatee account not found");
                return;
            }
        };

        let mut tx_builder = TransactionBuilder::new(
            drift.program_data(),
            subaccount,
            std::borrow::Cow::Owned(keeper_account),
            false,
        )
        .with_priority_fee(priority_fee, Some(cu_limit));

        for &market_index in market_indexes {
            tx_builder =
                tx_builder.settle_pnl(market_index, Some(&liquidatee), Some(&liquidatee_account));
        }

        let tx = tx_builder.build();

        tx_sender
            .send_tx(
                tx,
                TxIntent::SettlePnl {
                    market_index: market_indexes[0],
                    subaccount: liquidatee,
                },
                cu_limit as u64,
            )
            .await;
    }
}

impl LiquidationStrategy for PrimaryLiquidationStrategy {
    fn liquidate_user<'a>(
        &'a self,
        liquidatee: Pubkey,
        user_account: Arc<User>,
        tx_sender: TxSender,
        priority_fee: u64,
        cu_limit: u32,
        slot: u64,
        pyth_price_update: Option<PythPriceUpdate>,
        status: UserMarginStatus,
    ) -> futures_util::future::BoxFuture<'a, LiquidationOutcome> {
        let perp_positions = Self::get_perp_positions_info(
            Arc::clone(&self.market_state),
            &user_account.perp_positions,
        );

        let spot_positions = Self::get_spot_positions_info(
            Arc::clone(&self.market_state),
            &user_account.spot_positions,
        );

        let (safest_perp_tier, safest_spot_tier) =
            Self::get_safest_tiers(&user_account, &self.drift);

        let Some((liability, asset)) = Self::pick_best_asset_liability_combo(
            Arc::clone(&self.market_state),
            &perp_positions,
            &spot_positions,
            safest_perp_tier,
            safest_spot_tier,
        ) else {
            // Possibility of PerpWithFill still exists since doesn't depend on best asset/liability
            // Attempt liquidation, if none exist it will guard and fail internally
            return async move {
                Self::liquidate_perp(
                    &self,
                    &self.drift,
                    self.dlob,
                    Arc::clone(&self.market_state),
                    Arc::clone(&self.metrics),
                    self.subaccounts.as_slice(),
                    liquidatee,
                    Arc::clone(&user_account),
                    tx_sender,
                    priority_fee,
                    cu_limit,
                    slot,
                    pyth_price_update,
                    &status,
                )
                .await;
                // We attempted the perp path — tx may or may not have been sent internally,
                // but we report TxSent since we did attempt the strategy.
                LiquidationOutcome::TxSent
            }
            .boxed();
        };

        let has_pnl_only = perp_positions
            .iter()
            .any(|p| p.base_amount == 0 && p.quote_amount != 0 && p.is_asset)
            && spot_positions.iter().filter(|s| !s.is_asset).count() == 0;

        let liq_type = Self::decide_liquidation_type(&liability, asset.as_ref(), has_pnl_only);

        async move {
            match liq_type {
                // LiquidationType::SettlePnl => {
                //     let markets: Vec<u16> = perp_positions
                //         .iter()
                //         .filter(|p| p.base_amount == 0 && p.quote_amount != 0 && p.is_asset)
                //         .map(|p| p.market_index)
                //         .collect();

                //     Self::settle_perp_pnl(
                //         &self.drift,
                //         self.subaccounts[0],
                //         liquidatee,
                //         &markets,
                //         tx_sender,
                //         priority_fee,
                //         cu_limit,
                //     )
                //     .await;
                // }
                LiquidationType::PerpTakeover | LiquidationType::PerpWithFill => {
                    Self::liquidate_perp(
                        &self,
                        &self.drift,
                        self.dlob,
                        Arc::clone(&self.market_state),
                        Arc::clone(&self.metrics),
                        self.subaccounts.as_slice(),
                        liquidatee,
                        Arc::clone(&user_account),
                        tx_sender.clone(),
                        priority_fee,
                        cu_limit,
                        slot,
                        pyth_price_update,
                        &status,
                    )
                    .await;
                    LiquidationOutcome::TxSent
                }
                LiquidationType::SpotForSpot => {
                    if self.use_spot_liquidation {
                        Self::liquidate_spot(
                            self.drift.clone(),
                            Arc::clone(&self.metrics),
                            Arc::clone(&self.market_state),
                            self.subaccounts.as_slice(),
                            liquidatee,
                            user_account,
                            tx_sender.clone(),
                            priority_fee,
                            400_000,
                            slot,
                        )
                        .await;
                        LiquidationOutcome::TxSent
                    } else {
                        LiquidationOutcome::Skipped("spot_liquidation_disabled")
                    }
                }
                LiquidationType::SettlePnl => {
                    LiquidationOutcome::Skipped("settle_pnl_not_implemented")
                }
                LiquidationType::PerpPnlForDeposit => {
                    // if let Some(asset) = asset {
                    //     Self::liquidate_perp_pnl_for_deposit(...)
                    // }
                    LiquidationOutcome::Skipped("perp_pnl_for_deposit_not_implemented")
                }
                LiquidationType::BorrowForPerpPnl => {
                    // if let Some(asset) = asset {
                    //     Self::liquidate_borrow_for_perp_pnl(...)
                    // }
                    LiquidationOutcome::Skipped("borrow_for_perp_pnl_not_implemented")
                }
                LiquidationType::Skip => LiquidationOutcome::Skipped("no_viable_strategy"),
            }
        }
        .boxed()
    }
}
