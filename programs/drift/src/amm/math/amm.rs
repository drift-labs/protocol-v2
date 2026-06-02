use std::cmp::{max, min};

use crate::msg;

use crate::amm::controller::SwapDirection;
use crate::amm::AMM;
use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::bn::U192;
use crate::math::casting::Cast;
use crate::math::constants::{
    BID_ASK_SPREAD_PRECISION_I128, CONCENTRATION_PRECISION,
    DEFAULT_MAX_TWAP_UPDATE_PRICE_BAND_DENOMINATOR, FIVE_MINUTE,
    PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO, PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128,
    PRICE_TO_PEG_PRECISION_RATIO,
};
use crate::math::orders::standardize_base_asset_amount;
use crate::math::quote_asset::reserve_to_asset_amount;
use crate::math::stats::calculate_weighted_average;
use crate::state::oracle::{MMOraclePriceData, OraclePriceData};
use crate::validate;

use crate::math::helpers::get_proportion_u128;
use crate::math::safe_math::SafeMath;

#[cfg(test)]
mod tests;

pub fn calculate_price(
    quote_asset_reserve: u128,
    base_asset_reserve: u128,
    peg_multiplier: u128,
) -> DriftResult<u64> {
    let peg_quote_asset_amount = quote_asset_reserve.safe_mul(peg_multiplier)?;

    U192::from(peg_quote_asset_amount)
        .safe_mul(U192::from(PRICE_TO_PEG_PRECISION_RATIO))?
        .safe_div(U192::from(base_asset_reserve))?
        .try_to_u64()
}

pub fn calculate_bid_ask_bounds(
    concentration_coef: u128,
    sqrt_k: u128,
) -> DriftResult<(u128, u128)> {
    validate!(
        concentration_coef > CONCENTRATION_PRECISION,
        ErrorCode::InvalidConcentrationCoef,
        "concentration_coef={} <= CONCENTRATION_PRECISION={}",
        concentration_coef,
        CONCENTRATION_PRECISION
    )?;
    // worse case if all asks are filled (max reserve)
    let ask_bounded_base =
        get_proportion_u128(sqrt_k, concentration_coef, CONCENTRATION_PRECISION)?;

    // worse case if all bids are filled (min reserve)
    let bid_bounded_base =
        get_proportion_u128(sqrt_k, CONCENTRATION_PRECISION, concentration_coef)?;

    Ok((bid_bounded_base, ask_bounded_base))
}

pub fn calculate_market_open_bids_asks(amm: &AMM) -> DriftResult<(i128, i128)> {
    let base_asset_reserve = amm.base_asset_reserve;
    let min_base_asset_reserve = amm.min_base_asset_reserve;
    let max_base_asset_reserve = amm.max_base_asset_reserve;

    let (max_bids, max_asks) = _calculate_market_open_bids_asks(
        base_asset_reserve,
        min_base_asset_reserve,
        max_base_asset_reserve,
    )?;

    Ok((max_bids, max_asks))
}

pub fn _calculate_market_open_bids_asks(
    base_asset_reserve: u128,
    min_base_asset_reserve: u128,
    max_base_asset_reserve: u128,
) -> DriftResult<(i128, i128)> {
    // worse case if all asks are filled
    let max_asks = if base_asset_reserve < max_base_asset_reserve {
        -max_base_asset_reserve
            .safe_sub(base_asset_reserve)?
            .cast::<i128>()?
    } else {
        0
    };

    // worst case if all bids are filled
    let max_bids = if base_asset_reserve > min_base_asset_reserve {
        base_asset_reserve
            .safe_sub(min_base_asset_reserve)?
            .cast::<i128>()?
    } else {
        0
    };

    Ok((max_bids, max_asks))
}

/// Sanitise bid/ask estimates around the last oracle price using the AMM's
/// base spread as a fence: a trade-price hint above the oracle pulls the
/// bid up toward the trade (capped by half the AMM's short spread); below
/// the oracle pulls the ask down (capped by half the long spread). Returns
/// a `(bid, ask)` pair clipped to the AMM's natural `(amm_bid, amm_ask)`.
///
/// Takes the AMM's natural bid/ask and base spread as scalars rather than a
/// `&AMM` borrow — in the target architecture (AMM as an isolated module
/// alongside other quoters in the same program) callers receive these via
/// the AMM module's contract methods, and the call sites that need the
/// sanitised pair shouldn't have to pretend they own the AMM's state.
pub fn estimate_best_bid_ask_price(
    amm_bid_price: u64,
    amm_ask_price: u64,
    amm_base_spread: u32,
    amm_quote_state: &crate::amm::math::spread::AmmQuoteState,
    historical_oracle_data: &crate::state::oracle::HistoricalOracleData,
    precomputed_trade_price: Option<u64>,
    direction: Option<PositionDirection>,
    order_tick_size: u64,
) -> DriftResult<(u64, u64)> {
    let base_spread_u64 = amm_base_spread.cast::<u64>()?;
    let last_oracle_price_u64 = historical_oracle_data.last_oracle_price.cast::<u64>()?;

    let trade_price: u64 = match precomputed_trade_price {
        Some(trade_price) => trade_price,
        None => last_oracle_price_u64,
    };

    let trade_premium: i64 = trade_price
        .cast::<i64>()?
        .safe_sub(historical_oracle_data.last_oracle_price)?;
    validate!(
        historical_oracle_data.last_oracle_price > 0,
        ErrorCode::InvalidOracle,
        "historical_oracle_data.last_oracle_price <= 0"
    )?;

    // estimation of bid/ask by looking at execution premium

    // trade is a long
    let best_bid_estimate = if trade_premium > 0 {
        let discount = min(
            base_spread_u64,
            amm_quote_state.short_spread.cast::<u64>()? / 2,
        );
        last_oracle_price_u64
            .saturating_sub(discount.min(trade_premium.unsigned_abs()))
            .max(order_tick_size)
    } else {
        trade_price
    }
    .max(amm_bid_price);

    // trade is a short
    let best_ask_estimate = if trade_premium < 0 {
        let premium: u64 = min(
            base_spread_u64,
            amm_quote_state.long_spread.cast::<u64>()? / 2,
        );
        last_oracle_price_u64.safe_add(premium.min(trade_premium.unsigned_abs()))?
    } else {
        trade_price
    }
    .min(amm_ask_price);

    let (bid_price, ask_price) = match direction {
        Some(direction) => match direction {
            PositionDirection::Long => (best_bid_estimate, trade_price.max(best_bid_estimate)),
            PositionDirection::Short => (trade_price.min(best_ask_estimate), best_ask_estimate),
        },
        None => (
            trade_price.max(amm_bid_price).min(amm_ask_price),
            trade_price.max(amm_bid_price).min(amm_ask_price),
        ),
    };

    validate!(
        bid_price <= ask_price,
        ErrorCode::InvalidMarkTwapUpdateDetected,
        "bid_price({}, {}) not <= ask_price({}, {}),",
        best_bid_estimate,
        bid_price,
        ask_price,
        best_ask_estimate,
    )?;

    Ok((bid_price, ask_price))
}

pub fn sanitize_new_price(
    new_price: i64,
    last_price_twap: i64,
    sanitize_clamp_denominator: Option<i64>,
) -> DriftResult<i64> {
    // when/if twap is 0, dont try to normalize new_price
    if last_price_twap == 0 {
        return Ok(new_price);
    }

    let new_price_spread = new_price.safe_sub(last_price_twap)?;

    // cap new oracle update to 100/MAX_TWAP_UPDATE_PRICE_BAND_DENOMINATOR% delta from twap
    let sanitize_clamp_denominator =
        if let Some(sanitize_clamp_denominator) = sanitize_clamp_denominator {
            sanitize_clamp_denominator
        } else {
            DEFAULT_MAX_TWAP_UPDATE_PRICE_BAND_DENOMINATOR
        };

    if sanitize_clamp_denominator == 0 {
        // no need to use price band check
        return Ok(new_price);
    }

    let price_twap_price_band = last_price_twap.safe_div(sanitize_clamp_denominator)?;

    let capped_update_price =
        if new_price_spread.unsigned_abs() > price_twap_price_band.unsigned_abs() {
            if new_price > last_price_twap {
                last_price_twap.safe_add(price_twap_price_band)?
            } else {
                last_price_twap.safe_sub(price_twap_price_band)?
            }
        } else {
            new_price
        };

    Ok(capped_update_price)
}

pub enum TwapPeriod {
    FundingPeriod,
    FiveMin,
}

pub fn calculate_new_oracle_price_twap(
    market_stats: &crate::state::perp_market::MarketStats,
    now: i64,
    oracle_price: i64,
    twap_period: TwapPeriod,
) -> DriftResult<i64> {
    let historical_oracle_data = &market_stats.historical_oracle_data;
    let (last_mark_twap, last_oracle_twap) = match twap_period {
        TwapPeriod::FundingPeriod => (
            market_stats.last_mark_price_twap,
            historical_oracle_data.last_oracle_price_twap,
        ),
        TwapPeriod::FiveMin => (
            market_stats.last_mark_price_twap_5min,
            historical_oracle_data.last_oracle_price_twap_5min,
        ),
    };

    let period: i64 = match twap_period {
        TwapPeriod::FundingPeriod => market_stats.funding_period,
        TwapPeriod::FiveMin => FIVE_MINUTE as i64,
    };

    let since_last = max(
        if period == 0 { 1_i64 } else { 0_i64 },
        now.safe_sub(historical_oracle_data.last_oracle_price_twap_ts)?,
    );
    let from_start = max(0_i64, period.safe_sub(since_last)?);

    // if an oracle delay impacted last oracle_twap, shrink toward mark_twap
    let interpolated_oracle_price = if market_stats.last_mark_price_twap_ts
        > historical_oracle_data.last_oracle_price_twap_ts
    {
        let since_last_valid = market_stats
            .last_mark_price_twap_ts
            .safe_sub(historical_oracle_data.last_oracle_price_twap_ts)?;
        msg!(
            "correcting oracle twap update (oracle previously invalid for {:?} seconds)",
            since_last_valid
        );

        let from_start_valid = max(1, period.safe_sub(since_last_valid)?);
        calculate_weighted_average(
            last_mark_twap.cast::<i64>()?,
            oracle_price,
            since_last_valid,
            from_start_valid,
            None,
        )?
    } else {
        oracle_price
    };

    calculate_weighted_average(
        interpolated_oracle_price,
        last_oracle_twap.cast()?,
        since_last,
        from_start,
        None,
    )
}

pub fn calculate_swap_output(
    swap_amount: u128,
    input_asset_reserve: u128,
    direction: SwapDirection,
    invariant_sqrt: u128,
) -> DriftResult<(u128, u128)> {
    let invariant_sqrt_u192 = U192::from(invariant_sqrt);
    let invariant = invariant_sqrt_u192.safe_mul(invariant_sqrt_u192)?;

    if direction == SwapDirection::Remove && swap_amount > input_asset_reserve {
        msg!("{:?} > {:?}", swap_amount, input_asset_reserve);
        return Err(ErrorCode::TradeSizeTooLarge);
    }

    let new_input_asset_reserve = if let SwapDirection::Add = direction {
        input_asset_reserve.safe_add(swap_amount)?
    } else {
        input_asset_reserve.safe_sub(swap_amount)?
    };

    let new_input_amount_u192 = U192::from(new_input_asset_reserve);
    let new_output_asset_reserve = invariant.safe_div(new_input_amount_u192)?.try_to_u128()?;

    Ok((new_output_asset_reserve, new_input_asset_reserve))
}

pub fn calculate_quote_asset_amount_swapped(
    quote_asset_reserve_before: u128,
    quote_asset_reserve_after: u128,
    swap_direction: SwapDirection,
    peg_multiplier: u128,
) -> DriftResult<u128> {
    let mut quote_asset_reserve_change = match swap_direction {
        SwapDirection::Add => quote_asset_reserve_before.safe_sub(quote_asset_reserve_after)?,
        SwapDirection::Remove => quote_asset_reserve_after.safe_sub(quote_asset_reserve_before)?,
    };

    // when a user goes long base asset, make the base asset slightly more expensive
    // by adding one unit of quote asset
    if swap_direction == SwapDirection::Remove {
        quote_asset_reserve_change = quote_asset_reserve_change.safe_add(1)?;
    }

    let mut quote_asset_amount =
        reserve_to_asset_amount(quote_asset_reserve_change, peg_multiplier)?;

    // when a user goes long base asset, make the base asset slightly more expensive
    // by adding one unit of quote asset
    if swap_direction == SwapDirection::Remove {
        quote_asset_amount = quote_asset_amount.safe_add(1)?;
    }

    Ok(quote_asset_amount)
}

pub fn calculate_terminal_reserves(amm: &AMM) -> DriftResult<(u128, u128)> {
    let swap_direction = if amm.base_asset_amount_with_amm > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (new_quote_asset_amount, new_base_asset_amount) = calculate_swap_output(
        amm.base_asset_amount_with_amm.unsigned_abs(),
        amm.base_asset_reserve,
        swap_direction,
        amm.sqrt_k,
    )?;

    Ok((new_quote_asset_amount, new_base_asset_amount))
}

pub fn calculate_terminal_price_and_reserves(amm: &AMM) -> DriftResult<(u64, u128, u128)> {
    let (new_quote_asset_amount, new_base_asset_amount) = calculate_terminal_reserves(amm)?;

    let terminal_price = calculate_price(
        new_quote_asset_amount,
        new_base_asset_amount,
        amm.peg_multiplier,
    )?;

    Ok((
        terminal_price,
        new_quote_asset_amount,
        new_base_asset_amount,
    ))
}

pub fn calculate_oracle_reserve_price_spread(
    amm: &AMM,
    mm_oracle_price_data: &MMOraclePriceData,
    precomputed_reserve_price: Option<u64>,
) -> DriftResult<(i64, i64)> {
    let reserve_price = match precomputed_reserve_price {
        Some(reserve_price) => reserve_price.cast::<i64>()?,
        None => amm.reserve_price()?.cast::<i64>()?,
    };

    let oracle_price = mm_oracle_price_data.get_price();

    let price_spread = reserve_price.safe_sub(oracle_price)?;

    Ok((oracle_price, price_spread))
}

pub fn normalise_oracle_price(
    oracle_price_data: &OraclePriceData,
    reserve_price: u64,
) -> DriftResult<i64> {
    let oracle_price = oracle_price_data.price;
    let reserve_price = reserve_price.cast::<i64>()?;

    // 2.5 bps of the mark price
    let reserve_price_2p5_bps = reserve_price.safe_div(4000)?;
    let conf_int = oracle_price_data.confidence.cast::<i64>()?;

    //  normalises oracle toward mark price based on the oracle’s confidence interval
    //  if mark above oracle: use oracle+conf unless it exceeds .99975 * mark price
    //  if mark below oracle: use oracle-conf unless it less than 1.00025 * mark price
    //  (this guarantees more reasonable funding rates in volatile periods)
    let normalised_price = if reserve_price > oracle_price {
        min(
            max(reserve_price.safe_sub(reserve_price_2p5_bps)?, oracle_price),
            oracle_price.safe_add(conf_int)?,
        )
    } else {
        max(
            min(reserve_price.safe_add(reserve_price_2p5_bps)?, oracle_price),
            oracle_price.safe_sub(conf_int)?,
        )
    };

    Ok(normalised_price)
}

pub fn calculate_oracle_reserve_price_spread_pct(
    amm: &AMM,
    mm_oracle_price_data: &MMOraclePriceData,
    precomputed_reserve_price: Option<u64>,
) -> DriftResult<i64> {
    let reserve_price = match precomputed_reserve_price {
        Some(reserve_price) => reserve_price,
        None => amm.reserve_price()?,
    };
    let (_oracle_price, price_spread) =
        calculate_oracle_reserve_price_spread(amm, mm_oracle_price_data, Some(reserve_price))?;

    price_spread
        .cast::<i128>()?
        .safe_mul(BID_ASK_SPREAD_PRECISION_I128)?
        .safe_div(reserve_price.cast::<i128>()?)? // todo? better for spread logic
        .cast()
}

// Moved out of the AMM math crate: `calculate_oracle_twap_5min_price_spread_pct`
// → `HistoricalOracleData::twap_5min_spread_pct` (it had no AMM dependency).
// `is_oracle_mark_too_divergent` → `crate::math::oracle::is_mark_oracle_too_divergent`.

pub fn calculate_amm_available_liquidity(
    amm: &AMM,
    order_direction: &PositionDirection,
    order_step_size: u64,
) -> DriftResult<u64> {
    let max_fill_size: u64 = (amm.base_asset_reserve / amm.max_fill_reserve_fraction as u128)
        .min(u64::MAX as u128)
        .cast()?;

    // one fill can only take up to half of side's liquidity
    let max_base_asset_amount_on_side = match order_direction {
        PositionDirection::Long => {
            amm.base_asset_reserve
                .saturating_sub(amm.min_base_asset_reserve)
                / 2
        }
        PositionDirection::Short => {
            amm.max_base_asset_reserve
                .saturating_sub(amm.base_asset_reserve)
                / 2
        }
    }
    .cast::<u64>()?;

    standardize_base_asset_amount(
        max_fill_size.min(max_base_asset_amount_on_side),
        order_step_size,
    )
}

pub fn calculate_net_user_cost_basis(
    amm: &AMM,
    quote_asset_amount: i128,
    net_unsettled_funding_pnl: i64,
) -> DriftResult<i128> {
    let _ = amm;
    quote_asset_amount.safe_add(net_unsettled_funding_pnl.cast()?)
}

pub fn calculate_net_user_pnl(
    amm: &AMM,
    oracle_price: i64,
    quote_asset_amount: i128,
    net_unsettled_funding_pnl: i64,
) -> DriftResult<i128> {
    validate!(
        oracle_price > 0,
        ErrorCode::InvalidOracle,
        "oracle_price <= 0",
    )?;

    let net_user_base_asset_value = amm
        .base_asset_amount_with_amm
        .safe_mul(oracle_price.cast()?)?
        .safe_div(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO.cast()?)?;

    net_user_base_asset_value.safe_add(calculate_net_user_cost_basis(
        amm,
        quote_asset_amount,
        net_unsettled_funding_pnl,
    )?)
}

pub fn calculate_expiry_price(
    amm: &AMM,
    target_price: i64,
    total_excess_balance: i128,
    quote_asset_amount: i128,
    order_step_size: u64,
) -> DriftResult<i64> {
    if amm.base_asset_amount_with_amm.abs() < order_step_size.cast::<i128>()? {
        return Ok(target_price);
    }
    // net_baa * price + net_quote <= 0
    // net_quote/net_baa <= -price

    // net_user_unrealized_pnl negative = surplus in market
    // net_user_unrealized_pnl positive = expiry price needs to differ from oracle
    let best_expiry_price = -(quote_asset_amount
        .safe_sub(total_excess_balance.cast::<i128>()?)?
        .safe_mul(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128)?
        .safe_div(amm.base_asset_amount_with_amm)?)
    .cast::<i64>()?;

    let expiry_price = if amm.base_asset_amount_with_amm >= 0 {
        // net longs only get as high as oracle_price
        best_expiry_price.min(target_price).saturating_sub(1)
    } else {
        // net shorts only get as low as oracle price
        best_expiry_price.max(target_price).saturating_add(1)
    };

    Ok(expiry_price)
}
