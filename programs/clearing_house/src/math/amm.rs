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
use crate::state::market::AMM;
use crate::state::oracle::OraclePriceData;
use crate::state::state::PriceDivergenceGuardRails;
use crate::validate;
use solana_program::msg;
use std::cmp::{max, min};

use super::helpers::get_proportion_u128;

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
    let swap_direction = if amm.net_base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (new_quote_asset_amount, new_base_asset_amount) = calculate_swap_output(
        amm.net_base_asset_amount.unsigned_abs(),
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
    let swap_direction = if amm.net_base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (new_quote_asset_amount, new_base_asset_amount) = calculate_swap_output(
        amm.net_base_asset_amount.unsigned_abs(),
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
    let max_fill_size: u64 =
        (amm.base_asset_reserve / amm.max_base_asset_amount_ratio as u128).cast()?;

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
        .net_base_asset_amount
        .checked_mul(oracle_price)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION_I128 * cast_to_i128(PRICE_TO_QUOTE_PRECISION_RATIO)?)
        .ok_or_else(math_error!())?;

    net_user_base_asset_value
        .checked_add(calculate_net_user_cost_basis(amm)?)
        .ok_or_else(math_error!())
}

pub fn calculate_settlement_price(
    amm: &AMM,
    target_price: i128,
    pnl_pool_amount: u128,
) -> ClearingHouseResult<i128> {
    if amm.net_base_asset_amount == 0 {
        return Ok(target_price);
    }

    // net_baa * price + net_quote <= 0
    // net_quote/net_baa <= -price

    // net_user_unrealized_pnl negative = surplus in market
    // net_user_unrealized_pnl positive = settlement price needs to differ from oracle
    let best_settlement_price = -(amm
        .quote_asset_amount_long
        .checked_add(amm.quote_asset_amount_short)
        .ok_or_else(math_error!())?
        .checked_sub(cast_to_i128(pnl_pool_amount)?)
        .ok_or_else(math_error!())?
        .checked_mul(AMM_RESERVE_PRECISION_I128 * cast_to_i128(PRICE_TO_QUOTE_PRECISION_RATIO)?)
        .ok_or_else(math_error!())?
        .checked_div(amm.net_base_asset_amount)
        .ok_or_else(math_error!())?);

    let settlement_price = if amm.net_base_asset_amount > 0 {
        // net longs only get as high as oracle_price
        best_settlement_price
            .min(target_price)
            .checked_sub(1)
            .ok_or_else(math_error!())?
    } else {
        // net shorts only get as low as oracle price
        best_settlement_price
            .max(target_price)
            .checked_add(1)
            .ok_or_else(math_error!())?
    };

    Ok(settlement_price)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, PEG_PRECISION, PRICE_PRECISION, PRICE_PRECISION_I128,
        QUOTE_PRECISION, QUOTE_PRECISION_I128,
    };
    use crate::state::market::PerpMarket;
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::user::PerpPosition;

    #[test]
    fn calculate_net_user_pnl_test() {
        let prev = 1656682258;
        let _now = prev + 3600;

        let px = 32 * PRICE_PRECISION;

        let mut amm = AMM {
            base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            peg_multiplier: PEG_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: px as i128,
                last_oracle_price_twap_ts: prev,

                ..HistoricalOracleData::default()
            },
            mark_std: PRICE_PRECISION as u64,
            last_mark_price_twap_ts: prev,
            funding_period: 3600_i64,
            ..AMM::default_test()
        };

        let oracle_price_data = OraclePriceData {
            price: (34 * PRICE_PRECISION) as i128,
            confidence: PRICE_PRECISION / 100,
            delay: 1,
            has_sufficient_number_of_data_points: true,
        };

        let net_user_pnl = calculate_net_user_pnl(&amm, oracle_price_data.price).unwrap();
        assert_eq!(net_user_pnl, 0);

        amm.cumulative_social_loss = -QUOTE_PRECISION_I128;
        let net_user_pnl = calculate_net_user_pnl(&amm, oracle_price_data.price).unwrap();
        assert_eq!(net_user_pnl, QUOTE_PRECISION_I128);

        let market = PerpMarket::default_btc_test();
        let net_user_pnl = calculate_net_user_pnl(
            &market.amm,
            market.amm.historical_oracle_data.last_oracle_price,
        )
        .unwrap();
        assert_eq!(net_user_pnl, -400000000); // down $400

        let net_user_pnl =
            calculate_net_user_pnl(&market.amm, 17501 * PRICE_PRECISION_I128).unwrap();
        assert_eq!(net_user_pnl, 1499000000); // up $1499
    }

    #[test]
    fn calculate_settlement_price_long_imbalance_with_loss_test() {
        let prev = 1656682258;
        let _now = prev + 3600;

        // imbalanced short, no longs
        // btc
        let oracle_price_data = OraclePriceData {
            price: (22050 * PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let market_position = PerpPosition {
            market_index: 0,
            base_asset_amount: (12295081967 / 2_i64),
            quote_asset_amount: -193688524588, // $31506 entry price
            ..PerpPosition::default()
        };

        let market = PerpMarket {
            market_index: 0,
            amm: AMM {
                base_asset_reserve: 512295081967,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 22_100_000_000,
                net_base_asset_amount: (12295081967_i128),
                max_spread: 1000,
                quote_asset_amount_long: market_position.quote_asset_amount as i128 * 2,
                // assume someone else has other half same entry,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            imf_factor: 1000, // 1_000/1_000_000 = .001
            unrealized_initial_asset_weight: 100,
            unrealized_maintenance_asset_weight: 100,
            ..PerpMarket::default()
        };

        let mut settlement_price =
            calculate_settlement_price(&market.amm, oracle_price_data.price, 0).unwrap();

        let reserve_price = market.amm.reserve_price().unwrap();
        let (terminal_price, _, _) = calculate_terminal_price_and_reserves(&market.amm).unwrap();
        let oracle_price = oracle_price_data.price;

        assert_eq!(settlement_price, 22049999999);
        assert_eq!(terminal_price, 20076684570);
        assert_eq!(oracle_price, 22050000000);
        assert_eq!(reserve_price, 21051929600);

        settlement_price = calculate_settlement_price(
            &market.amm,
            oracle_price_data.price,
            111_111_110, // $111
        )
        .unwrap();

        assert_eq!(settlement_price, 22049999999); // same price

        settlement_price = calculate_settlement_price(
            &market.amm,
            oracle_price_data.price,
            1_111_111_110, // $1,111
        )
        .unwrap();

        assert_eq!(settlement_price, 22049999999); // same price again

        settlement_price = calculate_settlement_price(
            &market.amm,
            oracle_price_data.price,
            111_111_110 * QUOTE_PRECISION,
        )
        .unwrap();

        assert_eq!(settlement_price, 22049999999);
        assert_eq!(settlement_price, oracle_price - 1); // more longs than shorts, bias = -1
    }

    #[test]
    fn calculate_settlement_price_long_imbalance_test() {
        let prev = 1656682258;
        let _now = prev + 3600;

        // imbalanced short, no longs
        // btc
        let oracle_price_data = OraclePriceData {
            price: (22050 * PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let market_position = PerpPosition {
            market_index: 0,
            base_asset_amount: (12295081967 / 2_i64),
            quote_asset_amount: -103688524588, // $16,866.66 entry price
            ..PerpPosition::default()
        };

        let market = PerpMarket {
            market_index: 0,
            amm: AMM {
                base_asset_reserve: 512295081967,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 22_100_000_000,
                net_base_asset_amount: (12295081967_i128),
                max_spread: 1000,
                quote_asset_amount_long: market_position.quote_asset_amount as i128 * 2,
                // assume someone else has other half same entry,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            imf_factor: 1000, // 1_000/1_000_000 = .001
            unrealized_initial_asset_weight: 100,
            unrealized_maintenance_asset_weight: 100,
            ..PerpMarket::default()
        };

        let mut settlement_price =
            calculate_settlement_price(&market.amm, oracle_price_data.price, 0).unwrap();

        let reserve_price = market.amm.reserve_price().unwrap();
        let (terminal_price, _, _) = calculate_terminal_price_and_reserves(&market.amm).unwrap();
        let oracle_price = oracle_price_data.price;

        assert_eq!(settlement_price, 16866666665);
        assert_eq!(terminal_price, 20076684570);
        assert_eq!(oracle_price, 22050000000);
        assert_eq!(reserve_price, 21051929600);

        settlement_price = calculate_settlement_price(
            &market.amm,
            oracle_price_data.price,
            111_111_110, // $111
        )
        .unwrap();

        assert_eq!(settlement_price, 16875703702); // better price

        settlement_price = calculate_settlement_price(
            &market.amm,
            oracle_price_data.price,
            1_111_111_110, // $1,111
        )
        .unwrap();

        assert_eq!(settlement_price, 16957037035); // even better price

        settlement_price = calculate_settlement_price(
            &market.amm,
            oracle_price_data.price,
            111_111_110 * QUOTE_PRECISION,
        )
        .unwrap();

        assert_eq!(settlement_price, 22049999999);
        assert_eq!(settlement_price, oracle_price - 1); // more longs than shorts, bias = -1
    }

    #[test]
    fn calculate_settlement_price_test() {
        let prev = 1656682258;
        let _now = prev + 3600;

        let px = 32 * PRICE_PRECISION;

        let amm = AMM {
            base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            peg_multiplier: PEG_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: px as i128,
                last_oracle_price_twap_ts: prev,

                ..HistoricalOracleData::default()
            },
            mark_std: PRICE_PRECISION as u64,
            last_mark_price_twap_ts: prev,
            funding_period: 3600_i64,
            ..AMM::default_test()
        };

        let oracle_price_data = OraclePriceData {
            price: (34 * PRICE_PRECISION) as i128,
            confidence: PRICE_PRECISION / 100,
            delay: 1,
            has_sufficient_number_of_data_points: true,
        };

        let mut settlement_price =
            calculate_settlement_price(&amm, oracle_price_data.price, 0).unwrap();

        assert_eq!(settlement_price, oracle_price_data.price);

        settlement_price =
            calculate_settlement_price(&amm, oracle_price_data.price, 111111110).unwrap();

        assert_eq!(settlement_price, oracle_price_data.price);

        // imbalanced short, no longs
        // btc
        let oracle_price_data = OraclePriceData {
            price: (22050 * PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let market_position = PerpPosition {
            market_index: 0,
            base_asset_amount: -(122950819670000 / 2_i64),
            quote_asset_amount: 153688524588, // $25,000 entry price
            ..PerpPosition::default()
        };

        let market = PerpMarket {
            market_index: 0,
            amm: AMM {
                base_asset_reserve: 512295081967,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 22_100_000_000,
                net_base_asset_amount: -(12295081967_i128),
                max_spread: 1000,
                quote_asset_amount_short: market_position.quote_asset_amount as i128 * 2,
                // assume someone else has other half same entry,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            imf_factor: 1000, // 1_000/1_000_000 = .001
            unrealized_initial_asset_weight: 100,
            unrealized_maintenance_asset_weight: 100,
            ..PerpMarket::default()
        };

        let mut settlement_price =
            calculate_settlement_price(&market.amm, oracle_price_data.price, 0).unwrap();

        let reserve_price = market.amm.reserve_price().unwrap();
        let (terminal_price, _, _) = calculate_terminal_price_and_reserves(&market.amm).unwrap();
        let oracle_price = oracle_price_data.price;

        assert_eq!(settlement_price, 25000000001);
        assert_eq!(terminal_price, 22100000000);
        assert_eq!(oracle_price, 22050000000);
        assert_eq!(reserve_price, 21051929600);

        settlement_price = calculate_settlement_price(
            &market.amm,
            oracle_price_data.price,
            111_111_110, // $111
        )
        .unwrap();

        // 250000000000814 - 249909629631346 = 90370369468 (~$9 improved)
        assert_eq!(settlement_price, 24990962964); // better price

        settlement_price = calculate_settlement_price(
            &market.amm,
            oracle_price_data.price,
            1_111_111_110, // $1,111
        )
        .unwrap();

        // 250000000000814 - 249096296297998 = 903703702816 (~$90 improved)
        assert_eq!(settlement_price, 24909629630); // even better price

        settlement_price = calculate_settlement_price(
            &market.amm,
            oracle_price_data.price,
            111111110 * QUOTE_PRECISION,
        )
        .unwrap();

        assert_eq!(settlement_price, 22050000001);
        assert_eq!(settlement_price, oracle_price + 1); // more shorts than longs, bias = +1
    }

    #[test]
    fn calc_mark_std_tests() {
        let prev = 1656682258;
        let mut now = prev + 60;
        let mut amm = AMM {
            base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            peg_multiplier: PRICE_PRECISION,
            base_spread: 65535, //max base spread is 6.5%
            mark_std: PRICE_PRECISION as u64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: PRICE_PRECISION as i128,
                ..HistoricalOracleData::default()
            },
            last_mark_price_twap_ts: prev,
            ..AMM::default()
        };
        update_amm_mark_std(&mut amm, now, PRICE_PRECISION * 23, 0).unwrap();
        assert_eq!(amm.mark_std, 23000000);

        amm.mark_std = PRICE_PRECISION as u64;
        amm.last_mark_price_twap_ts = now - 60;
        update_amm_mark_std(&mut amm, now, PRICE_PRECISION * 2, 0).unwrap();
        assert_eq!(amm.mark_std, 2000000);

        let mut px = PRICE_PRECISION;
        let stop_time = now + 3600 * 2;
        while now <= stop_time {
            now += 1;
            if now % 15 == 0 {
                px = px * 1012 / 1000;
                amm.historical_oracle_data.last_oracle_price =
                    amm.historical_oracle_data.last_oracle_price * 10119 / 10000;
            } else {
                px = px * 100000 / 100133;
                amm.historical_oracle_data.last_oracle_price =
                    amm.historical_oracle_data.last_oracle_price * 100001 / 100133;
            }
            amm.peg_multiplier = px;
            let trade_direction = PositionDirection::Long;
            update_mark_twap(&mut amm, now, Some(px), Some(trade_direction)).unwrap();
        }
        assert_eq!(now, 1656689519);
        assert_eq!(px, 39397);
        assert_eq!(amm.mark_std, 105);

        // sol price looking thinkg
        let mut px: u128 = 31_936_658;
        let stop_time = now + 3600 * 2;
        while now <= stop_time {
            now += 1;
            if now % 15 == 0 {
                px = 31_986_658; //31.98
                amm.historical_oracle_data.last_oracle_price = (px - 1000000) as i128;
                amm.peg_multiplier = px;

                let trade_direction = PositionDirection::Long;
                update_mark_twap(&mut amm, now, Some(px), Some(trade_direction)).unwrap();
            }
            if now % 189 == 0 {
                px = 31_883_651; //31.88
                amm.peg_multiplier = px;

                amm.historical_oracle_data.last_oracle_price = (px + 1000000) as i128;
                let trade_direction = PositionDirection::Short;
                update_mark_twap(&mut amm, now, Some(px), Some(trade_direction)).unwrap();
            }
        }
        assert_eq!(now, 1656696720);
        assert_eq!(px, 31986658);
        assert_eq!(amm.mark_std, 384673);

        // sol price looking thinkg
        let mut px: u128 = 31_936_658;
        let stop_time = now + 3600 * 2;
        while now <= stop_time {
            now += 1;
            if now % 2 == 1 {
                px = 31_986_658; //31.98
                amm.peg_multiplier = px;

                amm.historical_oracle_data.last_oracle_price = (px - 1000000) as i128;
                let trade_direction = PositionDirection::Long;
                update_mark_twap(&mut amm, now, Some(px), Some(trade_direction)).unwrap();
            }
            if now % 2 == 0 {
                px = 31_883_651; //31.88
                amm.peg_multiplier = px;

                amm.historical_oracle_data.last_oracle_price = (px + 1000000) as i128;
                let trade_direction = PositionDirection::Short;
                update_mark_twap(&mut amm, now, Some(px), Some(trade_direction)).unwrap();
            }
        }
        assert_eq!(now, 1656703921);
        assert_eq!(px, 31986658);
        assert_eq!(amm.mark_std, 97995); //.068
    }

    #[test]
    fn update_mark_twap_tests() {
        let prev = 0;

        let mut now = 1;

        let mut oracle_price_data = OraclePriceData {
            price: 40_021_280 * PRICE_PRECISION_I128 / 1_000_000,
            confidence: PRICE_PRECISION / 100,
            delay: 1,
            has_sufficient_number_of_data_points: true,
        };

        // $40 everything init
        let mut amm = AMM {
            quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            peg_multiplier: 40 * PEG_PRECISION,
            base_spread: 0,
            long_spread: 0,
            short_spread: 0,
            last_mark_price_twap: (40 * PRICE_PRECISION),
            last_bid_price_twap: (40 * PRICE_PRECISION),
            last_ask_price_twap: (40 * PRICE_PRECISION),
            last_mark_price_twap_ts: prev,
            funding_period: 3600,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: (40 * PRICE_PRECISION) as i128,
                last_oracle_price_twap: (40 * PRICE_PRECISION) as i128,
                last_oracle_price_twap_ts: prev,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        };

        update_oracle_price_twap(&mut amm, now, &oracle_price_data, None).unwrap();
        assert_eq!(
            amm.historical_oracle_data.last_oracle_price,
            oracle_price_data.price
        );
        assert_eq!(
            amm.historical_oracle_data.last_oracle_price,
            40_021_280 * PRICE_PRECISION_I128 / 1_000_000
        );

        let trade_price = 40_051_280 * PRICE_PRECISION / 1_000_000;
        let trade_direction = PositionDirection::Long;

        let old_mark_twap = amm.last_mark_price_twap;
        let new_mark_twap =
            update_mark_twap(&mut amm, now, Some(trade_price), Some(trade_direction)).unwrap();
        let new_bid_twap = amm.last_bid_price_twap;
        let new_ask_twap = amm.last_ask_price_twap;

        assert!(new_mark_twap > old_mark_twap);
        assert_eq!(new_ask_twap, 40000015);
        assert_eq!(new_bid_twap, 40000006);
        assert_eq!(new_mark_twap, 40000010);
        assert!(new_bid_twap < new_ask_twap);

        while now < 3600 {
            now += 1;
            update_oracle_price_twap(&mut amm, now, &oracle_price_data, None).unwrap();
            update_mark_twap(&mut amm, now, Some(trade_price), Some(trade_direction)).unwrap();
        }

        let new_oracle_twap = amm.historical_oracle_data.last_oracle_price_twap;
        let new_mark_twap = amm.last_mark_price_twap;
        let new_bid_twap = amm.last_bid_price_twap;
        let new_ask_twap = amm.last_ask_price_twap;

        assert!(new_bid_twap < new_ask_twap);
        assert_eq!((new_bid_twap + new_ask_twap) / 2, new_mark_twap);
        assert!((new_oracle_twap as u128) < new_mark_twap); // funding in favor of maker?
        assert_eq!(new_oracle_twap, 40008161);
        assert_eq!(new_bid_twap, 40014548);
        assert_eq!(new_mark_twap, 40024054); // < 2 cents above oracle twap
        assert_eq!(new_ask_twap, 40033561);

        let trade_price_2 = 39_971_280 * PRICE_PRECISION / 1_000_000;
        let trade_direction_2 = PositionDirection::Short;
        oracle_price_data = OraclePriceData {
            price: 39_991_280 * PRICE_PRECISION_I128 / 1_000_000,
            confidence: PRICE_PRECISION / 80,
            delay: 14,
            has_sufficient_number_of_data_points: true,
        };

        while now <= 3600 * 2 {
            now += 1;
            update_oracle_price_twap(&mut amm, now, &oracle_price_data, None).unwrap();
            if now % 200 == 0 {
                update_mark_twap(&mut amm, now, Some(trade_price_2), Some(trade_direction_2))
                    .unwrap(); // ~2 cents below oracle
            }
        }

        let new_oracle_twap = amm.historical_oracle_data.last_oracle_price_twap;
        let new_mark_twap = amm.last_mark_price_twap;
        let new_bid_twap = amm.last_bid_price_twap;
        let new_ask_twap = amm.last_ask_price_twap;

        assert_eq!(new_bid_twap, 39_986_750);
        assert_eq!(new_ask_twap, 40_006_398);
        assert!(new_bid_twap < new_ask_twap);
        assert_eq!((new_bid_twap + new_ask_twap) / 2, new_mark_twap);
        // TODO fails here
        assert_eq!(new_oracle_twap, 39_998_518);
        assert_eq!(new_mark_twap, 39_996_574);
        assert_eq!(new_bid_twap, 39_986_750); // ema from prev twap
        assert_eq!(new_ask_twap, 40_006_398); // ema from prev twap

        assert!((new_oracle_twap as u128) >= new_mark_twap); // funding in favor of maker
    }

    #[test]
    fn calc_oracle_twap_tests() {
        let prev = 1656682258;
        let now = prev + 3600;

        let px = 32 * PRICE_PRECISION;

        let mut amm = AMM {
            base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            peg_multiplier: PEG_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: px as i128,
                last_oracle_price_twap_ts: prev,
                ..HistoricalOracleData::default()
            },
            mark_std: PRICE_PRECISION as u64,
            last_mark_price_twap_ts: prev,
            funding_period: 3600_i64,
            ..AMM::default()
        };
        let mut oracle_price_data = OraclePriceData {
            price: (34 * PRICE_PRECISION) as i128,
            confidence: PRICE_PRECISION / 100,
            delay: 1,
            has_sufficient_number_of_data_points: true,
        };

        let _new_oracle_twap =
            update_oracle_price_twap(&mut amm, now, &oracle_price_data, None).unwrap();
        assert_eq!(
            amm.historical_oracle_data.last_oracle_price_twap,
            (34 * PRICE_PRECISION - PRICE_PRECISION / 100) as i128
        );

        // let after_ts = amm.historical_oracle_data.last_oracle_price_twap_ts;
        amm.last_mark_price_twap_ts = now - 60;
        amm.historical_oracle_data.last_oracle_price_twap_ts = now - 60;
        // let after_ts_2 = amm.historical_oracle_data.last_oracle_price_twap_ts;
        oracle_price_data = OraclePriceData {
            price: (31 * PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };
        // let old_oracle_twap_2 = amm.historical_oracle_data.last_oracle_price_twap;
        let _new_oracle_twap_2 =
            update_oracle_price_twap(&mut amm, now, &oracle_price_data, None).unwrap();
        assert_eq!(amm.historical_oracle_data.last_oracle_price_twap, 33940167);
        assert_eq!(
            amm.historical_oracle_data.last_oracle_price_twap_5min,
            33392001
        );

        let _new_oracle_twap_2 =
            update_oracle_price_twap(&mut amm, now + 60 * 5, &oracle_price_data, None).unwrap();

        assert_eq!(amm.historical_oracle_data.last_oracle_price_twap, 33695154);
        assert_eq!(
            amm.historical_oracle_data.last_oracle_price_twap_5min,
            31 * PRICE_PRECISION_I128
        );

        oracle_price_data = OraclePriceData {
            price: (32 * PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let _new_oracle_twap_2 =
            update_oracle_price_twap(&mut amm, now + 60 * 5 + 60, &oracle_price_data, None)
                .unwrap();
        assert_eq!(
            amm.historical_oracle_data.last_oracle_price_twap_5min,
            31200001
        );
    }
}
