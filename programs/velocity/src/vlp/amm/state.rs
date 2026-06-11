//! AMM zero-copy struct and its methods.
//!
//! Hosts:
//! - [`AMM`]: the constant-product vAMM state. See the doc-comment on the
//!   struct for the write-access policy that keeps mutations funneled through
//!   `AmmContract` / `QuoterCommit` rather than direct field writes.

use anchor_lang::prelude::*;

#[cfg(test)]
use crate::math::constants::{AMM_RESERVE_PRECISION, MAX_CONCENTRATION_COEFFICIENT};
use crate::{
    controller::position::PositionDirection,
    error::{ErrorCode, VelocityResult},
    math::{
        casting::Cast,
        constants::{
            BID_ASK_SPREAD_PRECISION_I128, BID_ASK_SPREAD_PRECISION_U128,
            DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT, PERCENTAGE_PRECISION,
            PERCENTAGE_PRECISION_I128, PRICE_PRECISION,
        },
        safe_math::SafeMath,
    },
    msg,
    state::{
        oracle::{get_prelaunch_price, OracleSource},
        perp_market::{MarketStats, PoolBalance},
        pyth_lazer_oracle::PythLazerOracle,
    },
    vlp::amm::math::amm::{self},
};

/// Constant-product virtual AMM state.
///
/// # Write-access policy
///
/// In the target architecture, the vAMM is one of several quoter modules
/// that share a perp-market account's bytes — its state slice sits next
/// to other quoter slices (DLOB makers, future propAMM-style
/// participants, etc.) in the same program. No external code reaches into
/// AMM fields directly; every mutation goes through a method on the AMM
/// module. The contract boundary is enforced in-process by the type
/// system, not by a CPI — and today's code follows the same discipline:
///
/// - **Fills + market events**: `controller/match` dispatches through
///   `QuoterCommit::commit_fill` / `on_market_event` on [`crate::vlp::amm::AmmQuoter`].
/// - **AMM-special P&L / position operations**: external code (insurance fund,
///   revenue-pool transfer, settlement) calls methods on the
///   [`crate::vlp::amm::quoter::AmmContract`] trait (`record_credit`,
///   `record_revenue_withdrawal`, `record_amm_pnl`, `apply_fill_fees`,
///   `apply_settlement_counterparty`).
/// - **Admin / keeper-crank operations**: call methods on `&mut AMM`
///   (`apply_cost`, `set_peg`, `apply_summary_stats_correction`,
///   `set_total_fee_minus_distributions`). These are explicit AMM-specific
///   admin handlers — not general-purpose admin reach-ins.
/// - **Single-field config setters**: AMM-specific admin handlers that update
///   one config value (`base_spread`, `max_spread`, `curve_update_intensity`,
///   `amm_jit_intensity`, etc.) still write fields directly. Each such
///   handler is named `handle_update_perp_market_<field>` or
///   `handle_update_amm_<field>` so the audit `rg 'market\.amm\.\w+\s*=' programs/velocity/src/`
///   surfaces only these clearly-scoped admin sets plus `#[cfg(test)]` shims.
///
/// **Adding code that writes an AMM field?** Either it's an AMM-specific
/// admin handler (add the new field-setter alongside its peers in
/// `instructions/admin.rs`) or it's a non-admin write — in which case it
/// belongs in `state/quoter.rs` (extend `AmmContract` or `Quoter::on_market_event`)
/// rather than reaching into fields.
/// Snapshot of the AMM's fee pool returned by [`AMM::fee_pool_snapshot`].
/// Pure query — for event logging and cache writes.
#[derive(Debug, Clone, Copy)]
pub struct AmmFeePoolSnapshot {
    pub scaled_balance: u128,
    pub balance_type: crate::state::spot_market::SpotBalanceType,
}

#[zero_copy(unsafe)]
#[derive(Debug, PartialEq, Eq)]
#[repr(C)]
#[derive(Default)]
pub struct AMM {
    /// partition of fees from perp market trading moved from pnl settlements
    pub fee_pool: PoolBalance,
    /// `x` reserves for constant product mm formula (x * y = k)
    /// precision: AMM_RESERVE_PRECISION
    pub base_asset_reserve: u128,
    /// `y` reserves for constant product mm formula (x * y = k)
    /// precision: AMM_RESERVE_PRECISION
    pub quote_asset_reserve: u128,
    /// determines how close the min/max base asset reserve sit vs base reserves
    /// allow for decreasing slippage without increasing liquidity and v.v.
    /// precision: PERCENTAGE_PRECISION
    pub concentration_coef: u128,
    /// minimum base_asset_reserve allowed before AMM is unavailable
    /// precision: AMM_RESERVE_PRECISION
    pub min_base_asset_reserve: u128,
    /// maximum base_asset_reserve allowed before AMM is unavailable
    /// precision: AMM_RESERVE_PRECISION
    pub max_base_asset_reserve: u128,
    /// `sqrt(k)` in constant product mm formula (x * y = k). stored to avoid velocity caused by integer math issues
    /// precision: AMM_RESERVE_PRECISION
    pub sqrt_k: u128,
    /// normalizing numerical factor for y, its use offers lowest slippage in cp-curve when market is balanced
    /// precision: PEG_PRECISION
    pub peg_multiplier: u128,
    /// y when market is balanced. stored to save computation
    /// precision: AMM_RESERVE_PRECISION
    pub terminal_quote_asset_reserve: u128,
    /// tracks net position (longs-shorts) in market with AMM as counterparty
    /// precision: BASE_PRECISION
    pub base_asset_amount_with_amm: i128,
    /// total fees collected by this perp market
    /// precision: QUOTE_PRECISION
    pub total_fee: i128,
    /// total fees collected by the vAMM's bid/ask spread
    /// precision: QUOTE_PRECISION
    pub total_mm_fee: i128,
    /// total fees minus any recognized upnl and pool withdraws
    /// precision: QUOTE_PRECISION
    pub total_fee_minus_distributions: i128,
    /// sum of all fees from fee pool withdrawn to revenue pool
    /// precision: QUOTE_PRECISION
    pub total_fee_withdrawn: u128,
    /// Cached spread-adjusted reserves for the ask (long-take) side, derived
    /// from `long_spread` + `reference_price_offset`. Refreshed by
    /// [`crate::vlp::amm::math::spread::update_amm_quote_state`] on every AMM crank
    /// / fill `setup`; quote/fill paths read these directly instead of
    /// recomputing per quote. Also surfaced to dashboards/tracking.
    /// precision: AMM_RESERVE_PRECISION
    pub ask_base_asset_reserve: u128,
    /// precision: AMM_RESERVE_PRECISION
    pub ask_quote_asset_reserve: u128,
    /// Cached spread-adjusted reserves for the bid (short-take) side.
    /// precision: AMM_RESERVE_PRECISION
    pub bid_base_asset_reserve: u128,
    /// precision: AMM_RESERVE_PRECISION
    pub bid_quote_asset_reserve: u128,
    /// the last blockchain slot the amm was updated
    pub last_update_slot: u64,
    /// the total_fee_minus_distribution change since the last funding update
    /// precision: QUOTE_PRECISION
    pub net_revenue_since_last_funding: i64,
    /// AMM's last-seen cumulative funding rates. Mirrors
    /// `PerpPosition::last_cumulative_funding_rate` on user positions —
    /// the AMM settles its own funding payment from
    /// `(market.cumulative_funding_rate_* − own_last) ×
    /// counterparty_position`, same math shape user positions use. The
    /// AMM is the counterparty for the net imbalance, so the relevant
    /// cum rate is the LONG one when the AMM is net long
    /// (base_asset_amount_with_amm < 0, i.e. users net short) and the
    /// SHORT one when the AMM is net short.
    pub last_cumulative_funding_rate_long: i64,
    pub last_cumulative_funding_rate_short: i64,
    /// Cached oracle-vs-reserve price spread (signed, BID_ASK_SPREAD_PRECISION),
    /// the spread input that seeds `calculate_spread`. Refreshed alongside the
    /// other cached spread fields by `update_amm_quote_state`.
    pub last_oracle_reserve_price_spread_pct: i64,
    /// Blockchain slot at which the cached spread state (`long_spread`,
    /// `short_spread`, `reference_price_offset`, the ask/bid reserves, and
    /// `last_oracle_reserve_price_spread_pct`) was last refreshed. Lets
    /// quote paths skip recompute within a slot and lets dashboards reason
    /// about cache staleness independently of `last_update_slot`.
    pub last_spread_update_slot: u64,
    /// the minimum spread the AMM can quote. also used as step size for some spread logic increases.
    pub base_spread: u32,
    /// the maximum spread the AMM can quote
    pub max_spread: u32,
    /// Cached spread applied to the ask (long-take) side, in
    /// BID_ASK_SPREAD_PRECISION. Refreshed by `update_amm_quote_state`.
    pub long_spread: u32,
    /// Cached spread applied to the bid (short-take) side, in
    /// BID_ASK_SPREAD_PRECISION. Refreshed by `update_amm_quote_state`.
    pub short_spread: u32,
    /// Cached reference-price offset (signed, PRICE_PRECISION) applied to both
    /// sides' quotes. Refreshed by `update_amm_quote_state`.
    pub reference_price_offset: i32,
    /// the fraction of total available liquidity a single fill on the AMM can consume
    pub max_fill_reserve_fraction: u16,
    /// the maximum slippage a single fill on the AMM can push
    pub max_slippage_ratio: u16,
    /// the update intensity of AMM formulaic updates (adjusting k). 0-100
    pub curve_update_intensity: u8,
    /// the jit intensity of AMM. larger intensity means larger participation in jit. 0 means no jit participation.
    /// (0, 100] is intensity for protocol-owned AMM.
    pub amm_jit_intensity: u8,
    /// signed scale amm_spread similar to fee_adjustment logic (-100 = 0, 100 = double)
    pub amm_spread_adjustment: i8,
    /// signed scale amm_spread similar to fee_adjustment logic (-100 = 0, 100 = double)
    pub amm_inventory_spread_adjustment: i8,
    pub reference_price_offset_deadband_pct: u8,
    pub padding_post_amm: [u8; 3],
}

impl AMM {
    /// Self-validate AMM invariants. Cross-checks the AMM's own
    /// `base_asset_amount_with_amm` against the caller-supplied
    /// `net_user_position` (= `market.base_asset_amount_long + market.base_asset_amount_short`)
    /// since that sum lives on PerpMarket. All other invariants are
    /// AMM-internal — the AMM is the source of truth on its own integrity.
    ///
    /// PerpMarket-level validation calls this; nothing else should reach into
    /// AMM fields to check curve sanity.
    #[allow(clippy::comparison_chain)]
    pub fn validate(
        &self,
        market_status: crate::state::market_status::MarketStatus,
        margin_ratio_initial: u32,
        net_user_position: i128,
        market_index: u16,
    ) -> VelocityResult {
        use crate::error::ErrorCode;
        use crate::math::constants::MAX_BASE_ASSET_AMOUNT_WITH_AMM;
        use crate::state::market_status::MarketStatus;
        use crate::{msg, validate};

        validate!(
            net_user_position == self.base_asset_amount_with_amm,
            ErrorCode::InvalidAmmDetected,
            "Market NET_BAA Error: net_user_position={} != amm.base_asset_amount_with_amm={}",
            net_user_position,
            self.base_asset_amount_with_amm,
        )?;

        validate!(
            self.base_asset_amount_with_amm <= (MAX_BASE_ASSET_AMOUNT_WITH_AMM as i128),
            ErrorCode::InvalidAmmDetected,
            "market {} amm.base_asset_amount_with_amm={} is too large",
            market_index,
            self.base_asset_amount_with_amm
        )?;

        validate!(
            self.peg_multiplier > 0,
            ErrorCode::InvalidAmmDetected,
            "market {} peg_multiplier out of wack",
            market_index,
        )?;

        if market_status != MarketStatus::ReduceOnly {
            validate!(
                self.sqrt_k > self.base_asset_amount_with_amm.unsigned_abs(),
                ErrorCode::InvalidAmmDetected,
                "market {} k out of wack: k={}, net_baa={}",
                market_index,
                self.sqrt_k,
                self.base_asset_amount_with_amm
            )?;
        }

        validate!(
            self.sqrt_k >= self.base_asset_reserve || self.sqrt_k >= self.quote_asset_reserve,
            ErrorCode::InvalidAmmDetected,
            "market {} k out of wack: k={}, bar={}, qar={}",
            market_index,
            self.sqrt_k,
            self.base_asset_reserve,
            self.quote_asset_reserve
        )?;

        let invariant_sqrt_u192 = crate::math::bn::U192::from(self.sqrt_k);
        let invariant = invariant_sqrt_u192.safe_mul(invariant_sqrt_u192)?;
        let quote_asset_reserve = invariant
            .safe_div(crate::math::bn::U192::from(self.base_asset_reserve))?
            .try_to_u128()?;
        let rounding_diff = quote_asset_reserve
            .cast::<i128>()?
            .safe_sub(self.quote_asset_reserve.cast()?)?
            .abs();
        validate!(
            rounding_diff <= 15,
            ErrorCode::InvalidAmmDetected,
            "market {} amm qar/bar/k invalid: k={}, bar={}, qar={}, qar'={} (rounding: {})",
            market_index,
            invariant,
            self.base_asset_reserve,
            self.quote_asset_reserve,
            quote_asset_reserve,
            rounding_diff
        )?;

        if self.base_asset_amount_with_amm > 0 {
            validate!(
                self.terminal_quote_asset_reserve <= self.quote_asset_reserve,
                ErrorCode::InvalidAmmDetected,
                "market {} terminal_quote_asset_reserve out of wack",
                market_index,
            )?;
        } else if self.base_asset_amount_with_amm < 0 {
            validate!(
                self.terminal_quote_asset_reserve >= self.quote_asset_reserve,
                ErrorCode::InvalidAmmDetected,
                "market {} terminal_quote_asset_reserve out of wack (terminal <) {} > {}",
                market_index,
                self.terminal_quote_asset_reserve,
                self.quote_asset_reserve
            )?;
        } else {
            validate!(
                self.terminal_quote_asset_reserve == self.quote_asset_reserve,
                ErrorCode::InvalidAmmDetected,
                "market {} terminal_quote_asset_reserve out of wack {}!={}",
                market_index,
                self.terminal_quote_asset_reserve,
                self.quote_asset_reserve
            )?;
        }

        if self.base_spread > 0 {
            validate!(
                self.max_spread > self.base_spread && self.max_spread < margin_ratio_initial * 100,
                ErrorCode::InvalidAmmDetected,
                "market {} amm invalid max_spread",
                market_index,
            )?;
        }

        Ok(())
    }

    /// Pre-fill AMM-side check: are the reserves within the AMM's own bounds
    /// for the direction being filled. Used by the fill controller.
    pub fn validate_for_fill(
        &self,
        direction: crate::controller::position::PositionDirection,
    ) -> VelocityResult {
        use crate::controller::position::PositionDirection;
        use crate::error::ErrorCode;
        use crate::{msg, validate};

        if direction == PositionDirection::Long {
            validate!(
                self.base_asset_reserve >= self.min_base_asset_reserve,
                ErrorCode::InvalidAmmForFillDetected,
                "Market baa below min_base_asset_reserve: {} < {}",
                self.base_asset_reserve,
                self.min_base_asset_reserve,
            )?;
        }
        if direction == PositionDirection::Short {
            validate!(
                self.base_asset_reserve <= self.max_base_asset_reserve,
                ErrorCode::InvalidAmmForFillDetected,
                "Market baa above max_base_asset_reserve"
            )?;
        }
        Ok(())
    }

    /// Is the formulaic k-update feature engaged for this AMM?
    pub fn is_curve_update_enabled(&self) -> bool {
        self.curve_update_intensity > 0
    }

    /// Gross share of AMM-collected fees the protocol retains (before
    /// netting against `total_fee_withdrawn`). AMM-only since the
    /// AMM-decoupling work — non-AMM (DLOB / liquidation) flow no longer
    /// inflates this. Use [`Self::protocol_floor`] for the floor that
    /// includes the netting.
    pub fn total_fee_lower_bound(&self) -> VelocityResult<u128> {
        use crate::math::constants::{
            SHARE_OF_FEES_ALLOCATED_TO_VELOCITY_DENOMINATOR,
            SHARE_OF_FEES_ALLOCATED_TO_VELOCITY_NUMERATOR,
        };
        self.total_fee
            .max(0)
            .cast::<u128>()?
            .safe_mul(SHARE_OF_FEES_ALLOCATED_TO_VELOCITY_NUMERATOR)?
            .safe_div(SHARE_OF_FEES_ALLOCATED_TO_VELOCITY_DENOMINATOR)
    }

    /// Protocol's reserved-fee floor for the AMM's `total_fee_minus_distributions`:
    /// the share of AMM-collected fees the protocol retains, less what has
    /// already been transferred to the revenue pool. Fully self-contained —
    /// the AMM doesn't peek at non-AMM (DLOB or liquidation) flow the way the
    /// pre-DLOB formula did. Admin's `transfer_fee_and_pnl_pool` ix is the
    /// explicit lever when cross-pool rebalancing is needed.
    pub fn protocol_floor(&self) -> VelocityResult<i128> {
        self.total_fee_lower_bound()?
            .cast::<i128>()?
            .safe_sub(self.total_fee_withdrawn.cast::<i128>()?)
    }

    /// AMM's net counterparty position (i.e. users' net long minus net
    /// short when AMM is the counterparty). Positive = users net long.
    pub fn net_counterparty_position(&self) -> i128 {
        self.base_asset_amount_with_amm
    }

    /// Is the AMM in P&L deficit (total_fee_minus_distributions < 0)?
    pub fn is_underwater(&self) -> bool {
        self.total_fee_minus_distributions < 0
    }

    /// AMM's terminal-state P&L surplus: lifetime earnings minus
    /// lifetime withdrawals to the revenue pool.
    pub fn terminal_state_surplus(&self) -> VelocityResult<i128> {
        self.total_fee_minus_distributions
            .safe_sub(self.total_fee_withdrawn.cast()?)
    }

    /// Cap a proposed outflow at the AMM's per-funding-period revenue
    /// (zero if the AMM's recent revenue is negative).
    pub fn cap_to_recent_revenue(&self, raw_cap: i64) -> i64 {
        raw_cap.min(self.net_revenue_since_last_funding).max(0)
    }

    /// Compute the AMM-side proposed outflow to the revenue pool given
    /// the protocol-provided caps and fee allocations. Pure AMM math
    /// against `total_fee_withdrawn`.
    pub fn proposed_revenue_outflow(
        &self,
        total_fee_for_protocol: i128,
        total_liq_fees_for_revenue_pool: i128,
        fee_pool_threshold: i128,
        max_revenue_to_settle: i128,
    ) -> VelocityResult<i128> {
        let transfer = total_fee_for_protocol
            .safe_add(total_liq_fees_for_revenue_pool)?
            .saturating_sub(self.total_fee_withdrawn.cast()?)
            .max(0)
            .min(fee_pool_threshold)
            .min(max_revenue_to_settle);
        Ok(transfer)
    }

    /// Has the AMM accumulated too much drawdown this funding period to
    /// keep accepting fills? Caller passes the PerpMarket's
    /// `contract_tier` (which determines the threshold). The AMM owns the
    /// drawdown computation.
    pub fn has_too_much_drawdown(
        &self,
        contract_tier: crate::state::perp_market::ContractTier,
    ) -> VelocityResult<bool> {
        use crate::state::perp_market::ContractTier;

        let net_revenue_since_last_funding = self.net_revenue_since_last_funding;
        let quote_drawdown_limit_breached = match contract_tier {
            ContractTier::A | ContractTier::B => {
                net_revenue_since_last_funding
                    <= DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT * 400
            }
            _ => {
                net_revenue_since_last_funding
                    <= DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT * 200
            }
        };

        if quote_drawdown_limit_breached {
            let percent_drawdown = net_revenue_since_last_funding
                .cast::<i128>()?
                .safe_mul(PERCENTAGE_PRECISION_I128)?
                .safe_div(self.total_fee_minus_distributions.max(1))?;

            let percent_drawdown_limit_breached = match contract_tier {
                ContractTier::A => percent_drawdown <= -PERCENTAGE_PRECISION_I128 / 50,
                ContractTier::B => percent_drawdown <= -PERCENTAGE_PRECISION_I128 / 33,
                ContractTier::C => percent_drawdown <= -PERCENTAGE_PRECISION_I128 / 25,
                _ => percent_drawdown <= -PERCENTAGE_PRECISION_I128 / 20,
            };

            if percent_drawdown_limit_breached {
                msg!(
                    "AMM has too much on-the-hour drawdown (percentage={}, quote={}) to accept fills",
                    percent_drawdown,
                    net_revenue_since_last_funding
                );
                return Ok(true);
            }
        }

        Ok(false)
    }

    /// Was the AMM updated in the given slot? (slot exactly matches
    /// last_update_slot)
    pub fn is_fresh_at(&self, current_slot: u64) -> bool {
        current_slot == self.last_update_slot
    }

    /// How many slots since the AMM was last cranked.
    pub fn slots_since_update(&self, current_slot: u64) -> u64 {
        current_slot.saturating_sub(self.last_update_slot)
    }

    /// Raw value of `last_update_slot`. For callers that need to
    /// record/cache the slot (e.g. amm cache writes); for freshness checks
    /// prefer [`Self::is_fresh_at`] / [`Self::slots_since_update`].
    pub fn last_update_slot(&self) -> u64 {
        self.last_update_slot
    }

    /// Token amount in the AMM's fee pool, derived from the pool's
    /// scaled balance and the spot market's cumulative interest.
    pub fn fee_pool_token_amount(
        &self,
        spot_market: &crate::state::spot_market::SpotMarket,
    ) -> VelocityResult<u128> {
        use crate::math::spot_balance::get_token_amount;
        use crate::state::spot_market::SpotBalance;
        get_token_amount(
            self.fee_pool.balance(),
            spot_market,
            self.fee_pool.balance_type(),
        )
    }

    /// Snapshot of the fee pool for event/cache logging. Pure query.
    pub fn fee_pool_snapshot(&self) -> AmmFeePoolSnapshot {
        use crate::state::spot_market::SpotBalance;
        AmmFeePoolSnapshot {
            scaled_balance: self.fee_pool.scaled_balance,
            balance_type: *self.fee_pool.balance_type(),
        }
    }

    /// Validate that a proposed margin and liquidator-fee configuration is
    /// compatible with the AMM's current `max_spread`. The non-AMM
    /// arguments (`margin_ratio_initial`, `margin_ratio_maintenance`,
    /// `liquidation_fee`) are forwarded to the protocol-level
    /// `validate_margin` so the AMM owns the `max_spread` portion of the
    /// constraint without duplicating margin bounds checks here. Used by
    /// `handle_update_perp_market_margin_ratio`.
    pub fn validate_compatible_with_margin_ratio(
        &self,
        margin_ratio_initial: u32,
        margin_ratio_maintenance: u32,
        liquidation_fee: u32,
    ) -> VelocityResult<()> {
        crate::validation::margin::validate_margin(
            margin_ratio_initial,
            margin_ratio_maintenance,
            liquidation_fee,
            self.max_spread,
        )
    }

    /// Validate that a proposed liquidator fee is compatible with the
    /// AMM's current `max_spread` (via the protocol-level
    /// `validate_margin` rules). Used by
    /// `handle_update_perp_liquidation_fee`.
    pub fn validate_compatible_with_liquidation_fee(
        &self,
        margin_ratio_initial: u32,
        margin_ratio_maintenance: u32,
        liquidation_fee: u32,
    ) -> VelocityResult<()> {
        crate::validation::margin::validate_margin(
            margin_ratio_initial,
            margin_ratio_maintenance,
            liquidation_fee,
            self.max_spread,
        )
    }

    pub fn get_reference_price_offset_deadband_pct(&self) -> VelocityResult<u128> {
        let pct = self.reference_price_offset_deadband_pct as u128;
        PERCENTAGE_PRECISION.safe_mul(pct)?.safe_div(100_u128)
    }
    pub fn get_fallback_price(
        &self,
        market_stats: &MarketStats,
        direction: &PositionDirection,
        amm_available_liquidity: u64,
        oracle_price: i64,
        seconds_til_order_expiry: i64,
        min_order_size: u64,
    ) -> VelocityResult<u64> {
        // PRICE_PRECISION
        if direction.eq(&PositionDirection::Long) {
            // pick amm ask + buffer if theres liquidity
            // otherwise be aggressive vs oracle + 1hr premium
            if amm_available_liquidity >= min_order_size {
                let reserve_price = self.reserve_price()?;
                let amm_ask_price: i64 = self
                    .ask_price(reserve_price, self.long_spread, self.reference_price_offset)?
                    .cast()?;
                amm_ask_price
                    .safe_add(amm_ask_price / (seconds_til_order_expiry * 20).clamp(100, 200))?
                    .cast::<u64>()
            } else {
                oracle_price
                    .safe_add(
                        market_stats
                            .last_ask_price_twap
                            .cast::<i64>()?
                            .safe_sub(market_stats.historical_oracle_data.last_oracle_price_twap)?
                            .max(0),
                    )?
                    .safe_add(oracle_price / (seconds_til_order_expiry * 2).clamp(10, 50))?
                    .cast::<u64>()
            }
        } else {
            // pick amm bid - buffer if theres liquidity
            // otherwise be aggressive vs oracle + 1hr bid premium
            if amm_available_liquidity >= min_order_size {
                let reserve_price = self.reserve_price()?;
                let amm_bid_price: i64 = self
                    .bid_price(
                        reserve_price,
                        self.short_spread,
                        self.reference_price_offset,
                    )?
                    .cast()?;
                amm_bid_price
                    .safe_sub(amm_bid_price / (seconds_til_order_expiry * 20).clamp(100, 200))?
                    .cast::<u64>()
            } else {
                oracle_price
                    .safe_add(
                        market_stats
                            .last_bid_price_twap
                            .cast::<i64>()?
                            .safe_sub(market_stats.historical_oracle_data.last_oracle_price_twap)?
                            .min(0),
                    )?
                    .safe_sub(oracle_price / (seconds_til_order_expiry * 2).clamp(10, 50))?
                    .max(0)
                    .cast::<u64>()
            }
        }
    }

    pub fn get_lower_bound_sqrt_k(self, min_order_size: u64) -> VelocityResult<u128> {
        Ok(self.sqrt_k.min(
            (min_order_size.cast::<u128>()?).max(self.base_asset_amount_with_amm.unsigned_abs()),
        ))
    }

    // direction with_amm is the net user direction
    pub fn get_protocol_owned_position(self) -> VelocityResult<i64> {
        self.base_asset_amount_with_amm.cast::<i64>()
    }

    pub fn get_max_reference_price_offset(self) -> VelocityResult<i64> {
        if self.curve_update_intensity <= 100 {
            return Ok(0);
        } else if self.curve_update_intensity >= 200 {
            // mimic old max behavior with 100 bps
            return Ok((self.max_spread.cast::<i64>()? / 2).max(10_000));
        }

        let lower_bound_multiplier: i64 =
            self.curve_update_intensity.safe_sub(100)?.cast::<i64>()?;

        // always the lesser of 1-100 bps of price offset and half of the market's max_spread
        let lb_bps =
            (PERCENTAGE_PRECISION.cast::<i64>()? / 10000).safe_mul(lower_bound_multiplier)?;
        let max_offset = (self.max_spread.cast::<i64>()? / 2).min(lb_bps);

        Ok(max_offset)
    }

    pub fn amm_wants_to_jit_make(
        &self,
        taker_direction: PositionDirection,
        order_step_size: u64,
    ) -> VelocityResult<bool> {
        let amm_wants_to_jit_make = match taker_direction {
            PositionDirection::Long => {
                self.base_asset_amount_with_amm < -(order_step_size.cast()?)
            }
            PositionDirection::Short => {
                self.base_asset_amount_with_amm > (order_step_size.cast()?)
            }
        };
        Ok(amm_wants_to_jit_make && self.amm_jit_is_active())
    }

    pub fn amm_has_low_enough_inventory(
        &self,
        amm_wants_to_jit_make: bool,
    ) -> VelocityResult<bool> {
        // mark low inventory if below a certain level of available liquidity
        // i.e. 10%
        if amm_wants_to_jit_make {
            // inventory scale
            let (max_bids, max_asks) = amm::_calculate_market_open_bids_asks(
                self.base_asset_reserve,
                self.min_base_asset_reserve,
                self.max_base_asset_reserve,
            )?;

            let protocol_owned_min_side_liquidity = max_bids.min(max_asks.abs());

            Ok(self.base_asset_amount_with_amm.abs()
                < protocol_owned_min_side_liquidity.safe_div(10)?)
        } else {
            Ok(true)
        }
    }

    pub fn amm_jit_is_active(&self) -> bool {
        self.amm_jit_intensity > 0
    }

    pub fn reserve_price(&self) -> VelocityResult<u64> {
        amm::calculate_price(
            self.quote_asset_reserve,
            self.base_asset_reserve,
            self.peg_multiplier,
        )
    }

    /// Test helper: reset the cached spread state to a balanced no-spread
    /// snapshot — zero spreads / reference offset and ask/bid reserves equal
    /// to the underlying reserves. Mirrors the legacy `AmmQuoteState::no_spread`
    /// constructor now that the spread cache lives on the AMM. Production
    /// code populates these via `crate::vlp::amm::math::spread::update_amm_quote_state`.
    #[cfg(test)]
    pub fn seed_no_spread_quote_state(&mut self) {
        self.long_spread = 0;
        self.short_spread = 0;
        self.reference_price_offset = 0;
        self.last_oracle_reserve_price_spread_pct = 0;
        self.ask_base_asset_reserve = self.base_asset_reserve;
        self.ask_quote_asset_reserve = self.quote_asset_reserve;
        self.bid_base_asset_reserve = self.base_asset_reserve;
        self.bid_quote_asset_reserve = self.quote_asset_reserve;
    }

    /// Bid price given an externally-supplied spread + reference price
    /// offset. Takes them as explicit args so callers can quote a
    /// hypothetical spread; production callers pass the cached
    /// `self.short_spread` / `self.reference_price_offset` (refreshed by
    /// [`crate::vlp::amm::math::spread::update_amm_quote_state`]).
    pub fn bid_price(
        &self,
        reserve_price: u64,
        short_spread: u32,
        reference_price_offset: i32,
    ) -> VelocityResult<u64> {
        let adjusted_spread = (-(short_spread.cast::<i32>()?)).safe_add(reference_price_offset)?;
        let multiplier = BID_ASK_SPREAD_PRECISION_I128.safe_add(adjusted_spread.cast::<i128>()?)?;

        reserve_price
            .cast::<u128>()?
            .safe_mul(multiplier.cast::<u128>()?)?
            .safe_div(BID_ASK_SPREAD_PRECISION_U128)?
            .cast()
    }

    /// Ask price given an externally-supplied spread + reference price
    /// offset. See [`Self::bid_price`].
    pub fn ask_price(
        &self,
        reserve_price: u64,
        long_spread: u32,
        reference_price_offset: i32,
    ) -> VelocityResult<u64> {
        let adjusted_spread = long_spread
            .cast::<i32>()?
            .safe_add(reference_price_offset)?;

        let multiplier = BID_ASK_SPREAD_PRECISION_I128.safe_add(adjusted_spread.cast::<i128>()?)?;

        reserve_price
            .cast::<u128>()?
            .safe_mul(multiplier.cast::<u128>()?)?
            .safe_div(BID_ASK_SPREAD_PRECISION_U128)?
            .cast()
    }

    /// (bid, ask) pair given externally-supplied spreads + reference offset.
    pub fn bid_ask_price(
        &self,
        reserve_price: u64,
        long_spread: u32,
        short_spread: u32,
        reference_price_offset: i32,
    ) -> VelocityResult<(u64, u64)> {
        let bid_price = self.bid_price(reserve_price, short_spread, reference_price_offset)?;
        let ask_price = self.ask_price(reserve_price, long_spread, reference_price_offset)?;
        Ok((bid_price, ask_price))
    }

    pub fn last_ask_premium(&self, market_stats: &MarketStats) -> VelocityResult<i64> {
        let reserve_price = self.reserve_price()?;
        let ask_price = self
            .ask_price(reserve_price, self.long_spread, self.reference_price_offset)?
            .cast::<i64>()?;
        ask_price.safe_sub(market_stats.historical_oracle_data.last_oracle_price)
    }

    pub fn last_bid_discount(&self, market_stats: &MarketStats) -> VelocityResult<i64> {
        let reserve_price = self.reserve_price()?;
        let bid_price = self
            .bid_price(
                reserve_price,
                self.short_spread,
                self.reference_price_offset,
            )?
            .cast::<i64>()?;
        market_stats
            .historical_oracle_data
            .last_oracle_price
            .safe_sub(bid_price)
    }

    pub fn can_lower_k(&self, min_order_size: u64) -> VelocityResult<bool> {
        let (max_bids, max_asks) = amm::calculate_market_open_bids_asks(self)?;
        let min_order_size_u128 = min_order_size.cast::<u128>()?;

        let can_lower = (self.base_asset_amount_with_amm.unsigned_abs()
            < max_bids.unsigned_abs().min(max_asks.unsigned_abs()))
            && (self
                .base_asset_amount_with_amm
                .unsigned_abs()
                .max(min_order_size_u128)
                < self.sqrt_k)
            && (min_order_size_u128 < max_bids.unsigned_abs().max(max_asks.unsigned_abs()));

        Ok(can_lower)
    }

    pub fn get_oracle_twap(
        &self,
        price_oracle: &AccountInfo,
        slot: u64,
        oracle_source: OracleSource,
    ) -> VelocityResult<Option<i64>> {
        match oracle_source {
            OracleSource::Pyth | OracleSource::PythStableCoin => {
                Ok(Some(self.get_pyth_twap(price_oracle, &OracleSource::Pyth)?))
            }
            OracleSource::Pyth1K => Ok(Some(
                self.get_pyth_twap(price_oracle, &OracleSource::Pyth1K)?,
            )),
            OracleSource::Pyth1M => Ok(Some(
                self.get_pyth_twap(price_oracle, &OracleSource::Pyth1M)?,
            )),
            OracleSource::DeprecatedSwitchboard | OracleSource::DeprecatedSwitchboardOnDemand => {
                Err(ErrorCode::InvalidOracle)
            }
            OracleSource::QuoteAsset => {
                msg!("Can't get oracle twap for quote asset");
                Err(ErrorCode::DefaultError)
            }
            OracleSource::Prelaunch => Ok(Some(get_prelaunch_price(price_oracle, slot)?.price)),
            OracleSource::PythPull
            | OracleSource::Pyth1KPull
            | OracleSource::Pyth1MPull
            | OracleSource::PythStableCoinPull => Err(ErrorCode::InvalidOracle),
            OracleSource::PythLazer => Ok(Some(
                self.get_pyth_twap(price_oracle, &OracleSource::PythLazer)?,
            )),
            OracleSource::PythLazer1K => Ok(Some(
                self.get_pyth_twap(price_oracle, &OracleSource::PythLazer1K)?,
            )),
            OracleSource::PythLazer1M => Ok(Some(
                self.get_pyth_twap(price_oracle, &OracleSource::PythLazer1M)?,
            )),
            OracleSource::PythLazerStableCoin => Ok(Some(
                self.get_pyth_twap(price_oracle, &OracleSource::PythLazerStableCoin)?,
            )),
        }
    }

    pub fn get_pyth_twap(
        &self,
        price_oracle: &AccountInfo,
        oracle_source: &OracleSource,
    ) -> VelocityResult<i64> {
        let multiple = oracle_source.get_pyth_multiple();
        let mut pyth_price_data: &[u8] = &price_oracle
            .try_borrow_data()
            .or(Err(ErrorCode::UnableToLoadOracle))?;

        let oracle_price: i64;
        let oracle_twap: i64;
        let oracle_exponent: i32;

        if oracle_source.is_pyth_push_oracle() {
            let price_data = pyth_client::cast::<pyth_client::Price>(pyth_price_data);
            oracle_price = price_data.agg.price;
            oracle_twap = price_data.twap.val;
            oracle_exponent = price_data.expo;
        } else if matches!(
            oracle_source,
            OracleSource::PythLazer
                | OracleSource::PythLazer1K
                | OracleSource::PythLazer1M
                | OracleSource::PythLazerStableCoin
        ) {
            let price_data = PythLazerOracle::try_deserialize(&mut pyth_price_data)
                .or(Err(ErrorCode::UnableToLoadOracle))?;
            oracle_price = price_data.price;
            oracle_twap = price_data.price;
            oracle_exponent = price_data.exponent;
        } else {
            return Err(ErrorCode::InvalidOracle);
        }

        assert!(oracle_twap > oracle_price / 10);

        let oracle_precision = 10_u128
            .pow(oracle_exponent.unsigned_abs())
            .safe_div(multiple)?;

        let mut oracle_scale_mult = 1;
        let mut oracle_scale_div = 1;

        if oracle_precision > PRICE_PRECISION {
            oracle_scale_div = oracle_precision.safe_div(PRICE_PRECISION)?;
        } else {
            oracle_scale_mult = PRICE_PRECISION.safe_div(oracle_precision)?;
        }

        oracle_twap
            .cast::<i128>()?
            .safe_mul(oracle_scale_mult.cast()?)?
            .safe_div(oracle_scale_div.cast()?)?
            .cast::<i64>()
    }

    /// Set a new concentration coefficient and recompute the dependent
    /// bid/ask reserve bounds. The new coefficient is derived from `scale`:
    /// `1 + (MAX_CONCENTRATION_COEFFICIENT - 1) / scale`.
    pub fn update_concentration_coef(&mut self, scale: u128) -> VelocityResult {
        use crate::math::constants::{CONCENTRATION_PRECISION, MAX_CONCENTRATION_COEFFICIENT};
        crate::validate!(
            scale > 0,
            ErrorCode::InvalidConcentrationCoef,
            "invalid scale",
        )?;
        let new_concentration_coef = CONCENTRATION_PRECISION
            + (MAX_CONCENTRATION_COEFFICIENT - CONCENTRATION_PRECISION) / scale;
        crate::validate!(
            new_concentration_coef > CONCENTRATION_PRECISION
                && new_concentration_coef <= MAX_CONCENTRATION_COEFFICIENT,
            ErrorCode::InvalidConcentrationCoef,
            "invalid new_concentration_coef",
        )?;
        self.concentration_coef = new_concentration_coef;

        let (_, terminal_quote_reserves, terminal_base_reserves) =
            amm::calculate_terminal_price_and_reserves(self)?;
        crate::validate!(
            terminal_quote_reserves == self.terminal_quote_asset_reserve,
            ErrorCode::InvalidAmmDetected,
            "invalid terminal_quote_reserves",
        )?;

        let (min_base_asset_reserve, max_base_asset_reserve) =
            amm::calculate_bid_ask_bounds(self.concentration_coef, terminal_base_reserves)?;
        self.max_base_asset_reserve = max_base_asset_reserve;
        self.min_base_asset_reserve = min_base_asset_reserve;

        let (max_bids, max_asks) = amm::calculate_market_open_bids_asks(self)?;
        crate::validate!(
            max_bids > self.base_asset_amount_with_amm
                && max_asks < self.base_asset_amount_with_amm,
            ErrorCode::InvalidConcentrationCoef,
            "amm.base_asset_amount_with_amm exceeds the unload liquidity available after concentration adjustment"
        )?;
        Ok(())
    }

    /// Set base/quote reserves directly from external inputs while keeping
    /// `sqrt_k` and the constant-product invariant consistent. The provided
    /// `quote_asset_reserve` must reconcile within 100 wei of the computed
    /// `k / base_asset_reserve` value.
    pub fn move_price(
        &mut self,
        base_asset_reserve: u128,
        quote_asset_reserve: u128,
        sqrt_k: u128,
    ) -> VelocityResult {
        use crate::math::bn;
        self.base_asset_reserve = base_asset_reserve;
        let k = bn::U256::from(sqrt_k).safe_mul(bn::U256::from(sqrt_k))?;
        self.quote_asset_reserve = k
            .safe_div(bn::U256::from(base_asset_reserve))?
            .try_to_u128()?;
        crate::validate!(
            (quote_asset_reserve.cast::<i128>()? - self.quote_asset_reserve.cast::<i128>()?).abs()
                < 100,
            ErrorCode::InvalidAmmDetected,
            "quote_asset_reserve passed doesnt reconcile enough {} vs {}",
            quote_asset_reserve.cast::<i128>()?,
            self.quote_asset_reserve.cast::<i128>()?
        )?;
        self.sqrt_k = sqrt_k;

        let (_, terminal_quote_reserves, terminal_base_reserves) =
            amm::calculate_terminal_price_and_reserves(self)?;
        self.terminal_quote_asset_reserve = terminal_quote_reserves;
        let (min_base_asset_reserve, max_base_asset_reserve) =
            amm::calculate_bid_ask_bounds(self.concentration_coef, terminal_base_reserves)?;
        self.max_base_asset_reserve = max_base_asset_reserve;
        self.min_base_asset_reserve = min_base_asset_reserve;
        Ok(())
    }

    /// Recenter the AMM around a new peg by solving for the balanced terminal
    /// reserves. Closes the AMM's outstanding inventory (`base_asset_amount_with_amm`)
    /// against the new `sqrt_k`, then writes the new peg and reserve bounds.
    pub fn recenter(&mut self, peg_multiplier: u128, sqrt_k: u128) -> VelocityResult {
        use crate::math::bn;
        use crate::vlp::amm::controller::SwapDirection;
        let swap_direction = if self.base_asset_amount_with_amm > 0 {
            SwapDirection::Remove
        } else {
            SwapDirection::Add
        };
        let (new_quote_asset_amount, new_base_asset_amount) = amm::calculate_swap_output(
            self.base_asset_amount_with_amm.unsigned_abs(),
            sqrt_k,
            swap_direction,
            sqrt_k,
        )?;
        self.base_asset_reserve = new_base_asset_amount;
        let k = bn::U256::from(sqrt_k).safe_mul(bn::U256::from(sqrt_k))?;
        self.quote_asset_reserve = k
            .safe_div(bn::U256::from(new_base_asset_amount))?
            .try_to_u128()?;
        crate::validate!(
            (new_quote_asset_amount.cast::<i128>()? - self.quote_asset_reserve.cast::<i128>()?)
                .abs()
                < 100,
            ErrorCode::InvalidAmmDetected,
            "quote_asset_reserve passed doesnt reconcile enough"
        )?;
        self.sqrt_k = sqrt_k;
        self.peg_multiplier = peg_multiplier;

        let (_, terminal_quote_reserves, terminal_base_reserves) =
            amm::calculate_terminal_price_and_reserves(self)?;
        self.terminal_quote_asset_reserve = terminal_quote_reserves;
        let (min_base_asset_reserve, max_base_asset_reserve) =
            amm::calculate_bid_ask_bounds(self.concentration_coef, terminal_base_reserves)?;
        self.max_base_asset_reserve = max_base_asset_reserve;
        self.min_base_asset_reserve = min_base_asset_reserve;
        Ok(())
    }

    /// Apply a precomputed `k` update (new sqrt_k + reserves), then refresh
    /// the terminal reserves and bid/ask reserve bounds. Pure write — the
    /// caller produced `update` via `cp_curve::get_update_k_result`.
    pub fn apply_k_update(
        &mut self,
        update: &crate::vlp::amm::math::cp_curve::UpdateKResult,
    ) -> VelocityResult {
        self.base_asset_reserve = update.base_asset_reserve;
        self.quote_asset_reserve = update.quote_asset_reserve;
        self.sqrt_k = update.sqrt_k;

        let (new_terminal_quote_reserve, new_terminal_base_reserve) =
            amm::calculate_terminal_reserves(self)?;
        self.terminal_quote_asset_reserve = new_terminal_quote_reserve;
        let (min_base_asset_reserve, max_base_asset_reserve) =
            amm::calculate_bid_ask_bounds(self.concentration_coef, new_terminal_base_reserve)?;
        self.min_base_asset_reserve = min_base_asset_reserve;
        self.max_base_asset_reserve = max_base_asset_reserve;
        Ok(())
    }

    /// Value of unwinding the AMM's entire net inventory
    /// (`base_asset_amount_with_amm`) back against its own constant-product
    /// curve — the AMM's terminal market value. Pure AMM math (reserves /
    /// `sqrt_k` / `peg`); used by repeg / k-update cost accounting.
    pub fn inventory_close_value(&self) -> VelocityResult<u128> {
        let base_asset_amount = self.base_asset_amount_with_amm;
        if base_asset_amount == 0 {
            return Ok(0);
        }
        let swap_direction = if base_asset_amount >= 0 {
            crate::vlp::amm::controller::SwapDirection::Add
        } else {
            crate::vlp::amm::controller::SwapDirection::Remove
        };
        let (new_quote_asset_reserve, _) = amm::calculate_swap_output(
            base_asset_amount.unsigned_abs(),
            self.base_asset_reserve,
            swap_direction,
            self.sqrt_k,
        )?;
        amm::calculate_quote_asset_amount_swapped(
            self.quote_asset_reserve,
            new_quote_asset_reserve,
            swap_direction,
            self.peg_multiplier,
        )
    }

    /// [`Self::inventory_close_value`] plus the PnL of closing the inventory
    /// relative to `prior_value`. Passing the pre-adjustment value as
    /// `prior_value` gives the cost of a repeg / k-update as
    /// `value_after − value_before`.
    pub fn inventory_value_and_pnl(&self, prior_value: u128) -> VelocityResult<(u128, i128)> {
        if self.base_asset_amount_with_amm == 0 {
            return Ok((0, 0));
        }
        let value = self.inventory_close_value()?;
        // Long inventory (closed by adding base back) profits when the exit
        // value exceeds entry; short inventory profits when it's lower.
        let pnl = if self.base_asset_amount_with_amm >= 0 {
            value.cast::<i128>()?.safe_sub(prior_value.cast()?)?
        } else {
            prior_value.cast::<i128>()?.safe_sub(value.cast()?)?
        };
        Ok((value, pnl))
    }

    /// Adjust k and return the protocol cost of doing so.
    ///
    /// The cost compares the AMM's notional position value before/after the k
    /// update: increasing k reduces slippage (cost is positive — exit price
    /// improves for the protocol's net position); decreasing k worsens the
    /// exit price.
    pub fn adjust_k_cost_and_update(
        &mut self,
        update: &crate::vlp::amm::math::cp_curve::UpdateKResult,
    ) -> VelocityResult<i128> {
        let current_net_market_value = self.inventory_close_value()?;
        self.apply_k_update(update)?;
        let (_new_net_market_value, cost) =
            self.inventory_value_and_pnl(current_net_market_value)?;
        Ok(cost)
    }
}

#[cfg(test)]
impl AMM {
    pub fn default_test() -> Self {
        let default_reserves = 100 * AMM_RESERVE_PRECISION;
        // make sure tests dont have the default sqrt_k = 0
        AMM {
            base_asset_reserve: default_reserves,
            quote_asset_reserve: default_reserves,
            sqrt_k: default_reserves,
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            max_base_asset_reserve: u64::MAX as u128,
            min_base_asset_reserve: 0,
            terminal_quote_asset_reserve: default_reserves,
            peg_multiplier: crate::math::constants::PEG_PRECISION,
            max_fill_reserve_fraction: 1,
            max_spread: 1000,
            ..AMM::default()
        }
    }

    pub fn default_btc_test() -> Self {
        AMM {
            base_asset_reserve: 65 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 63015384615,
            terminal_quote_asset_reserve: 64 * AMM_RESERVE_PRECISION,
            sqrt_k: 64 * AMM_RESERVE_PRECISION,

            peg_multiplier: 19_400_000_000,

            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            max_base_asset_reserve: 90 * AMM_RESERVE_PRECISION,
            min_base_asset_reserve: 45 * AMM_RESERVE_PRECISION,

            base_asset_amount_with_amm: -(AMM_RESERVE_PRECISION as i128),

            curve_update_intensity: 100,

            base_spread: 250,
            max_spread: 975,
            ..AMM::default()
        }
    }
}
