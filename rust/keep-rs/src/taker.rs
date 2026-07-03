//! Taker Bot — sends randomized small market orders to simulate taker flow
//!
//! Companion to the `--quoter` bot (which posts resting ±N bps two-sided limits
//! around the oracle, i.e. the market-maker side). The taker periodically
//! crosses the spread with small **market** orders so devnet sees realistic
//! two-sided flow: the quoter's resting quotes (or the AMM) get filled, mark
//! TWAPs warm toward the live oracle, and AMM inventory builds up — exactly the
//! state the e2e scenarios in `velocity-rs/tests/devnet_e2e.rs` need but cannot
//! orchestrate from CI alone.
//!
//! Behaviour per tick, per configured market:
//!   - read the subaccount's current perp position,
//!   - pick a direction: random coin-flip, **unless** `|position|` has reached
//!     the rebalance threshold (see below), in which case the side that
//!     *reduces* inventory is forced and the order is sent `reduce_only` so it
//!     can only shrink the position, never flip it. This makes the flow
//!     mean-reverting and keeps the position bounded instead of drifting to one
//!     side and getting stuck,
//!   - when a market is stuck one-sided (`|position|` ≥ threshold) it is logged
//!     at INFO so an operator can see the bot is actively unwinding it,
//!   - place one market order of `taker_size_base` with auction params left to
//!     the program to derive (so it routes through the normal
//!     fill/auction path and a filler — local or deployed — matches it).
//!
//! The **rebalance threshold** is `rebalance_base_per_market` when set,
//! otherwise `taker_max_base_per_market`. Set both to 0 to disable the
//! inventory bound entirely (pure random flow). `--dry-run` logs the intended
//! order without sending.
//!
//! Randomness is a dependency-free splitmix64 seeded from the wall clock mixed
//! with the market index — good enough for direction coin-flips; the
//! mean-reversion bound, not the RNG quality, is what bounds risk.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use velocity_rs::{
    types::{
        accounts::User, MarketId, MarketType, OrderParams, OrderType, PerpPosition,
        PositionDirection,
    },
    Pubkey, TransactionBuilder, VelocityClient,
};

use crate::{Config, UseMarkets};

const TARGET: &str = "taker";

pub struct TakerBot {
    velocity: VelocityClient,
    config: Config,
    subaccount: Pubkey,
    markets: Vec<u16>,
}

impl TakerBot {
    pub async fn new(config: Config, velocity: VelocityClient) -> Self {
        let requested: Vec<u16> = match config.use_markets() {
            UseMarkets::All => velocity
                .get_all_perp_market_ids()
                .into_iter()
                .map(|m| m.index())
                .collect(),
            UseMarkets::Subset(m) => m
                .into_iter()
                .filter(|m| m.is_perp())
                .map(|m| m.index())
                .collect(),
        };
        // Drop any requested perp market not registered in this context's
        // program data (mirrors the quoter): the oracle path would otherwise
        // return a confusing `InvalidOracle` for a missing market config.
        let program_data = velocity.program_data();
        let (markets, missing): (Vec<u16>, Vec<u16>) = requested
            .into_iter()
            .partition(|idx| program_data.perp_market_config_by_index(*idx).is_some());
        if !missing.is_empty() {
            log::warn!(
                target: TARGET,
                "skipping perp markets not registered in program data: {missing:?} (network={})",
                if config.mainnet { "mainnet" } else { "devnet" },
            );
        }
        let subaccount = velocity.wallet.sub_account(config.sub_account_id);
        log::info!(
            target: TARGET,
            "taker starting: subaccount={subaccount}, markets={markets:?}, \
             size_base={}, interval_secs={}, max_base_per_market={}",
            config.taker_size_base,
            config.taker_interval_secs,
            config.taker_max_base_per_market,
        );
        TakerBot {
            velocity,
            config,
            subaccount,
            markets,
        }
    }

    pub async fn run(self) {
        let mut ticker =
            tokio::time::interval(Duration::from_secs(self.config.taker_interval_secs));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(err) = self.tick().await {
                log::warn!(target: TARGET, "tick failed: {err}");
            }
        }
    }

    async fn tick(&self) -> Result<(), String> {
        let user = self
            .velocity
            .get_user_account(&self.subaccount)
            .await
            .map_err(|e| format!("user: {e:?}"))?;

        for &market_index in &self.markets {
            if let Err(e) = self.take_market(&user, market_index).await {
                log::warn!(target: TARGET, "take_market {market_index} failed: {e}");
            }
        }
        Ok(())
    }

    async fn take_market(&self, user: &User, market_index: u16) -> Result<(), String> {
        let size = self.config.taker_size_base;
        if size == 0 {
            return Ok(());
        }
        let base_position = find_position(user, market_index)
            .map(|p| p.base_asset_amount)
            .unwrap_or(0);

        let threshold = self.rebalance_threshold();
        let stuck = threshold > 0 && base_position.unsigned_abs() >= threshold;
        if stuck {
            log::info!(
                target: TARGET,
                "market {market_index}: stuck one-sided, position={base_position} \
                 (threshold={threshold}); forcing reduce-only order to rebalance",
            );
        }

        let direction = self.choose_direction(market_index, base_position);

        // Market order, auction params left to the program to derive
        // (direction-correct sanitization). A filler — local or the deployed
        // devnet one — matches it against resting quotes or the AMM. When stuck
        // one-sided the forced order is `reduce_only` so a chunk larger than the
        // remaining position can't overshoot flat and re-open the other side.
        let order = OrderParams {
            order_type: OrderType::Market,
            market_type: MarketType::Perp,
            market_index,
            direction,
            base_asset_amount: size,
            reduce_only: stuck,
            ..Default::default()
        };

        let mut tx = TransactionBuilder::new(
            self.velocity.program_data(),
            self.subaccount,
            std::borrow::Cow::Owned(*user),
            false,
        )
        .with_priority_fee(self.config.priority_fee, Some(self.config.fill_cu_limit));
        // The order touches a market we may hold no position in; force-include it
        // so the place ix sees the perp market account (same reason as the quoter).
        tx.force_include_markets(&[MarketId::perp(market_index)], &[]);
        tx = tx.place_orders(vec![order]);
        let msg = tx.build();

        if self.config.dry {
            log::info!(
                target: TARGET,
                "[dry] market {market_index}: would take {direction:?} size={size} (position={base_position})",
            );
            return Ok(());
        }
        match self.velocity.sign_and_send(msg).await {
            Ok(sig) => {
                log::info!(
                    target: TARGET,
                    "market {market_index}: took {direction:?} size={size} (position={base_position}) sig={sig}",
                );
                Ok(())
            }
            Err(e) => Err(format!("send: {e:?}")),
        }
    }

    /// Coin-flip direction, overridden to the inventory-reducing side once
    /// `|position|` reaches the rebalance threshold (0 = no bound → always
    /// random). This is what mean-reverts the position toward flat.
    fn choose_direction(&self, market_index: u16, base_position: i64) -> PositionDirection {
        let threshold = self.rebalance_threshold() as i64;
        if threshold > 0 && base_position >= threshold {
            return PositionDirection::Short;
        }
        if threshold > 0 && base_position <= -threshold {
            return PositionDirection::Long;
        }
        if rand_bit(market_index) {
            PositionDirection::Long
        } else {
            PositionDirection::Short
        }
    }

    /// Inventory level (BASE_PRECISION) past which a position counts as stuck
    /// one-sided and the taker forces the reducing side. Prefers the dedicated
    /// `rebalance_base_per_market`, falling back to the `taker_max_base_per_market`
    /// cap so existing single-knob configs keep their current behaviour.
    fn rebalance_threshold(&self) -> u64 {
        if self.config.rebalance_base_per_market > 0 {
            self.config.rebalance_base_per_market
        } else {
            self.config.taker_max_base_per_market
        }
    }
}

fn find_position(user: &User, market_index: u16) -> Option<&PerpPosition> {
    user.perp_positions
        .iter()
        .find(|p| p.market_index == market_index)
}

/// Dependency-free coin-flip: splitmix64 over (wall-clock nanos ⊕ market index).
fn rand_bit(salt: u16) -> bool {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut z = nanos ^ ((salt as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    z & 1 == 1
}
