use std::cmp::max;

use crate::msg;

use crate::error::{ErrorCode, VelocityResult};
use crate::math::bn;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO, AMM_TO_QUOTE_PRECISION_RATIO_I128, FUNDING_RATE_BUFFER,
    PERCENTAGE_PRECISION_I128, PRICE_PRECISION, QUOTE_TO_BASE_AMT_FUNDING_PRECISION,
};
use crate::math::safe_math::SafeMath;

use crate::state::user::PerpPosition;

#[cfg(test)]
mod tests;

/// PerpMarket-level scalars that the funding math reads. Snapshotted by
/// the orchestrator once before the AmmQuoter takes its `&mut amm` borrow,
/// then handed to the pure helpers so they don't need `&PerpMarket`. Same
/// shape the AMM module exposes through its contract in the target
/// architecture.
#[derive(Clone, Copy)]
pub struct FundingMarketInputs {
    /// AMM-side counterparty position (== `amm.base_asset_amount_with_amm`).
    /// Positive = users net long.
    pub net_counterparty_position: i128,
    /// Top-level `PerpMarket.base_asset_amount_long`.
    pub base_asset_amount_long: i128,
    /// Top-level `PerpMarket.base_asset_amount_short`.
    pub base_asset_amount_short: i128,
    /// AMM-side `total_fee_minus_distributions` at decision time. Contains
    /// ONLY the AMM's own equity — protocol/IF carveouts never enter it — so
    /// funding may spend it down to zero.
    pub total_fee_minus_distributions: i128,
}

impl FundingMarketInputs {
    /// Snapshot the inputs straight from a `PerpMarket`. Convenience for
    /// callers that still hold an immutable `&PerpMarket` (e.g. tests).
    /// The funding orchestrator captures fields directly because it needs
    /// to hand the resulting struct to the math while a `&mut market.amm`
    /// borrow is alive.
    pub fn from_market(market: &crate::state::perp_market::PerpMarket) -> Self {
        Self {
            net_counterparty_position: market.amm.net_counterparty_position(),
            base_asset_amount_long: market.base_asset_amount_long,
            base_asset_amount_short: market.base_asset_amount_short,
            total_fee_minus_distributions: market.amm.total_fee_minus_distributions,
        }
    }

    /// Per-period budget for AMM-paid (negative) funding: 1/3 of the AMM's
    /// retained equity per funding period, so a sustained imbalance can't
    /// drain it in one settle. (The pre-isolation version also floored this
    /// at the protocol/IF pendings that used to live inside tfmd; they no
    /// longer do.) Mirrored by the SDK's `calculateFundingPool`.
    fn available_fees(&self) -> VelocityResult<u128> {
        self.total_fee_minus_distributions
            .max(0)
            .unsigned_abs()
            .safe_div(3)
    }
}

/// Funding premium plus the baseline offset, with a continuous soft dead zone.
///
/// `price_spread` is `mark_twap - oracle_twap`; `clamp_threshold` is the dead
/// zone as a price delta off the oracle. Spreads within +/- the threshold are
/// noise and yield the offset alone. Past it the spread is shrunk toward zero
/// by the threshold and scaled by `ramp_slope` (PERCENTAGE_PRECISION), so the
/// premium leaves the dead zone continuously rather than stepping by the full
/// threshold at the boundary
pub fn calculate_funding_premium_with_offset(
    price_spread: i64,
    clamp_threshold: i64,
    ramp_slope: u32,
    funding_rate_offset: i64,
) -> VelocityResult<i64> {
    if price_spread.abs() <= clamp_threshold {
        return Ok(funding_rate_offset);
    }

    let shrunk = price_spread.safe_sub(price_spread.signum().safe_mul(clamp_threshold)?)?;
    let ramped = shrunk
        .cast::<i128>()?
        .safe_mul(ramp_slope.cast::<i128>()?)?
        .safe_div(PERCENTAGE_PRECISION_I128)?
        .cast::<i64>()?;

    ramped.safe_add(funding_rate_offset)
}

/// With a virtual AMM, there can be an imbalance between longs and shorts and thus funding can be asymmetric.
/// To account for this, amm keeps track of the cumulative funding rate for both longs and shorts.
/// When there is a period with asymmetric funding, the protocol will pay/receive funding from/to it's collected fees.
/// Pure math: compute the long/short funding rates this period (asymmetric
/// when the imbalance has to be capped to fit in the AMM's fee pool) and
/// the *projected* funding-imbalance PnL for the AMM. Does NOT mutate the
/// AMM — the caller is responsible for:
///   1. Enforcing the protocol-floor profitability check on `capped_pnl`
///      (use `validate_funding_pnl_profitability`).
///   2. Bumping the market's cumulative funding rates.
///   3. Dispatching `MarketEvent::FundingUpdated` so the AMM settles its
///      own PnL from the cum-rate deltas (see
///      `calculate_amm_funding_payment`).
pub fn calculate_funding_rate_long_short(
    inputs: &FundingMarketInputs,
    funding_rate: i128,
) -> VelocityResult<(i128, i128, i128)> {
    let net_market_position_funding_payment = calculate_funding_payment_in_quote_precision(
        funding_rate,
        inputs.net_counterparty_position,
    )?;
    let uncapped_funding_pnl = -net_market_position_funding_payment;

    // Protocol earns (positive imbalance) — no capping needed.
    if uncapped_funding_pnl >= 0 {
        return Ok((funding_rate, funding_rate, uncapped_funding_pnl));
    }

    let (capped_funding_rate, capped_funding_pnl) =
        calculate_capped_funding_rate(inputs, uncapped_funding_pnl, funding_rate)?;

    let funding_rate_long = if funding_rate < 0 {
        capped_funding_rate
    } else {
        funding_rate
    };

    let funding_rate_short = if funding_rate > 0 {
        capped_funding_rate
    } else {
        funding_rate
    };

    Ok((funding_rate_long, funding_rate_short, capped_funding_pnl))
}

/// Reject a funding update that would push `total_fee_minus_distributions`
/// negative — funding may spend the AMM's own equity but not drive it
/// underwater. Called by the orchestrator after
/// `calculate_funding_rate_long_short` and before dispatching
/// `FundingUpdated`.
pub fn validate_funding_pnl_profitability(
    inputs: &FundingMarketInputs,
    funding_pnl: i128,
) -> VelocityResult<()> {
    if funding_pnl >= 0 {
        return Ok(());
    }
    let projected_total_fee_minus_distributions =
        inputs.total_fee_minus_distributions.safe_add(funding_pnl)?;
    if projected_total_fee_minus_distributions < 0 {
        msg!(
            "new_total_fee_minus_distributions={} < 0",
            projected_total_fee_minus_distributions,
        );
        return Err(ErrorCode::InvalidFundingProfitability);
    }
    Ok(())
}

fn calculate_capped_funding_rate(
    inputs: &FundingMarketInputs,
    uncapped_funding_pnl: i128, // if negative, users would net receive from protocol
    funding_rate: i128,
) -> VelocityResult<(i128, i128)> {
    // the most the AMM may pay out this period (already throttled to 1/3 of
    // its retained equity by `available_fees`)
    let funding_rate_pnl_limit = -inputs.available_fees()?.cast::<i128>()?;

    // if theres enough in fees, give user's uncapped funding
    // if theres a little/nothing in fees, give the user's capped outflow funding
    let capped_funding_pnl = max(uncapped_funding_pnl, funding_rate_pnl_limit);
    let capped_funding_rate = if uncapped_funding_pnl < funding_rate_pnl_limit {
        // Calculate how much funding payment is already available from users
        let funding_payment_from_users = calculate_funding_payment_in_quote_precision(
            funding_rate,
            if funding_rate > 0 {
                inputs.base_asset_amount_long
            } else {
                inputs.base_asset_amount_short
            },
        )?;

        // increase the funding_rate_pnl_limit by accounting for the funding payment already being made by users
        // this makes it so that the capped rate includes funding payments from users and protocol collected fees
        let funding_rate_pnl_limit =
            funding_rate_pnl_limit.safe_sub(funding_payment_from_users.abs())?;

        if funding_rate < 0 {
            // longs receive
            calculate_funding_rate_from_pnl_limit(
                funding_rate_pnl_limit,
                inputs.base_asset_amount_long,
            )?
        } else {
            // shorts receive
            calculate_funding_rate_from_pnl_limit(
                funding_rate_pnl_limit,
                inputs.base_asset_amount_short,
            )?
        }
    } else {
        funding_rate
    };

    Ok((capped_funding_rate, capped_funding_pnl))
}

pub fn calculate_funding_payment(
    amm_cumulative_funding_rate: i128,
    market_position: &PerpPosition,
) -> VelocityResult<i64> {
    let funding_rate_delta = amm_cumulative_funding_rate
        .safe_sub(market_position.last_cumulative_funding_rate.cast()?)?;

    if funding_rate_delta == 0 {
        return Ok(0);
    }

    _calculate_funding_payment(
        funding_rate_delta,
        market_position.base_asset_amount.cast()?,
    )?
    .safe_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)?
    .cast()
}

fn _calculate_funding_payment(
    funding_rate_delta: i128,
    base_asset_amount: i128,
) -> VelocityResult<i128> {
    let funding_rate_delta_sign: i128 = if funding_rate_delta > 0 { 1 } else { -1 };

    let funding_rate_payment_magnitude = bn::U192::from(funding_rate_delta.unsigned_abs())
        .safe_mul(bn::U192::from(base_asset_amount.unsigned_abs()))?
        .safe_div(bn::U192::from(PRICE_PRECISION))?
        .safe_div(bn::U192::from(FUNDING_RATE_BUFFER))?
        .try_to_u128()?
        .cast::<i128>()?;

    // funding_rate: longs pay shorts
    let funding_rate_payment_sign: i128 = if base_asset_amount > 0 { -1 } else { 1 };

    let funding_rate_payment = (funding_rate_payment_magnitude)
        .safe_mul(funding_rate_payment_sign)?
        .safe_mul(funding_rate_delta_sign)?;

    Ok(funding_rate_payment)
}

fn calculate_funding_rate_from_pnl_limit(
    pnl_limit: i128,
    base_asset_amount: i128,
) -> VelocityResult<i128> {
    if base_asset_amount == 0 {
        return Ok(0);
    }

    let pnl_limit_biased = if pnl_limit < 0 {
        pnl_limit.safe_add(1)?
    } else {
        pnl_limit
    };

    pnl_limit_biased
        .safe_mul(QUOTE_TO_BASE_AMT_FUNDING_PRECISION)?
        .safe_div(base_asset_amount)
}

pub fn calculate_funding_payment_in_quote_precision(
    funding_rate_delta: i128,
    base_asset_amount: i128,
) -> VelocityResult<i128> {
    let funding_payment = _calculate_funding_payment(funding_rate_delta, base_asset_amount)?;
    let funding_payment_collateral =
        funding_payment.safe_div(AMM_TO_QUOTE_PRECISION_RATIO.cast::<i128>()?)?;

    Ok(funding_payment_collateral)
}

/// Compute the AMM's net funding payment from cumulative-funding-rate
/// deltas, treating the AMM as the counterparty to user positions on
/// each side.
///
/// The AMM holds `-base_asset_amount_long` against long users (so it's
/// short to them, settles against `cumulative_funding_rate_long`) and
/// `-base_asset_amount_short` against short users (long to them, settles
/// against `cumulative_funding_rate_short`). Summing both contributions
/// yields the net funding flow to/from the AMM — equivalent to today's
/// `record_amm_pnl(capped_funding_pnl)` value in both uncapped and capped
/// cases.
///
/// Positive return value = AMM receives funding (TFMD grows). Negative =
/// AMM owes funding (TFMD shrinks). Quote precision.
///
/// Mirrors `calculate_funding_payment` for user positions but split across
/// the two sides the AMM is counterparty to.
pub fn calculate_amm_funding_payment(
    base_asset_amount_long: i128,
    base_asset_amount_short: i128,
    cumulative_funding_rate_long: i128,
    cumulative_funding_rate_short: i128,
    last_cumulative_funding_rate_long: i64,
    last_cumulative_funding_rate_short: i64,
) -> VelocityResult<i128> {
    let long_delta =
        cumulative_funding_rate_long.safe_sub(last_cumulative_funding_rate_long.cast()?)?;
    let short_delta =
        cumulative_funding_rate_short.safe_sub(last_cumulative_funding_rate_short.cast()?)?;

    let mut amm_payment = 0i128;

    if long_delta != 0 && base_asset_amount_long != 0 {
        // AMM is short to the long-side aggregate; position = -base_long.
        amm_payment = amm_payment.safe_add(_calculate_funding_payment(
            long_delta,
            base_asset_amount_long.safe_mul(-1)?,
        )?)?;
    }

    if short_delta != 0 && base_asset_amount_short != 0 {
        // AMM is long to the short-side aggregate; position = -base_short.
        amm_payment = amm_payment.safe_add(_calculate_funding_payment(
            short_delta,
            base_asset_amount_short.safe_mul(-1)?,
        )?)?;
    }

    amm_payment.safe_div(AMM_TO_QUOTE_PRECISION_RATIO.cast::<i128>()?)
}
