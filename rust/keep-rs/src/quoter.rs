//! Quoter Bot — posts wide two-sided limit orders around the oracle
//!
//! Simulates market-maker flow on devnet by placing resting limits at ±N bps
//! around the oracle for each configured perp market and refreshing them
//! every `quote_refresh_secs`. Two safety caps prevent runaway inventory:
//!
//! - **Per-market base cap** (`quote_max_base_per_market`): after a
//!   hypothetical fill on a given side, |position| must stay within the cap.
//!   Set to `0` to disable.
//! - **Global gross-notional cap** (`quote_max_gross_notional`, in
//!   QUOTE_PRECISION): Σ |base_i × oracle_i| across all markets after a
//!   hypothetical fill must stay within the cap. To enforce a leverage limit,
//!   set this to `collateral_usd * max_leverage`. Set to `0` to disable.

use std::time::Duration;

use drift_rs::{
    math::constants::{BASE_PRECISION_U64, PRICE_PRECISION_U64, QUOTE_PRECISION},
    types::{
        accounts::User, MarketId, MarketType, OrderParams, OrderType, PerpPosition,
        PositionDirection, PostOnlyParam, SpotBalanceType,
    },
    DriftClient, Pubkey, TransactionBuilder,
};

use crate::{Config, UseMarkets};

const TARGET: &str = "quoter";
const USER_ORDER_ID_BID: u8 = 201;
const USER_ORDER_ID_ASK: u8 = 202;

pub struct QuoterBot {
    drift: DriftClient,
    config: Config,
    subaccount: Pubkey,
    markets: Vec<u16>,
}

struct MarketSnapshot {
    market_index: u16,
    oracle_price: u64,
    tick_size: u64,
    target_bid: u64,
    target_ask: u64,
    base_position: i64,
}

impl QuoterBot {
    pub async fn new(config: Config, drift: DriftClient) -> Self {
        let requested: Vec<u16> = match config.use_markets() {
            UseMarkets::All => drift
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
        // program data. Without this, every tick would log a confusing
        // `InvalidOracle` — the oracle path returns that when the perp market
        // config is missing, not when the oracle account itself is bad.
        let program_data = drift.program_data();
        let (markets, missing): (Vec<u16>, Vec<u16>) = requested
            .into_iter()
            .partition(|idx| program_data.perp_market_config_by_index(*idx).is_some());
        if !missing.is_empty() {
            log::warn!(
                target: TARGET,
                "skipping perp markets not registered in program data: {missing:?} \
                 (network={:?})",
                if config.mainnet { "mainnet" } else { "devnet" },
            );
        }
        for &idx in &markets {
            let pm = program_data
                .perp_market_config_by_index(idx)
                .expect("filtered above");
            log::info!(
                target: TARGET,
                "perp {idx}: pda={} oracle={}",
                pm.pubkey,
                pm.oracle,
            );
        }
        let subaccount = drift.wallet.sub_account(config.sub_account_id);
        log::info!(
            target: TARGET,
            "quoter starting: subaccount={subaccount}, markets={markets:?}, \
             spread_bps={}, refresh_secs={}, size_base={}, \
             max_base_per_market={}, max_gross_notional={}",
            config.quote_spread_bps,
            config.quote_refresh_secs,
            config.quote_size_base,
            config.quote_max_base_per_market,
            config.quote_max_gross_notional,
        );
        QuoterBot {
            drift,
            config,
            subaccount,
            markets,
        }
    }

    pub async fn run(self) {
        if let Err(e) = self.log_deposits().await {
            log::warn!(target: TARGET, "could not check deposits at startup: {e}");
        }
        let mut ticker = tokio::time::interval(Duration::from_secs(self.config.quote_refresh_secs));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(err) = self.tick().await {
                log::warn!(target: TARGET, "tick failed: {err}");
            }
        }
    }

    /// Read the subaccount's spot balances once and log them so the operator
    /// can tell at a glance whether the bot is funded. Warns if total deposit
    /// notional is zero or below `LOW_DEPOSIT_USD`.
    async fn log_deposits(&self) -> Result<(), String> {
        const LOW_DEPOSIT_USD: u128 = 10 * QUOTE_PRECISION as u128;

        let user = self
            .drift
            .get_user_account(&self.subaccount)
            .await
            .map_err(|e| format!("user: {e:?}"))?;

        let mut total_deposit_usd: u128 = 0;
        let mut any_position = false;
        for pos in user.spot_positions.iter().filter(|p| !p.is_available()) {
            any_position = true;
            let spot_market = self
                .drift
                .try_get_spot_market_account(pos.market_index)
                .map_err(|e| format!("spot market {}: {e:?}", pos.market_index))?;
            let token_amount = pos
                .get_signed_token_amount(&spot_market)
                .map_err(|e| format!("token amount {}: {e:?}", pos.market_index))?;
            let oracle = self
                .drift
                .oracle_price(MarketId::spot(pos.market_index))
                .await
                .map_err(|e| format!("spot oracle {}: {e:?}", pos.market_index))?
                .max(0) as u128;
            let token_precision = 10_u128.pow(spot_market.decimals);
            let notional_usd = token_amount.unsigned_abs().saturating_mul(oracle) / token_precision;
            let is_deposit = pos.balance_type == SpotBalanceType::Deposit;
            if is_deposit {
                total_deposit_usd = total_deposit_usd.saturating_add(notional_usd);
            }
            log::info!(
                target: TARGET,
                "spot balance: market={} kind={} tokens={} usd={}",
                pos.market_index,
                if is_deposit { "deposit" } else { "borrow" },
                token_amount,
                notional_usd,
            );
        }

        if !any_position || total_deposit_usd == 0 {
            log::warn!(
                target: TARGET,
                "subaccount {} has NO deposits — quoter cannot post orders. \
                 Deposit collateral on drift devnet before running.",
                self.subaccount,
            );
        } else if total_deposit_usd < LOW_DEPOSIT_USD {
            log::warn!(
                target: TARGET,
                "subaccount {} has LOW deposits: total={} (QUOTE_PRECISION, ~${})",
                self.subaccount,
                total_deposit_usd,
                total_deposit_usd / QUOTE_PRECISION as u128,
            );
        } else {
            log::info!(
                target: TARGET,
                "subaccount {} total deposit notional={} (~${})",
                self.subaccount,
                total_deposit_usd,
                total_deposit_usd / QUOTE_PRECISION as u128,
            );
        }
        Ok(())
    }

    async fn tick(&self) -> Result<(), String> {
        let user = self
            .drift
            .get_user_account(&self.subaccount)
            .await
            .map_err(|e| format!("user: {e:?}"))?;

        // Gather per-market state up front so the global gross-notional cap
        // can see every market before committing any quotes.
        let mut snapshots: Vec<MarketSnapshot> = Vec::with_capacity(self.markets.len());
        for &market_index in &self.markets {
            match self.snapshot_market(market_index, &user).await {
                Ok(s) => snapshots.push(s),
                Err(e) => log::warn!(target: TARGET, "snapshot {market_index}: {e}"),
            }
        }

        let current_gross = snapshots
            .iter()
            .map(|s| notional_abs(s.base_position, s.oracle_price))
            .sum::<u128>();
        let max_gross = self.config.quote_max_gross_notional as u128;
        let mut projected_gross = current_gross;

        log::debug!(
            target: TARGET,
            "tick: markets={}, current_gross_notional={current_gross} (cap={max_gross})",
            snapshots.len(),
        );

        for snap in &snapshots {
            if let Err(e) = self
                .quote_market(&user, snap, &mut projected_gross, max_gross)
                .await
            {
                log::warn!(target: TARGET, "quote_market {} failed: {e}", snap.market_index);
            }
        }
        Ok(())
    }

    async fn snapshot_market(
        &self,
        market_index: u16,
        user: &User,
    ) -> Result<MarketSnapshot, String> {
        let oracle = self
            .drift
            .oracle_price(MarketId::perp(market_index))
            .await
            .map_err(|e| format!("oracle: {e:?}"))?;
        if oracle <= 0 {
            return Err(format!("non-positive oracle {oracle}"));
        }
        let oracle_price = oracle as u64;
        let perp_market = self
            .drift
            .get_perp_market_account(market_index)
            .await
            .map_err(|e| format!("perp market: {e:?}"))?;
        let tick_size = perp_market.order_tick_size.max(1);
        let spread = self.config.quote_spread_bps as u64;
        let bid_raw = oracle_price.saturating_sub(oracle_price * spread / 10_000);
        let ask_raw = oracle_price + oracle_price * spread / 10_000;
        let target_bid = (bid_raw / tick_size) * tick_size;
        let target_ask = ask_raw.div_ceil(tick_size) * tick_size;
        let base_position = find_position(user, market_index)
            .map(|p| p.base_asset_amount)
            .unwrap_or(0);
        Ok(MarketSnapshot {
            market_index,
            oracle_price,
            tick_size: _assert_tick(tick_size),
            target_bid,
            target_ask,
            base_position,
        })
    }

    async fn quote_market(
        &self,
        user: &User,
        snap: &MarketSnapshot,
        projected_gross: &mut u128,
        max_gross: u128,
    ) -> Result<(), String> {
        let size = self.config.quote_size_base;
        let refresh_bps = self.config.quote_refresh_bps as u64;

        let (bid_needed, bid_replace) = evaluate_side(
            user,
            snap.market_index,
            USER_ORDER_ID_BID,
            snap.target_bid,
            snap.oracle_price,
            refresh_bps,
        );
        let (ask_needed, ask_replace) = evaluate_side(
            user,
            snap.market_index,
            USER_ORDER_ID_ASK,
            snap.target_ask,
            snap.oracle_price,
            refresh_bps,
        );

        // Risk-gate each side: a bid fill would take base_position → +size;
        // an ask fill would take it → -size.
        let bid_ok = bid_needed
            && self.side_within_caps(
                snap,
                snap.base_position.saturating_add(size as i64),
                projected_gross,
                max_gross,
            );
        let ask_ok = ask_needed
            && self.side_within_caps(
                snap,
                snap.base_position.saturating_sub(size as i64),
                projected_gross,
                max_gross,
            );

        if !bid_needed && !ask_needed {
            return Ok(());
        }

        let mut tx = TransactionBuilder::new(
            self.drift.program_data(),
            self.subaccount,
            std::borrow::Cow::Owned(user.clone()),
            false,
        )
        .with_priority_fee(self.config.priority_fee, Some(self.config.fill_cu_limit));

        // drift-rs's `cancel_orders_by_user_id` does not inject the target
        // perp market into remaining_accounts (and `build_accounts` only
        // scans user positions, not user.orders), so a cancel on a market
        // where we hold no position fails on-chain with PerpMarketNotFound.
        // Force-include this market so both the cancel and place ixs see it.
        tx.force_include_markets(&[MarketId::perp(snap.market_index)], &[]);

        let mut replace_ids = Vec::new();
        if bid_replace {
            replace_ids.push(USER_ORDER_ID_BID);
        }
        if ask_replace {
            replace_ids.push(USER_ORDER_ID_ASK);
        }
        if !replace_ids.is_empty() {
            tx = tx.cancel_orders_by_user_id(replace_ids.clone());
        }

        let mut orders = Vec::new();
        if bid_ok {
            orders.push(make_limit(
                snap.market_index,
                PositionDirection::Long,
                snap.target_bid,
                size,
                USER_ORDER_ID_BID,
            ));
        } else if bid_needed {
            log::info!(
                target: TARGET,
                "market {}: skip bid (cap breached)",
                snap.market_index
            );
        }
        if ask_ok {
            orders.push(make_limit(
                snap.market_index,
                PositionDirection::Short,
                snap.target_ask,
                size,
                USER_ORDER_ID_ASK,
            ));
        } else if ask_needed {
            log::info!(
                target: TARGET,
                "market {}: skip ask (cap breached)",
                snap.market_index
            );
        }

        if orders.is_empty() && replace_ids.is_empty() {
            return Ok(());
        }
        if !orders.is_empty() {
            tx = tx.place_orders(orders);
        }

        let msg = tx.build();
        let keys = msg.static_account_keys();
        for (ix_idx, ix) in msg.instructions().iter().enumerate() {
            let pid = keys
                .get(ix.program_id_index as usize)
                .copied()
                .unwrap_or_default();
            let metas: Vec<String> = ix
                .accounts
                .iter()
                .map(|i| {
                    keys.get(*i as usize)
                        .map(|k| k.to_string())
                        .unwrap_or_else(|| format!("lut[{i}]"))
                })
                .collect();
            log::info!(
                target: TARGET,
                "ix[{ix_idx}] program={pid} accounts={metas:?}"
            );
        }
        if self.config.dry {
            log::info!(
                target: TARGET,
                "[dry] market {}: oracle={} bid={} ask={} bid_ok={bid_ok} ask_ok={ask_ok} replaced={replace_ids:?}",
                snap.market_index, snap.oracle_price, snap.target_bid, snap.target_ask
            );
            return Ok(());
        }
        match self.drift.sign_and_send(msg).await {
            Ok(sig) => {
                log::info!(
                    target: TARGET,
                    "market {}: oracle={} bid={} ask={} bid_ok={bid_ok} ask_ok={ask_ok} replaced={replace_ids:?} sig={sig}",
                    snap.market_index, snap.oracle_price, snap.target_bid, snap.target_ask
                );
                Ok(())
            }
            Err(e) => Err(format!("send: {e:?}")),
        }
    }

    /// Returns true if a hypothetical position of `hypothetical_base` in this
    /// market would keep both the per-market base cap and the global gross
    /// notional cap satisfied. Updates `projected_gross` when allowed.
    fn side_within_caps(
        &self,
        snap: &MarketSnapshot,
        hypothetical_base: i64,
        projected_gross: &mut u128,
        max_gross: u128,
    ) -> bool {
        let base_cap = self.config.quote_max_base_per_market;
        if base_cap > 0 && hypothetical_base.unsigned_abs() > base_cap {
            return false;
        }
        if max_gross > 0 {
            let current = notional_abs(snap.base_position, snap.oracle_price);
            let hypothetical = notional_abs(hypothetical_base, snap.oracle_price);
            // Swap this market's contribution in the projection: remove the
            // current value and add the hypothetical one.
            let new_projected = projected_gross
                .saturating_sub(current)
                .saturating_add(hypothetical);
            if new_projected > max_gross {
                return false;
            }
            *projected_gross = new_projected;
        }
        true
    }
}

fn notional_abs(base: i64, oracle_price: u64) -> u128 {
    // base is BASE_PRECISION (1e9), oracle_price is PRICE_PRECISION (1e6).
    // Notional in QUOTE_PRECISION (1e6) = |base| * oracle / BASE_PRECISION.
    (base.unsigned_abs() as u128).saturating_mul(oracle_price as u128) / BASE_PRECISION_U64 as u128
}

fn find_position(user: &User, market_index: u16) -> Option<&PerpPosition> {
    user.perp_positions
        .iter()
        .find(|p| p.market_index == market_index)
}

fn evaluate_side(
    user: &User,
    market_index: u16,
    user_order_id: u8,
    target_price: u64,
    oracle_price: u64,
    refresh_bps: u64,
) -> (bool, bool) {
    let existing = user.orders.iter().find(|o| {
        o.market_index == market_index
            && o.market_type == MarketType::Perp
            && o.user_order_id == user_order_id
            && o.base_asset_amount > o.base_asset_amount_filled
    });
    match existing {
        None => (true, false),
        Some(o) => {
            let drift_abs = o.price.abs_diff(target_price);
            let threshold = oracle_price * refresh_bps / 10_000;
            if drift_abs > threshold {
                (true, true)
            } else {
                (false, false)
            }
        }
    }
}

fn make_limit(
    market_index: u16,
    direction: PositionDirection,
    price: u64,
    base_asset_amount: u64,
    user_order_id: u8,
) -> OrderParams {
    let _ = PRICE_PRECISION_U64; // price is PRICE_PRECISION (1e6)
    OrderParams {
        order_type: OrderType::Limit,
        market_type: MarketType::Perp,
        direction,
        market_index,
        base_asset_amount,
        price,
        post_only: PostOnlyParam::TryPostOnly,
        user_order_id,
        ..Default::default()
    }
}

fn _assert_tick(t: u64) -> u64 {
    debug_assert!(t > 0);
    t
}
