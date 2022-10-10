use std::cmp::{max, min};

use solana_program::msg;

use crate::controller::amm::SwapDirection;
use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::bn::U192;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128, cast_to_u64, Cast};
use crate::math::constants::{
    AMM_RESERVE_PRECISION_I128, BID_ASK_SPREAD_PRECISION, BID_ASK_SPREAD_PRECISION_I128,
    CONCENTRATION_PRECISION, ONE_HOUR_I128, PRICE_TO_PEG_PRECISION_RATIO,
    PRICE_TO_QUOTE_PRECISION_RATIO,
};
use crate::math::orders::standardize_base_asset_amount;
use crate::math::quote_asset::reserve_to_asset_amount;
use crate::math::stats::{calculate_new_twap, calculate_rolling_sum, calculate_weighted_average};
use crate::math_error;
use crate::state::oracle::OraclePriceData;
use crate::state::perp_market::AMM;
use crate::state::state::PriceDivergenceGuardRails;
use crate::validate;

use super::helpers::get_proportion_u128;

#[cfg(test)]
mod tests;

pub fn calculate_price(
    quote_asset_reserve: u128,
    base_asset_reserve: u128,
    peg_multiplier: u128,
) -> ClearingHouseResult<u128> {
    let peg_quote_asset_amount = quote_asset_reserve
        .checked_mul(peg_multiplier)
        .ok_or_else(math_error!())?;

    U192::from(peg_quote_asset_amount)
        .checked_mul(U192::from(PRICE_TO_PEG_PRECISION_RATIO))
        .ok_or_else(math_error!())?
        .checked_div(U192::from(base_asset_reserve))
        .ok_or_else(math_error!())?
        .try_to_u128()
}

pub fn calculate_bid_ask_bounds(
    concentration_coef: u128,
    sqrt_k: u128,
) -> ClearingHouseResult<(u128, u128)> {
    // worse case if all asks are filled (max reserve)
    let ask_bounded_base =
        get_proportion_u128(sqrt_k, concentration_coef, CONCENTRATION_PRECISION)?;

    // worse case if all bids are filled (min reserve)
    let bid_bounded_base =
        get_proportion_u128(sqrt_k, CONCENTRATION_PRECISION, concentration_coef)?;

    Ok((bid_bounded_base, ask_bounded_base))
}

pub fn calculate_terminal_price(amm: &mut AMM) -> ClearingHouseResult<u128> {
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

    let terminal_price = calculate_price(
        new_quote_asset_amount,
        new_base_asset_amount,
        amm.peg_multiplier,
    )?;

    Ok(terminal_price)
}

pub fn calculate_market_open_bids_asks(amm: &AMM) -> ClearingHouseResult<(i128, i128)> {
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
) -> ClearingHouseResult<(i128, i128)> {
    // worse case if all asks are filled
    let max_asks = if base_asset_reserve < max_base_asset_reserve {
        -cast_to_i128(
            max_base_asset_reserve
                .checked_sub(base_asset_reserve)
                .ok_or_else(math_error!())?,
        )?
    } else {
        0
    };

    // worst case if all bids are filled
    let max_bids = if base_asset_reserve > min_base_asset_reserve {
        cast_to_i128(
            base_asset_reserve
                .checked_sub(min_base_asset_reserve)
                .ok_or_else(math_error!())?,
        )?
    } else {
        0
    };

    Ok((max_bids, max_asks))
}

pub fn update_mark_twap(
    amm: &mut AMM,
    now: i64,
    precomputed_trade_price: Option<u128>,
    direction: Option<PositionDirection>,
) -> ClearingHouseResult<u128> {
    let base_spread_u128 = cast_to_u128(amm.base_spread)?;
    let last_oracle_price_u128 = cast_to_u128(amm.historical_oracle_data.last_oracle_price)?;

    let trade_price: u128 = match precomputed_trade_price {
        Some(trade_price) => trade_price,
        None => last_oracle_price_u128,
    };

    validate!(
        amm.historical_oracle_data.last_oracle_price > 0,
        ErrorCode::InvalidOracle,
        "amm.historical_oracle_data.last_oracle_price <= 0"
    )?;

    let amm_reserve_price = amm.reserve_price()?;
    let (amm_bid_price, amm_ask_price) = amm.bid_ask_price(amm_reserve_price)?;
    // estimation of bid/ask by looking at execution premium

    // trade is a long
    let best_bid_estimate = if trade_price > last_oracle_price_u128 {
        let discount = min(base_spread_u128, amm.short_spread / 2);
        last_oracle_price_u128
            .checked_sub(discount)
            .ok_or_else(math_error!())?
    } else {
        trade_price
    };

    // trade is a short
    let best_ask_estimate = if trade_price < last_oracle_price_u128 {
        let premium = min(base_spread_u128, amm.long_spread / 2);
        last_oracle_price_u128
            .checked_add(premium)
            .ok_or_else(math_error!())?
    } else {
        trade_price
    };

    validate!(
        best_bid_estimate <= best_ask_estimate,
        ErrorCode::DefaultError,
        "best_bid_estimate({}, {}) not <= best_ask_estimate({}, {})",
        amm_bid_price,
        best_bid_estimate,
        best_ask_estimate,
        amm_ask_price,
    )?;

    let (bid_price, ask_price) = match direction {
        Some(direction) => match direction {
            PositionDirection::Long => (best_bid_estimate, trade_price),
            PositionDirection::Short => (trade_price, best_ask_estimate),
        },
        None => (trade_price, trade_price),
    };

    validate!(
        bid_price <= ask_price,
        ErrorCode::DefaultError,
        "bid_price({}, {}) not <= ask_price({}, {}),",
        best_bid_estimate,
        bid_price,
        ask_price,
        best_ask_estimate,
    )?;

    let (bid_price_capped_update, ask_price_capped_update) = (
        sanitize_new_price(
            cast_to_i128(bid_price)?,
            cast_to_i128(amm.last_bid_price_twap)?,
        )?,
        sanitize_new_price(
            cast_to_i128(ask_price)?,
            cast_to_i128(amm.last_ask_price_twap)?,
        )?,
    );

    validate!(
        bid_price_capped_update <= ask_price_capped_update,
        ErrorCode::DefaultError,
        "bid_price_capped_update not <= ask_price_capped_update,"
    )?;

    // update bid and ask twaps
    let bid_twap = calculate_new_twap(
        bid_price_capped_update,
        now,
        cast(amm.last_bid_price_twap)?,
        amm.last_mark_price_twap_ts,
        amm.funding_period,
    )?;
    amm.last_bid_price_twap = cast(bid_twap)?;

    let ask_twap = calculate_new_twap(
        ask_price_capped_update,
        now,
        cast(amm.last_ask_price_twap)?,
        amm.last_mark_price_twap_ts,
        amm.funding_period,
    )?;

    amm.last_ask_price_twap = cast(ask_twap)?;

    let mid_twap = bid_twap.checked_add(ask_twap).ok_or_else(math_error!())? / 2;

    // update std stat
    update_amm_mark_std(amm, now, trade_price, amm.last_mark_price_twap)?;

    amm.last_mark_price_twap = cast(mid_twap)?;
    amm.last_mark_price_twap_5min = cast(calculate_new_twap(
        cast(
            bid_price_capped_update
                .checked_add(ask_price_capped_update)
                .ok_or_else(math_error!())?
                / 2,
        )?,
        now,
        cast(amm.last_mark_price_twap_5min)?,
        amm.last_mark_price_twap_ts,
        60 * 5,
    )?)?;

    amm.last_mark_price_twap_ts = now;

    cast(mid_twap)
}

pub fn sanitize_new_price(new_price: i128, last_price_twap: i128) -> ClearingHouseResult<i128> {
    // when/if twap is 0, dont try to normalize new_price
    if last_price_twap == 0 {
        return Ok(new_price);
    }

    let new_price_spread = new_price
        .checked_sub(last_price_twap)
        .ok_or_else(math_error!())?;

    // cap new oracle update to 33% delta from twap
    let price_twap_33pct = last_price_twap.checked_div(3).ok_or_else(math_error!())?;

    let capped_update_price = if new_price_spread.unsigned_abs() > price_twap_33pct.unsigned_abs() {
        if new_price > last_price_twap {
            last_price_twap
                .checked_add(price_twap_33pct)
                .ok_or_else(math_error!())?
        } else {
            last_price_twap
                .checked_sub(price_twap_33pct)
                .ok_or_else(math_error!())?
        }
    } else {
        new_price
    };

    Ok(capped_update_price)
}

pub fn update_oracle_price_twap(
    amm: &mut AMM,
    now: i64,
    oracle_price_data: &OraclePriceData,
    precomputed_reserve_price: Option<u128>,
) -> ClearingHouseResult<i128> {
    let reserve_price = match precomputed_reserve_price {
        Some(reserve_price) => reserve_price,
        None => amm.reserve_price()?,
    };

    let oracle_price = normalise_oracle_price(amm, oracle_price_data, Some(reserve_price))?;

    let capped_oracle_update_price = sanitize_new_price(
        oracle_price,
        amm.historical_oracle_data.last_oracle_price_twap,
    )?;

    // sanity check
    let oracle_price_twap: i128;
    if capped_oracle_update_price > 0 && oracle_price > 0 {
        oracle_price_twap = calculate_new_oracle_price_twap(
            amm,
            now,
            capped_oracle_update_price,
            TwapPeriod::FundingPeriod,
        )?;

        let oracle_price_twap_5min = calculate_new_oracle_price_twap(
            amm,
            now,
            capped_oracle_update_price,
            TwapPeriod::FiveMin,
        )?;

        amm.last_oracle_normalised_price = capped_oracle_update_price;
        amm.historical_oracle_data.last_oracle_price = oracle_price_data.price;
        amm.last_oracle_conf_pct = oracle_price_data
            .confidence
            .checked_mul(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(reserve_price)
            .ok_or_else(math_error!())? as u64;
        amm.historical_oracle_data.last_oracle_delay = oracle_price_data.delay;
        amm.last_oracle_reserve_price_spread_pct =
            calculate_oracle_reserve_price_spread_pct(amm, oracle_price_data, Some(reserve_price))?;

        amm.historical_oracle_data.last_oracle_price_twap_5min = oracle_price_twap_5min;
        amm.historical_oracle_data.last_oracle_price_twap = oracle_price_twap;
        amm.historical_oracle_data.last_oracle_price_twap_ts = now;
    } else {
        oracle_price_twap = amm.historical_oracle_data.last_oracle_price_twap
    }

    Ok(oracle_price_twap)
}

pub enum TwapPeriod {
    FundingPeriod,
    FiveMin,
}

pub fn calculate_new_oracle_price_twap(
    amm: &AMM,
    now: i64,
    oracle_price: i128,
    twap_period: TwapPeriod,
) -> ClearingHouseResult<i128> {
    let (last_mark_twap, last_oracle_twap) = match twap_period {
        TwapPeriod::FundingPeriod => (
            amm.last_mark_price_twap,
            amm.historical_oracle_data.last_oracle_price_twap,
        ),
        TwapPeriod::FiveMin => (
            amm.last_mark_price_twap_5min,
            amm.historical_oracle_data.last_oracle_price_twap_5min,
        ),
    };

    let period: i64 = match twap_period {
        TwapPeriod::FundingPeriod => amm.funding_period,
        TwapPeriod::FiveMin => 60 * 5,
    };

    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.historical_oracle_data.last_oracle_price_twap_ts)
            .ok_or_else(math_error!())?,
    ))?;
    let from_start = max(
        0,
        cast_to_i128(period)?
            .checked_sub(since_last)
            .ok_or_else(math_error!())?,
    );

    // if an oracle delay impacted last oracle_twap, shrink toward mark_twap
    let interpolated_oracle_price =
        if amm.last_mark_price_twap_ts > amm.historical_oracle_data.last_oracle_price_twap_ts {
            let since_last_valid = cast_to_i128(
                amm.last_mark_price_twap_ts
                    .checked_sub(amm.historical_oracle_data.last_oracle_price_twap_ts)
                    .ok_or_else(math_error!())?,
            )?;
            msg!(
                "correcting oracle twap update (oracle previously invalid for {:?} seconds)",
                since_last_valid
            );

            let from_start_valid = max(
                1,
                cast_to_i128(period)?
                    .checked_sub(since_last_valid)
                    .ok_or_else(math_error!())?,
            );
            calculate_weighted_average(
                cast_to_i128(last_mark_twap)?,
                oracle_price,
                since_last_valid,
                from_start_valid,
            )?
        } else {
            oracle_price
        };

    let new_twap = calculate_weighted_average(
        interpolated_oracle_price,
        last_oracle_twap,
        since_last,
        from_start,
    )?;

    Ok(new_twap)
}

pub fn update_amm_mark_std(
    amm: &mut AMM,
    now: i64,
    price: u128,
    ewma: u128,
) -> ClearingHouseResult<bool> {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.last_mark_price_twap_ts)
            .ok_or_else(math_error!())?,
    ))?;

    let price_change = cast_to_i128(price)?
        .checked_sub(cast_to_i128(ewma)?)
        .ok_or_else(math_error!())?;

    amm.mark_std = calculate_rolling_sum(
        amm.mark_std,
        cast_to_u64(price_change.unsigned_abs())?,
        max(ONE_HOUR_I128, since_last),
        ONE_HOUR_I128,
    )?;

    Ok(true)
}

pub fn update_amm_long_short_intensity(
    amm: &mut AMM,
    now: i64,
    quote_asset_amount: u64,
    direction: PositionDirection,
) -> ClearingHouseResult<bool> {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.last_trade_ts)
            .ok_or_else(math_error!())?,
    ))?;

    let (long_quote_amount, short_quote_amount) = if direction == PositionDirection::Long {
        (quote_asset_amount, 0_u64)
    } else {
        (0_u64, quote_asset_amount)
    };

    amm.long_intensity_count = (calculate_rolling_sum(
        cast_to_u64(amm.long_intensity_count)?,
        cast_to_u64(long_quote_amount != 0)?,
        since_last,
        ONE_HOUR_I128,
    )?) as u16;
    amm.long_intensity_volume = calculate_rolling_sum(
        amm.long_intensity_volume,
        long_quote_amount,
        since_last,
        ONE_HOUR_I128,
    )?;

    amm.short_intensity_count = (calculate_rolling_sum(
        cast_to_u64(amm.short_intensity_count)?,
        cast_to_u64(short_quote_amount != 0)?,
        since_last,
        ONE_HOUR_I128,
    )?) as u16;
    amm.short_intensity_volume = calculate_rolling_sum(
        amm.short_intensity_volume,
        short_quote_amount,
        since_last,
        ONE_HOUR_I128,
    )?;

    Ok(true)
}

pub fn calculate_swap_output(
    swap_amount: u128,
    input_asset_reserve: u128,
    direction: SwapDirection,
    invariant_sqrt: u128,
) -> ClearingHouseResult<(u128, u128)> {
    let invariant_sqrt_u192 = U192::from(invariant_sqrt);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    if direction == SwapDirection::Remove && swap_amount > input_asset_reserve {
        msg!("{:?} > {:?}", swap_amount, input_asset_reserve);
        return Err(ErrorCode::TradeSizeTooLarge);
    }

    let new_input_asset_reserve = if let SwapDirection::Add = direction {
        input_asset_reserve
            .checked_add(swap_amount)
            .ok_or_else(math_error!())?
    } else {
        input_asset_reserve
            .checked_sub(swap_amount)
            .ok_or_else(math_error!())?
    };

    let new_input_amount_u192 = U192::from(new_input_asset_reserve);
    let new_output_asset_reserve = invariant
        .checked_div(new_input_amount_u192)
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    Ok((new_output_asset_reserve, new_input_asset_reserve))
}

pub fn calculate_quote_asset_amount_swapped(
    quote_asset_reserve_before: u128,
    quote_asset_reserve_after: u128,
    swap_direction: SwapDirection,
    peg_multiplier: u128,
) -> ClearingHouseResult<u128> {
    let mut quote_asset_reserve_change = match swap_direction {
        SwapDirection::Add => quote_asset_reserve_before
            .checked_sub(quote_asset_reserve_after)
            .ok_or_else(math_error!())?,

        SwapDirection::Remove => quote_asset_reserve_after
            .checked_sub(quote_asset_reserve_before)
            .ok_or_else(math_error!())?,
    };

    // when a user goes long base asset, make the base asset slightly more expensive
    // by adding one unit of quote asset
    if swap_direction == SwapDirection::Remove {
        quote_asset_reserve_change = quote_asset_reserve_change
            .checked_add(1)
            .ok_or_else(math_error!())?;
    }

    let mut quote_asset_amount =
        reserve_to_asset_amount(quote_asset_reserve_change, peg_multiplier)?;

    // when a user goes long base asset, make the base asset slightly more expensive
    // by adding one unit of quote asset
    if swap_direction == SwapDirection::Remove {
        quote_asset_amount = quote_asset_amount
            .checked_add(1)
            .ok_or_else(math_error!())?;
    }

    Ok(quote_asset_amount)
}

pub fn calculate_terminal_reserves(amm: &AMM) -> ClearingHouseResult<(u128, u128)> {
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

pub fn calculate_terminal_price_and_reserves(amm: &AMM) -> ClearingHouseResult<(u128, u128, u128)> {
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
    oracle_price_data: &OraclePriceData,
    precomputed_reserve_price: Option<u128>,
) -> ClearingHouseResult<(i128, i128)> {
    let reserve_price = match precomputed_reserve_price {
        Some(reserve_price) => cast_to_i128(reserve_price)?,
        None => cast_to_i128(amm.reserve_price()?)?,
    };

    let oracle_price = oracle_price_data.price;

    let price_spread = reserve_price
        .checked_sub(oracle_price)
        .ok_or_else(math_error!())?;

    Ok((oracle_price, price_spread))
}

pub fn normalise_oracle_price(
    amm: &AMM,
    oracle_price: &OraclePriceData,
    precomputed_reserve_price: Option<u128>,
) -> ClearingHouseResult<i128> {
    let OraclePriceData {
        price: oracle_price,
        confidence: oracle_conf,
        ..
    } = *oracle_price;

    let reserve_price = match precomputed_reserve_price {
        Some(reserve_price) => cast_to_i128(reserve_price)?,
        None => cast_to_i128(amm.reserve_price()?)?,
    };

    // 2.5 bps of the mark price
    let reserve_price_2p5_bps = reserve_price.checked_div(4000).ok_or_else(math_error!())?;
    let conf_int = cast_to_i128(oracle_conf)?;

    //  normalises oracle toward mark price based on the oracle’s confidence interval
    //  if mark above oracle: use oracle+conf unless it exceeds .99975 * mark price
    //  if mark below oracle: use oracle-conf unless it less than 1.00025 * mark price
    //  (this guarantees more reasonable funding rates in volatile periods)
    let normalised_price = if reserve_price > oracle_price {
        min(
            max(
                reserve_price
                    .checked_sub(reserve_price_2p5_bps)
                    .ok_or_else(math_error!())?,
                oracle_price,
            ),
            oracle_price
                .checked_add(conf_int)
                .ok_or_else(math_error!())?,
        )
    } else {
        max(
            min(
                reserve_price
                    .checked_add(reserve_price_2p5_bps)
                    .ok_or_else(math_error!())?,
                oracle_price,
            ),
            oracle_price
                .checked_sub(conf_int)
                .ok_or_else(math_error!())?,
        )
    };

    Ok(normalised_price)
}

pub fn calculate_oracle_reserve_price_spread_pct(
    amm: &AMM,
    oracle_price_data: &OraclePriceData,
    precomputed_reserve_price: Option<u128>,
) -> ClearingHouseResult<i128> {
    let reserve_price = match precomputed_reserve_price {
        Some(reserve_price) => reserve_price,
        None => amm.reserve_price()?,
    };
    let (_oracle_price, price_spread) =
        calculate_oracle_reserve_price_spread(amm, oracle_price_data, Some(reserve_price))?;

    price_spread
        .checked_mul(BID_ASK_SPREAD_PRECISION_I128)
        .ok_or_else(math_error!())?
        .checked_div(cast_to_i128(reserve_price)?) // todo? better for spread logic
        .ok_or_else(math_error!())
}

pub fn calculate_oracle_twap_5min_mark_spread_pct(
    amm: &AMM,
    precomputed_reserve_price: Option<u128>,
) -> ClearingHouseResult<i128> {
    let reserve_price = match precomputed_reserve_price {
        Some(reserve_price) => reserve_price,
        None => amm.reserve_price()?,
    };
    let price_spread = cast_to_i128(reserve_price)?
        .checked_sub(amm.historical_oracle_data.last_oracle_price_twap_5min)
        .ok_or_else(math_error!())?;

    // price_spread_pct
    price_spread
        .checked_mul(BID_ASK_SPREAD_PRECISION_I128)
        .ok_or_else(math_error!())?
        .checked_div(cast_to_i128(reserve_price)?) // todo? better for spread logic
        .ok_or_else(math_error!())
}

pub fn is_oracle_mark_too_divergent(
    price_spread_pct: i128,
    oracle_guard_rails: &PriceDivergenceGuardRails,
) -> ClearingHouseResult<bool> {
    let max_divergence = oracle_guard_rails
        .mark_oracle_divergence_numerator
        .checked_mul(BID_ASK_SPREAD_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(oracle_guard_rails.mark_oracle_divergence_denominator)
        .ok_or_else(math_error!())?;

    Ok(price_spread_pct.unsigned_abs() > max_divergence)
}

pub fn calculate_mark_twap_spread_pct(amm: &AMM, reserve_price: u128) -> ClearingHouseResult<i128> {
    let reserve_price = cast_to_i128(reserve_price)?;
    let mark_twap = cast_to_i128(amm.last_mark_price_twap)?;

    let price_spread = reserve_price
        .checked_sub(mark_twap)
        .ok_or_else(math_error!())?;

    price_spread
        .checked_mul(BID_ASK_SPREAD_PRECISION_I128)
        .ok_or_else(math_error!())?
        .checked_div(mark_twap)
        .ok_or_else(math_error!())
}

pub fn use_oracle_price_for_margin_calculation(
    price_spread_pct: i128,
    oracle_guard_rails: &PriceDivergenceGuardRails,
) -> ClearingHouseResult<bool> {
    let max_divergence = oracle_guard_rails
        .mark_oracle_divergence_numerator
        .checked_mul(BID_ASK_SPREAD_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(oracle_guard_rails.mark_oracle_divergence_denominator)
        .ok_or_else(math_error!())?
        .checked_div(3)
        .ok_or_else(math_error!())?;

    Ok(price_spread_pct.unsigned_abs() > max_divergence)
}

pub fn calculate_max_base_asset_amount_fillable(
    amm: &AMM,
    order_direction: &PositionDirection,
) -> ClearingHouseResult<u64> {
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
        amm.order_step_size,
    )
}

pub fn calculate_net_user_cost_basis(amm: &AMM) -> ClearingHouseResult<i128> {
    amm.quote_asset_amount_long
        .checked_add(amm.quote_asset_amount_short)
        .ok_or_else(math_error!())?
        .checked_sub(amm.cumulative_social_loss)
        .ok_or_else(math_error!())
}

pub fn calculate_net_user_pnl(amm: &AMM, oracle_price: i128) -> ClearingHouseResult<i128> {
    validate!(
        oracle_price > 0,
        ErrorCode::DefaultError,
        "oracle_price <= 0",
    )?;

    let net_user_base_asset_value = amm
        .base_asset_amount_with_amm
        .checked_mul(oracle_price)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION_I128 * cast_to_i128(PRICE_TO_QUOTE_PRECISION_RATIO)?)
        .ok_or_else(math_error!())?;

    net_user_base_asset_value
        .checked_add(calculate_net_user_cost_basis(amm)?)
        .ok_or_else(math_error!())
}

pub fn calculate_expiry_price(
    amm: &AMM,
    target_price: i128,
    pnl_pool_amount: u128,
) -> ClearingHouseResult<i128> {
    if amm.base_asset_amount_with_amm == 0 {
        return Ok(target_price);
    }

    // net_baa * price + net_quote <= 0
    // net_quote/net_baa <= -price

    // net_user_unrealized_pnl negative = surplus in market
    // net_user_unrealized_pnl positive = expiry price needs to differ from oracle
    let best_expiry_price = -(amm
        .quote_asset_amount_long
        .checked_add(amm.quote_asset_amount_short)
        .ok_or_else(math_error!())?
        .checked_sub(cast_to_i128(pnl_pool_amount)?)
        .ok_or_else(math_error!())?
        .checked_mul(AMM_RESERVE_PRECISION_I128 * cast_to_i128(PRICE_TO_QUOTE_PRECISION_RATIO)?)
        .ok_or_else(math_error!())?
        .checked_div(amm.base_asset_amount_with_amm)
        .ok_or_else(math_error!())?);

    let expiry_price = if amm.base_asset_amount_with_amm > 0 {
        // net longs only get as high as oracle_price
        best_expiry_price
            .min(target_price)
            .checked_sub(1)
            .ok_or_else(math_error!())?
    } else {
        // net shorts only get as low as oracle price
        best_expiry_price
            .max(target_price)
            .checked_add(1)
            .ok_or_else(math_error!())?
    };

    Ok(expiry_price)
}
