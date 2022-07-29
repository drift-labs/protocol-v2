use std::cmp::{max, min};

use crate::controller::amm::SwapDirection;
use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::bn;
use crate::math::bn::U192;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128, cast_to_u64};
use crate::math::constants::{
    AMM_RESERVE_PRECISION, AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO_I128,
    AMM_TO_QUOTE_PRECISION_RATIO_I128, BID_ASK_SPREAD_PRECISION, BID_ASK_SPREAD_PRECISION_I128,
    K_BPS_DECREASE_MAX, K_BPS_INCREASE_MAX, K_BPS_UPDATE_SCALE, MARK_PRICE_PRECISION,
    MAX_BID_ASK_INVENTORY_SKEW_FACTOR, ONE_HOUR_I128, PEG_PRECISION, PRICE_TO_PEG_PRECISION_RATIO,
    QUOTE_PRECISION,
};
use crate::math::orders::standardize_base_asset_amount;
use crate::math::position::{_calculate_base_asset_value_and_pnl, calculate_base_asset_value};
use crate::math::quote_asset::reserve_to_asset_amount;
use crate::math_error;
use crate::state::market::{Market, AMM};
use crate::state::oracle::OraclePriceData;
use crate::state::state::{PriceDivergenceGuardRails, ValidityGuardRails};
use solana_program::msg;

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

pub fn calculate_terminal_price(market: &mut Market) -> ClearingHouseResult<u128> {
    let swap_direction = if market.amm.net_base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (new_quote_asset_amount, new_base_asset_amount) = calculate_swap_output(
        market.amm.net_base_asset_amount.unsigned_abs(),
        market.amm.base_asset_reserve,
        swap_direction,
        market.amm.sqrt_k,
    )?;

    let terminal_price = calculate_price(
        new_quote_asset_amount,
        new_base_asset_amount,
        market.amm.peg_multiplier,
    )?;

    Ok(terminal_price)
}

pub fn calculate_spread(
    base_spread: u16,
    last_oracle_mark_spread_pct: i128,
    last_oracle_conf_pct: u64,
    max_spread: u32,
    quote_asset_reserve: u128,
    terminal_quote_asset_reserve: u128,
    peg_multiplier: u128,
    net_base_asset_amount: i128,
    mark_price: u128,
    total_fee_minus_distributions: i128,
) -> ClearingHouseResult<(u128, u128)> {
    let mut long_spread = (base_spread / 2) as u128;
    let mut short_spread = (base_spread / 2) as u128;

    // oracle retreat
    // if mark - oracle < 0 (mark below oracle) and user going long then increase spread
    if last_oracle_mark_spread_pct < 0 {
        long_spread = max(
            long_spread,
            last_oracle_mark_spread_pct
                .unsigned_abs()
                .checked_add(last_oracle_conf_pct as u128)
                .ok_or_else(math_error!())?,
        );
    } else {
        short_spread = max(
            short_spread,
            last_oracle_mark_spread_pct
                .unsigned_abs()
                .checked_add(last_oracle_conf_pct as u128)
                .ok_or_else(math_error!())?,
        );
    }

    // inventory scale
    let net_base_asset_value = cast_to_i128(quote_asset_reserve)?
        .checked_sub(cast_to_i128(terminal_quote_asset_reserve)?)
        .ok_or_else(math_error!())?
        .checked_mul(cast_to_i128(peg_multiplier)?)
        .ok_or_else(math_error!())?
        .checked_div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO_I128)
        .ok_or_else(math_error!())?;

    let local_base_asset_value = net_base_asset_amount
        .checked_mul(cast_to_i128(
            mark_price
                .checked_div(MARK_PRICE_PRECISION / PEG_PRECISION)
                .ok_or_else(math_error!())?,
        )?)
        .ok_or_else(math_error!())?
        .checked_div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO_I128)
        .ok_or_else(math_error!())?;

    let effective_leverage = max(
        0,
        local_base_asset_value
            .checked_sub(net_base_asset_value)
            .ok_or_else(math_error!())?,
    )
    .checked_mul(BID_ASK_SPREAD_PRECISION_I128)
    .ok_or_else(math_error!())?
    .checked_div(max(0, total_fee_minus_distributions) + 1)
    .ok_or_else(math_error!())?;

    let effective_leverage_capped = min(
        MAX_BID_ASK_INVENTORY_SKEW_FACTOR,
        BID_ASK_SPREAD_PRECISION
            .checked_add(cast_to_u128(max(0, effective_leverage))? + 1)
            .ok_or_else(math_error!())?,
    );

    if total_fee_minus_distributions <= 0 {
        long_spread = long_spread
            .checked_mul(MAX_BID_ASK_INVENTORY_SKEW_FACTOR)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;
        short_spread = short_spread
            .checked_mul(MAX_BID_ASK_INVENTORY_SKEW_FACTOR)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;
    } else if net_base_asset_amount > 0 {
        long_spread = long_spread
            .checked_mul(effective_leverage_capped)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;
    } else {
        short_spread = short_spread
            .checked_mul(effective_leverage_capped)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;
    }
    let total_spread = long_spread
        .checked_add(short_spread)
        .ok_or_else(math_error!())?;

    let max_spread = max_spread as u128;

    if total_spread > max_spread {
        if long_spread > short_spread {
            long_spread = min(max_spread, long_spread);
            short_spread = max_spread
                .checked_sub(long_spread)
                .ok_or_else(math_error!())?;
        } else {
            short_spread = min(max_spread, short_spread);
            long_spread = max_spread
                .checked_sub(short_spread)
                .ok_or_else(math_error!())?;
        }
    }

    Ok((long_spread, short_spread))
}

pub fn update_mark_twap(
    amm: &mut AMM,
    now: i64,
    precomputed_trade_price: Option<u128>,
    direction: Option<PositionDirection>,
) -> ClearingHouseResult<u128> {
    let trade_price: u128 = match precomputed_trade_price {
        Some(trade_price) => trade_price,
        None => cast_to_u128(amm.last_oracle_price)?,
    };

    // optimistically estimation of bid/ask using execution premium
    let (bid_price, ask_price) = match direction {
        Some(direction) => match direction {
            PositionDirection::Long => (
                min(trade_price, cast_to_u128(amm.last_oracle_price)?),
                trade_price,
            ),
            PositionDirection::Short => (
                trade_price,
                max(trade_price, cast_to_u128(amm.last_oracle_price)?),
            ),
        },
        None => (trade_price, trade_price),
    };

    // update bid and ask twaps
    let bid_twap = calculate_new_twap(amm, now, bid_price, amm.last_bid_price_twap)?;
    amm.last_bid_price_twap = bid_twap;

    let ask_twap = calculate_new_twap(amm, now, ask_price, amm.last_ask_price_twap)?;
    amm.last_ask_price_twap = ask_twap;

    let mid_twap = bid_twap.checked_add(ask_twap).ok_or_else(math_error!())? / 2;
    amm.last_mark_price_twap = mid_twap;
    amm.last_mark_price_twap_ts = now;

    Ok(mid_twap)
}

pub fn calculate_new_twap(
    amm: &AMM,
    now: i64,
    current_price: u128,
    last_twap: u128,
) -> ClearingHouseResult<u128> {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.last_mark_price_twap_ts)
            .ok_or_else(math_error!())?,
    ))?;
    let from_start = max(
        1,
        cast_to_i128(amm.funding_period)?
            .checked_sub(since_last)
            .ok_or_else(math_error!())?,
    );

    let new_twap: u128 = cast(calculate_weighted_average(
        cast(current_price)?,
        cast(last_twap)?,
        since_last,
        from_start,
    )?)?;

    Ok(new_twap)
}

pub fn sanitize_new_price(
    oracle_price: i128,
    last_oracle_price_twap: i128,
) -> ClearingHouseResult<i128> {
    let new_oracle_price_spread = oracle_price
        .checked_sub(last_oracle_price_twap)
        .ok_or_else(math_error!())?;

    // cap new oracle update to 33% delta from twap
    let oracle_price_33pct = last_oracle_price_twap
        .checked_div(3)
        .ok_or_else(math_error!())?;

    let capped_oracle_update_price =
        if new_oracle_price_spread.unsigned_abs() > oracle_price_33pct.unsigned_abs() {
            if oracle_price > last_oracle_price_twap {
                last_oracle_price_twap
                    .checked_add(oracle_price_33pct)
                    .ok_or_else(math_error!())?
            } else {
                last_oracle_price_twap
                    .checked_sub(oracle_price_33pct)
                    .ok_or_else(math_error!())?
            }
        } else {
            oracle_price
        };

    Ok(capped_oracle_update_price)
}

pub fn update_oracle_price_twap(
    amm: &mut AMM,
    now: i64,
    oracle_price_data: &OraclePriceData,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<i128> {
    let mark_price = match precomputed_mark_price {
        Some(mark_price) => mark_price,
        None => amm.mark_price()?,
    };

    let oracle_price = normalise_oracle_price(amm, oracle_price_data, Some(mark_price))?;

    let capped_oracle_update_price = sanitize_new_price(oracle_price, amm.last_oracle_price_twap)?;

    // sanity check
    let oracle_price_twap: i128;
    if capped_oracle_update_price > 0 && oracle_price > 0 {
        oracle_price_twap = calculate_new_oracle_price_twap(amm, now, capped_oracle_update_price)?;

        //amm.last_oracle_mark_spread = precomputed_mark_price
        amm.last_oracle_normalised_price = capped_oracle_update_price;
        amm.last_oracle_price = oracle_price_data.price;
        amm.last_oracle_conf_pct = oracle_price_data
            .confidence
            .checked_mul(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(mark_price)
            .ok_or_else(math_error!())? as u64;
        amm.last_oracle_delay = oracle_price_data.delay;
        amm.last_oracle_mark_spread_pct =
            calculate_oracle_mark_spread_pct(amm, oracle_price_data, Some(mark_price))?;

        amm.last_oracle_price_twap = oracle_price_twap;
        amm.last_oracle_price_twap_ts = now;
    } else {
        oracle_price_twap = amm.last_oracle_price_twap
    }

    Ok(oracle_price_twap)
}

pub fn calculate_new_oracle_price_twap(
    amm: &AMM,
    now: i64,
    oracle_price: i128,
) -> ClearingHouseResult<i128> {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.last_oracle_price_twap_ts)
            .ok_or_else(math_error!())?,
    ))?;
    let from_start = max(
        0,
        cast_to_i128(amm.funding_period)?
            .checked_sub(since_last)
            .ok_or_else(math_error!())?,
    );

    // if an oracle delay impacted last oracle_twap, shrink toward mark_twap
    let interpolated_oracle_price = if amm.last_mark_price_twap_ts > amm.last_oracle_price_twap_ts {
        let since_last_valid = cast_to_i128(
            amm.last_mark_price_twap_ts
                .checked_sub(amm.last_oracle_price_twap_ts)
                .ok_or_else(math_error!())?,
        )?;
        msg!(
            "correcting oracle twap update (oracle previously invalid for {:?} seconds)",
            since_last_valid
        );

        let from_start_valid = max(
            1,
            cast_to_i128(amm.funding_period)?
                .checked_sub(since_last_valid)
                .ok_or_else(math_error!())?,
        );
        calculate_weighted_average(
            cast_to_i128(amm.last_mark_price_twap)?,
            oracle_price,
            since_last_valid,
            from_start_valid,
        )?
    } else {
        oracle_price
    };

    let new_twap = calculate_weighted_average(
        interpolated_oracle_price,
        amm.last_oracle_price_twap,
        since_last,
        from_start,
    )?;

    Ok(new_twap)
}

pub fn calculate_weighted_average(
    data1: i128,
    data2: i128,
    weight1: i128,
    weight2: i128,
) -> ClearingHouseResult<i128> {
    let denominator = weight1.checked_add(weight2).ok_or_else(math_error!())?;
    let prev_twap_99 = data1.checked_mul(weight1).ok_or_else(math_error!())?;
    let latest_price_01 = data2.checked_mul(weight2).ok_or_else(math_error!())?;

    prev_twap_99
        .checked_add(latest_price_01)
        .ok_or_else(math_error!())?
        .checked_div(denominator)
        .ok_or_else(math_error!())
}

pub fn update_amm_mark_std(
    amm: &mut AMM,
    now: i64,
    price_change: u128,
) -> ClearingHouseResult<bool> {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.last_mark_price_twap_ts)
            .ok_or_else(math_error!())?,
    ))?;

    amm.mark_std = calculate_rolling_sum(
        amm.mark_std,
        cast_to_u64(price_change)?,
        since_last,
        ONE_HOUR_I128,
    )?;

    Ok(true)
}

pub fn update_amm_long_short_intensity(
    amm: &mut AMM,
    now: i64,
    quote_asset_amount: u128,
    direction: PositionDirection,
) -> ClearingHouseResult<bool> {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.last_mark_price_twap_ts)
            .ok_or_else(math_error!())?,
    ))?;

    let (long_quote_amount, short_quote_amount) = if direction == PositionDirection::Long {
        (cast_to_u64(quote_asset_amount)?, 0_u64)
    } else {
        (0_u64, cast_to_u64(quote_asset_amount)?)
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

pub fn calculate_rolling_sum(
    data1: u64,
    data2: u64,
    weight1_numer: i128,
    weight1_denom: i128,
) -> ClearingHouseResult<u64> {
    // assumes that missing times are zeros (e.g. handle NaN as 0)

    let prev_twap_99 = data1
        .checked_mul(cast_to_u64(max(
            0,
            weight1_denom
                .checked_sub(weight1_numer)
                .ok_or_else(math_error!())?,
        ))?)
        .ok_or_else(math_error!())?
        .checked_div(cast_to_u64(weight1_denom)?)
        .ok_or_else(math_error!())?;

    prev_twap_99.checked_add(data2).ok_or_else(math_error!())
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
    let quote_asset_reserve_change = match swap_direction {
        SwapDirection::Add => quote_asset_reserve_before
            .checked_sub(quote_asset_reserve_after)
            .ok_or_else(math_error!())?,

        SwapDirection::Remove => quote_asset_reserve_after
            .checked_sub(quote_asset_reserve_before)
            .ok_or_else(math_error!())?,
    };

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

pub fn calculate_terminal_price_and_reserves(
    market: &Market,
) -> ClearingHouseResult<(u128, u128, u128)> {
    let swap_direction = if market.amm.net_base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (new_quote_asset_amount, new_base_asset_amount) = calculate_swap_output(
        market.amm.net_base_asset_amount.unsigned_abs(),
        market.amm.base_asset_reserve,
        swap_direction,
        market.amm.sqrt_k,
    )?;

    let terminal_price = calculate_price(
        new_quote_asset_amount,
        new_base_asset_amount,
        market.amm.peg_multiplier,
    )?;

    Ok((
        terminal_price,
        new_quote_asset_amount,
        new_base_asset_amount,
    ))
}

pub fn get_spread_reserves(
    amm: &AMM,
    direction: PositionDirection,
) -> ClearingHouseResult<(u128, u128)> {
    let (base_asset_reserve, quote_asset_reserve) = match direction {
        PositionDirection::Long => (amm.ask_base_asset_reserve, amm.ask_quote_asset_reserve),
        PositionDirection::Short => (amm.bid_base_asset_reserve, amm.bid_quote_asset_reserve),
    };

    Ok((base_asset_reserve, quote_asset_reserve))
}

pub fn calculate_spread_reserves(
    amm: &AMM,
    direction: PositionDirection,
) -> ClearingHouseResult<(u128, u128)> {
    let spread = match direction {
        PositionDirection::Long => amm.long_spread,
        PositionDirection::Short => amm.short_spread,
    };

    let quote_asset_reserve_delta = if spread > 0 {
        amm.quote_asset_reserve
            .checked_div(BID_ASK_SPREAD_PRECISION / (spread / 2))
            .ok_or_else(math_error!())?
    } else {
        0
    };

    let quote_asset_reserve = match direction {
        PositionDirection::Long => amm
            .quote_asset_reserve
            .checked_add(quote_asset_reserve_delta)
            .ok_or_else(math_error!())?,
        PositionDirection::Short => amm
            .quote_asset_reserve
            .checked_sub(quote_asset_reserve_delta)
            .ok_or_else(math_error!())?,
    };

    let invariant_sqrt_u192 = U192::from(amm.sqrt_k);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    let base_asset_reserve = invariant
        .checked_div(U192::from(quote_asset_reserve))
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    Ok((base_asset_reserve, quote_asset_reserve))
}

pub fn calculate_oracle_mark_spread(
    amm: &AMM,
    oracle_price_data: &OraclePriceData,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(i128, i128)> {
    let mark_price = match precomputed_mark_price {
        Some(mark_price) => cast_to_i128(mark_price)?,
        None => cast_to_i128(amm.mark_price()?)?,
    };

    let oracle_price = oracle_price_data.price;

    let price_spread = mark_price
        .checked_sub(oracle_price)
        .ok_or_else(math_error!())?;

    Ok((oracle_price, price_spread))
}

pub fn normalise_oracle_price(
    amm: &AMM,
    oracle_price: &OraclePriceData,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<i128> {
    let OraclePriceData {
        price: oracle_price,
        confidence: oracle_conf,
        ..
    } = *oracle_price;

    let mark_price = match precomputed_mark_price {
        Some(mark_price) => cast_to_i128(mark_price)?,
        None => cast_to_i128(amm.mark_price()?)?,
    };

    // 2.5 bps of the mark price
    let mark_price_2p5_bps = mark_price.checked_div(4000).ok_or_else(math_error!())?;
    let conf_int = cast_to_i128(oracle_conf)?;

    //  normalises oracle toward mark price based on the oracle’s confidence interval
    //  if mark above oracle: use oracle+conf unless it exceeds .99975 * mark price
    //  if mark below oracle: use oracle-conf unless it less than 1.00025 * mark price
    //  (this guarantees more reasonable funding rates in volatile periods)
    let normalised_price = if mark_price > oracle_price {
        min(
            max(
                mark_price
                    .checked_sub(mark_price_2p5_bps)
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
                mark_price
                    .checked_add(mark_price_2p5_bps)
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

pub fn calculate_oracle_mark_spread_pct(
    amm: &AMM,
    oracle_price_data: &OraclePriceData,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<i128> {
    let mark_price = match precomputed_mark_price {
        Some(mark_price) => (mark_price),
        None => (amm.mark_price()?),
    };
    let (_oracle_price, price_spread) =
        calculate_oracle_mark_spread(amm, oracle_price_data, Some(mark_price))?;

    price_spread
        .checked_mul(BID_ASK_SPREAD_PRECISION_I128)
        .ok_or_else(math_error!())?
        .checked_div(cast_to_i128(mark_price)?) // todo? better for spread logic
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

pub fn calculate_mark_twap_spread_pct(amm: &AMM, mark_price: u128) -> ClearingHouseResult<i128> {
    let mark_price = cast_to_i128(mark_price)?;
    let mark_twap = cast_to_i128(amm.last_mark_price_twap)?;

    let price_spread = mark_price
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

pub fn is_oracle_valid(
    amm: &AMM,
    oracle_price_data: &OraclePriceData,
    valid_oracle_guard_rails: &ValidityGuardRails,
) -> ClearingHouseResult<bool> {
    let OraclePriceData {
        price: oracle_price,
        confidence: oracle_conf,
        delay: oracle_delay,
        has_sufficient_number_of_data_points,
        ..
    } = *oracle_price_data;

    let is_oracle_price_nonpositive = oracle_price <= 0;

    let is_oracle_price_too_volatile = ((oracle_price
        .checked_div(max(1, amm.last_oracle_price_twap))
        .ok_or_else(math_error!())?)
    .gt(&valid_oracle_guard_rails.too_volatile_ratio))
        || ((amm
            .last_oracle_price_twap
            .checked_div(max(1, oracle_price))
            .ok_or_else(math_error!())?)
        .gt(&valid_oracle_guard_rails.too_volatile_ratio));

    let conf_denom_of_price = cast_to_u128(oracle_price)?
        .checked_div(max(1, oracle_conf))
        .ok_or_else(math_error!())?;
    let is_conf_too_large =
        conf_denom_of_price.lt(&valid_oracle_guard_rails.confidence_interval_max_size);

    let is_stale = oracle_delay.gt(&valid_oracle_guard_rails.slots_before_stale);

    Ok(!(is_stale
        || !has_sufficient_number_of_data_points
        || is_oracle_price_nonpositive
        || is_oracle_price_too_volatile
        || is_conf_too_large))
}

pub fn calculate_budgeted_k_scale(
    market: &mut Market,
    budget: i128,
    _mark_price: u128, // todo
) -> ClearingHouseResult<(u128, u128)> {
    let (numerator, denominator) = _calculate_budgeted_k_scale(
        market.amm.base_asset_reserve,
        market.amm.quote_asset_reserve,
        budget,
        market.amm.peg_multiplier,
        market.amm.net_base_asset_amount,
        market.amm.curve_update_intensity,
    )?;

    Ok((numerator, denominator))
}

pub fn _calculate_budgeted_k_scale(
    x: u128,
    y: u128,
    budget: i128,
    q: u128,
    d: i128,
    curve_update_intensity: u8,
) -> ClearingHouseResult<(u128, u128)> {
    let curve_update_intensity = curve_update_intensity as i128;
    let c = -budget;
    let q = cast_to_i128(q)?;

    let c_sign: i128 = if c > 0 { 1 } else { -1 };
    let d_sign: i128 = if d > 0 { 1 } else { -1 };

    let x_d = cast_to_i128(x)?.checked_add(d).ok_or_else(math_error!())?;

    let amm_reserve_precision_u192 = U192::from(AMM_RESERVE_PRECISION);
    let x_times_x_d_u192 = U192::from(x)
        .checked_mul(U192::from(x_d))
        .ok_or_else(math_error!())?
        .checked_div(amm_reserve_precision_u192)
        .ok_or_else(math_error!())?;

    let quote_precision_u192 = U192::from(QUOTE_PRECISION);
    let x_times_x_d_c = x_times_x_d_u192
        .checked_mul(U192::from(c.unsigned_abs()))
        .ok_or_else(math_error!())?
        .checked_div(quote_precision_u192)
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    let c_times_x_d_d = U192::from(c.unsigned_abs())
        .checked_mul(U192::from(x_d.unsigned_abs()))
        .ok_or_else(math_error!())?
        .checked_div(quote_precision_u192)
        .ok_or_else(math_error!())?
        .checked_mul(U192::from(d.unsigned_abs()))
        .ok_or_else(math_error!())?
        .checked_div(amm_reserve_precision_u192)
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    let pegged_quote_times_dd = cast_to_i128(
        U192::from(y)
            .checked_mul(U192::from(d.unsigned_abs()))
            .ok_or_else(math_error!())?
            .checked_div(amm_reserve_precision_u192)
            .ok_or_else(math_error!())?
            .checked_mul(U192::from(d.unsigned_abs()))
            .ok_or_else(math_error!())?
            .checked_div(amm_reserve_precision_u192)
            .ok_or_else(math_error!())?
            .checked_mul(U192::from(q))
            .ok_or_else(math_error!())?
            .checked_div(U192::from(PEG_PRECISION))
            .ok_or_else(math_error!())?
            .try_to_u128()?,
    )?;

    let numer1 = pegged_quote_times_dd;

    let numer2 = cast_to_i128(c_times_x_d_d)?
        .checked_mul(c_sign.checked_mul(d_sign).ok_or_else(math_error!())?)
        .ok_or_else(math_error!())?;

    let denom1 = cast_to_i128(x_times_x_d_c)?
        .checked_mul(c_sign)
        .ok_or_else(math_error!())?;

    let denom2 = pegged_quote_times_dd;

    // protocol is spending to increase k
    if c_sign < 0 {
        // thus denom1 is negative and solution is unstable
        if x_times_x_d_c > pegged_quote_times_dd.unsigned_abs() {
            msg!("cost exceeds possible amount to spend");
            let k_pct_upper_bound =
                K_BPS_UPDATE_SCALE + (K_BPS_INCREASE_MAX) * curve_update_intensity / 100;
            return Ok((
                cast_to_u128(k_pct_upper_bound)?,
                cast_to_u128(K_BPS_UPDATE_SCALE)?,
            ));
        }
    }

    let mut numerator = (numer1.checked_sub(numer2).ok_or_else(math_error!())?)
        .checked_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)
        .ok_or_else(math_error!())?;
    let mut denominator = denom1
        .checked_add(denom2)
        .ok_or_else(math_error!())?
        .checked_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)
        .ok_or_else(math_error!())?;

    if numerator < 0 && denominator < 0 {
        numerator = numerator.abs();
        denominator = denominator.abs();
    }
    assert!((numerator > 0 && denominator > 0));

    let (numerator, denominator) = if numerator > denominator {
        let k_pct_upper_bound =
            K_BPS_UPDATE_SCALE + (K_BPS_INCREASE_MAX) * curve_update_intensity / 100;

        let current_pct_change = numerator
            .checked_mul(10000)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?;

        let maximum_pct_change = k_pct_upper_bound
            .checked_mul(10000)
            .ok_or_else(math_error!())?
            .checked_div(K_BPS_UPDATE_SCALE)
            .ok_or_else(math_error!())?;

        if current_pct_change > maximum_pct_change {
            (k_pct_upper_bound, K_BPS_UPDATE_SCALE)
        } else {
            (numerator, denominator)
        }
    } else {
        let k_pct_lower_bound =
            K_BPS_UPDATE_SCALE - (K_BPS_DECREASE_MAX) * curve_update_intensity / 100;

        let current_pct_change = numerator
            .checked_mul(10000)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?;

        let maximum_pct_change = k_pct_lower_bound
            .checked_mul(10000)
            .ok_or_else(math_error!())?
            .checked_div(K_BPS_UPDATE_SCALE)
            .ok_or_else(math_error!())?;

        if current_pct_change < maximum_pct_change {
            (k_pct_lower_bound, K_BPS_UPDATE_SCALE)
        } else {
            (numerator, denominator)
        }
    };

    Ok((cast_to_u128(numerator)?, cast_to_u128(denominator)?))
}

/// To find the cost of adjusting k, compare the the net market value before and after adjusting k
/// Increasing k costs the protocol money because it reduces slippage and improves the exit price for net market position
/// Decreasing k costs the protocol money because it increases slippage and hurts the exit price for net market position
pub fn adjust_k_cost(
    market: &mut Market,
    update_k_result: &UpdateKResult,
) -> ClearingHouseResult<i128> {
    let mut market_clone = *market;

    // Find the net market value before adjusting k
    let (current_net_market_value, _) = _calculate_base_asset_value_and_pnl(
        market_clone.amm.net_base_asset_amount,
        0,
        &market_clone.amm,
        false,
    )?;

    update_k(&mut market_clone, update_k_result)?;

    let (_new_net_market_value, cost) = _calculate_base_asset_value_and_pnl(
        market_clone.amm.net_base_asset_amount,
        current_net_market_value,
        &market_clone.amm,
        false,
    )?;
    Ok(cost)
}

/// To find the cost of adjusting k, compare the the net market value before and after adjusting k
/// Increasing k costs the protocol money because it reduces slippage and improves the exit price for net market position
/// Decreasing k costs the protocol money because it increases slippage and hurts the exit price for net market position
pub fn adjust_k_cost_and_update(
    market: &mut Market,
    update_k_result: &UpdateKResult,
) -> ClearingHouseResult<i128> {
    // Find the net market value before adjusting k
    let current_net_market_value =
        calculate_base_asset_value(market.amm.net_base_asset_amount, &market.amm, false)?;

    update_k(market, update_k_result)?;

    let (_new_net_market_value, cost) = _calculate_base_asset_value_and_pnl(
        market.amm.net_base_asset_amount,
        current_net_market_value,
        &market.amm,
        false,
    )?;
    Ok(cost)
}

pub struct UpdateKResult {
    pub sqrt_k: u128,
    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
}

pub fn get_update_k_result(
    market: &Market,
    new_sqrt_k: bn::U192,
) -> ClearingHouseResult<UpdateKResult> {
    let sqrt_k_ratio_precision = bn::U192::from(100_000_000);

    let old_sqrt_k = bn::U192::from(market.amm.sqrt_k);
    let sqrt_k_ratio = new_sqrt_k
        .checked_mul(sqrt_k_ratio_precision)
        .ok_or_else(math_error!())?
        .checked_div(old_sqrt_k)
        .ok_or_else(math_error!())?;

    // if decreasing k, max decrease ratio for single transaction is 2.5%
    if sqrt_k_ratio < U192::from(97_500_000) {
        return Err(ErrorCode::InvalidUpdateK);
    }

    let sqrt_k = new_sqrt_k.try_to_u128().unwrap();

    if new_sqrt_k < old_sqrt_k
        && market.amm.net_base_asset_amount.unsigned_abs()
            > sqrt_k.checked_div(3).ok_or_else(math_error!())?
    {
        // todo, check less lp_tokens as well
        msg!("new_sqrt_k too small relative to market imbalance");
        return Err(ErrorCode::InvalidUpdateK);
    }

    let base_asset_reserve = bn::U192::from(market.amm.base_asset_reserve)
        .checked_mul(sqrt_k_ratio)
        .ok_or_else(math_error!())?
        .checked_div(sqrt_k_ratio_precision)
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    let invariant_sqrt_u192 = U192::from(sqrt_k);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    let quote_asset_reserve = invariant
        .checked_div(U192::from(base_asset_reserve))
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    Ok(UpdateKResult {
        sqrt_k,
        base_asset_reserve,
        quote_asset_reserve,
    })
}

pub fn update_k(market: &mut Market, update_k_result: &UpdateKResult) -> ClearingHouseResult {
    market.amm.sqrt_k = update_k_result.sqrt_k;
    market.amm.base_asset_reserve = update_k_result.base_asset_reserve;
    market.amm.quote_asset_reserve = update_k_result.quote_asset_reserve;

    let swap_direction = if market.amm.net_base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (new_terminal_quote_reserve, _new_terminal_base_reserve) = calculate_swap_output(
        market.amm.net_base_asset_amount.unsigned_abs(),
        market.amm.base_asset_reserve,
        swap_direction,
        market.amm.sqrt_k,
    )?;

    market.amm.terminal_quote_asset_reserve = new_terminal_quote_reserve;

    Ok(())
}

pub fn calculate_base_asset_amount_to_trade_to_price(
    amm: &AMM,
    limit_price: u128,
    direction: PositionDirection,
) -> ClearingHouseResult<(u128, PositionDirection)> {
    let invariant_sqrt_u192 = U192::from(amm.sqrt_k);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    let new_base_asset_reserve_squared = invariant
        .checked_mul(U192::from(MARK_PRICE_PRECISION))
        .ok_or_else(math_error!())?
        .checked_div(U192::from(limit_price))
        .ok_or_else(math_error!())?
        .checked_mul(U192::from(amm.peg_multiplier))
        .ok_or_else(math_error!())?
        .checked_div(U192::from(PEG_PRECISION))
        .ok_or_else(math_error!())?;

    let new_base_asset_reserve = new_base_asset_reserve_squared
        .integer_sqrt()
        .try_to_u128()?;

    let base_asset_reserve_before = if amm.base_spread > 0 {
        let (spread_base_asset_reserve, _) = get_spread_reserves(amm, direction)?;
        spread_base_asset_reserve
    } else {
        amm.base_asset_reserve
    };

    if new_base_asset_reserve > base_asset_reserve_before {
        let max_trade_amount = new_base_asset_reserve
            .checked_sub(base_asset_reserve_before)
            .ok_or_else(math_error!())?;
        Ok((max_trade_amount, PositionDirection::Short))
    } else {
        let max_trade_amount = base_asset_reserve_before
            .checked_sub(new_base_asset_reserve)
            .ok_or_else(math_error!())?;
        Ok((max_trade_amount, PositionDirection::Long))
    }
}

pub fn calculate_max_base_asset_amount_fillable(amm: &AMM) -> ClearingHouseResult<u128> {
    standardize_base_asset_amount(
        amm.base_asset_reserve / amm.max_base_asset_amount_ratio as u128,
        amm.base_asset_amount_step_size,
    )
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::constants::MARK_PRICE_PRECISION;

    #[test]
    fn calculate_spread_tests() {
        let base_spread = 1000; // .1%
        let mut last_oracle_mark_spread_pct = 0;
        let mut last_oracle_conf_pct = 0;
        let quote_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let mut terminal_quote_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let peg_multiplier = 34000;
        let mut net_base_asset_amount = 0;
        let mark_price = 345623040000;
        let mut total_fee_minus_distributions = 0;

        let margin_ratio_initial = 2000; // 5x max leverage
        let max_spread = margin_ratio_initial * 100;
        // at 0 fee be max spread
        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_mark_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            net_base_asset_amount,
            mark_price,
            total_fee_minus_distributions,
        )
        .unwrap();
        assert_eq!(long_spread1, (base_spread * 5 / 2) as u128);
        assert_eq!(short_spread1, (base_spread * 5 / 2) as u128);

        // even at imbalance with 0 fee, be max spread
        terminal_quote_asset_reserve -= AMM_RESERVE_PRECISION;
        net_base_asset_amount += AMM_RESERVE_PRECISION as i128;
        let (long_spread2, short_spread2) = calculate_spread(
            base_spread,
            last_oracle_mark_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            net_base_asset_amount,
            mark_price,
            total_fee_minus_distributions,
        )
        .unwrap();
        assert_eq!(long_spread2, (base_spread * 5 / 2) as u128);
        assert_eq!(short_spread2, (base_spread * 5 / 2) as u128);

        // oracle retreat * skew that increases long spread
        last_oracle_mark_spread_pct = BID_ASK_SPREAD_PRECISION_I128 / 20; //5%
        last_oracle_conf_pct = (BID_ASK_SPREAD_PRECISION / 100) as u64; //1%
        total_fee_minus_distributions = QUOTE_PRECISION as i128;
        let (long_spread3, short_spread3) = calculate_spread(
            base_spread,
            last_oracle_mark_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            net_base_asset_amount,
            mark_price,
            total_fee_minus_distributions,
        )
        .unwrap();
        assert!(short_spread3 > long_spread3);

        // 1000/2 * (1+(34562000-34000000)/QUOTE_PRECISION) -> 781
        assert_eq!(long_spread3, 781);

        // last_oracle_mark_spread_pct + conf retreat
        // assert_eq!(short_spread3, 1010000);
        assert_eq!(short_spread3, 60000); // hitting max spread

        last_oracle_mark_spread_pct = -BID_ASK_SPREAD_PRECISION_I128 / 777;
        last_oracle_conf_pct = 1;
        let (long_spread4, short_spread4) = calculate_spread(
            base_spread,
            last_oracle_mark_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            net_base_asset_amount,
            mark_price,
            total_fee_minus_distributions,
        )
        .unwrap();
        assert!(short_spread4 < long_spread4);
        // (1000000/777 + 1 )* 1.562 -> 2011
        assert_eq!(long_spread4, 2011);
        // base_spread
        assert_eq!(short_spread4, 500);

        // increases to fee pool will decrease long spread (all else equal)
        let (long_spread5, short_spread5) = calculate_spread(
            base_spread,
            last_oracle_mark_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            net_base_asset_amount,
            mark_price,
            total_fee_minus_distributions * 2,
        )
        .unwrap();

        assert!(long_spread5 < long_spread4);
        assert_eq!(short_spread5, short_spread4);

        let amm = AMM {
            base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            sqrt_k: 2 * AMM_RESERVE_PRECISION,
            peg_multiplier: PEG_PRECISION,
            long_spread: long_spread5,
            short_spread: short_spread5,
            ..AMM::default()
        };

        let (bar_l, qar_l) = calculate_spread_reserves(&amm, PositionDirection::Long).unwrap();
        let (bar_s, qar_s) = calculate_spread_reserves(&amm, PositionDirection::Short).unwrap();

        assert!(qar_l > amm.quote_asset_reserve);
        assert!(bar_l < amm.base_asset_reserve);
        assert!(qar_s < amm.quote_asset_reserve);
        assert!(bar_s > amm.base_asset_reserve);
        assert_eq!(bar_s, 20005001250312);
        assert_eq!(bar_l, 19983525535420);
        assert_eq!(qar_l, 20016488046166);
        assert_eq!(qar_s, 19995000000000);

        let (long_spread_btc, short_spread_btc) = calculate_spread(
            500,
            62099,
            411,
            margin_ratio_initial * 100,
            942800306955655,
            944728468434773,
            21966868,
            -1931600000000,
            219277638717000,
            50457675,
        )
        .unwrap();

        assert_eq!(long_spread_btc, 500 / 2);
        assert_eq!(short_spread_btc, 62510);

        let (long_spread_btc1, short_spread_btc1) = calculate_spread(
            500,
            70719,
            0,
            margin_ratio_initial * 100,
            921137624214280,
            923064882199510,
            21754071,
            -1930600000000,
            216710715732581,
            4876326,
        )
        .unwrap();

        assert_eq!(long_spread_btc1, 500 / 2);
        // assert_eq!(short_spread_btc1, 197670);
        assert_eq!(short_spread_btc1, 197670); // max spread
    }

    #[test]
    fn calc_mark_std_tests() {
        let prev = 1656682258;
        let now = prev + 3600;
        let mut amm = AMM {
            // base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            mark_std: MARK_PRICE_PRECISION as u64,
            last_mark_price_twap_ts: prev,
            ..AMM::default()
        };
        update_amm_mark_std(&mut amm, now, MARK_PRICE_PRECISION * 23).unwrap();
        assert_eq!(amm.mark_std, (MARK_PRICE_PRECISION * 23) as u64);

        amm.mark_std = MARK_PRICE_PRECISION as u64;
        amm.last_mark_price_twap_ts = now - 60;
        update_amm_mark_std(&mut amm, now, MARK_PRICE_PRECISION * 2).unwrap();
    }

    #[test]
    fn update_mark_twap_tests() {
        let prev = 0;

        let mut now = 1;

        let mut oracle_price_data = OraclePriceData {
            price: 400212800000,
            confidence: MARK_PRICE_PRECISION / 100,
            delay: 1,
            has_sufficient_number_of_data_points: true,
        };

        // $40 everything init
        let mut amm = AMM {
            quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            peg_multiplier: 40_000,

            last_oracle_price_twap: (40 * MARK_PRICE_PRECISION) as i128,
            last_mark_price_twap: (40 * MARK_PRICE_PRECISION),
            last_bid_price_twap: (40 * MARK_PRICE_PRECISION),
            last_ask_price_twap: (40 * MARK_PRICE_PRECISION),
            last_mark_price_twap_ts: prev,
            last_oracle_price_twap_ts: prev,
            funding_period: 3600,
            last_oracle_price: (40 * MARK_PRICE_PRECISION) as i128,
            ..AMM::default()
        };

        update_oracle_price_twap(&mut amm, now, &oracle_price_data, None).unwrap();
        assert_eq!(amm.last_oracle_price, oracle_price_data.price);
        assert_eq!(amm.last_oracle_price, 400212800000);

        let trade_price = 400512800000;
        let trade_direction = PositionDirection::Long;

        let old_mark_twap = amm.last_mark_price_twap;
        let new_mark_twap =
            update_mark_twap(&mut amm, now, Some(trade_price), Some(trade_direction)).unwrap();
        let new_bid_twap = amm.last_bid_price_twap;
        let new_ask_twap = amm.last_ask_price_twap;

        assert!(new_mark_twap > old_mark_twap);
        assert!(new_bid_twap < new_ask_twap);
        assert_eq!(new_bid_twap, 400000059111);
        assert_eq!(new_mark_twap, 400000100777);
        assert_eq!(new_ask_twap, 400000142444);

        while now < 3600 {
            now += 1;
            update_oracle_price_twap(&mut amm, now, &oracle_price_data, None).unwrap();
            update_mark_twap(&mut amm, now, Some(trade_price), Some(trade_direction)).unwrap();
        }

        let new_oracle_twap = amm.last_oracle_price_twap;
        let new_mark_twap = amm.last_mark_price_twap;
        let new_bid_twap = amm.last_bid_price_twap;
        let new_ask_twap = amm.last_ask_price_twap;

        assert!(new_bid_twap < new_ask_twap);
        assert_eq!((new_bid_twap + new_ask_twap) / 2, new_mark_twap);
        assert!((new_oracle_twap as u128) < new_mark_twap); // funding in favor of maker?
        assert_eq!(new_oracle_twap, 400071307837);
        assert_eq!(new_bid_twap, 400134525005);
        assert_eq!(new_mark_twap, 400229350757); // < 2 cents above oracle twap
        assert_eq!(new_ask_twap, 400324176509);

        let trade_price_2 = 399712800200;
        let trade_direction_2 = PositionDirection::Short;
        oracle_price_data = OraclePriceData {
            price: 399912800200,
            confidence: MARK_PRICE_PRECISION / 80,
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

        let new_oracle_twap = amm.last_oracle_price_twap;
        let new_mark_twap = amm.last_mark_price_twap;
        let new_bid_twap = amm.last_bid_price_twap;
        let new_ask_twap = amm.last_ask_price_twap;

        assert!(new_bid_twap < new_ask_twap);
        assert_eq!((new_bid_twap + new_ask_twap) / 2, new_mark_twap);
        assert!((new_oracle_twap as u128) > new_mark_twap); // funding in favor of maker
        assert_eq!(new_oracle_twap, 399971086480);
        assert_eq!(new_bid_twap, 399863531908); // ema from prev twap
        assert_eq!(new_ask_twap, 400059833178); // ema from prev twap
    }

    #[test]
    fn calc_oracle_twap_tests() {
        let prev = 1656682258;
        let now = prev + 3600;

        let px = 32 * MARK_PRICE_PRECISION;

        let mut amm = AMM {
            base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            peg_multiplier: PEG_PRECISION,
            last_oracle_price_twap: px as i128,
            last_oracle_price_twap_ts: prev,
            mark_std: MARK_PRICE_PRECISION as u64,
            last_mark_price_twap_ts: prev,
            funding_period: 3600_i64,
            ..AMM::default()
        };
        let mut oracle_price_data = OraclePriceData {
            price: (34 * MARK_PRICE_PRECISION) as i128,
            confidence: MARK_PRICE_PRECISION / 100,
            delay: 1,
            has_sufficient_number_of_data_points: true,
        };

        let _new_oracle_twap =
            update_oracle_price_twap(&mut amm, now, &oracle_price_data, None).unwrap();
        assert_eq!(
            amm.last_oracle_price_twap,
            (34 * MARK_PRICE_PRECISION - MARK_PRICE_PRECISION / 100) as i128
        );

        // let after_ts = amm.last_oracle_price_twap_ts;
        amm.last_mark_price_twap_ts = now - 60;
        amm.last_oracle_price_twap_ts = now - 60;
        // let after_ts_2 = amm.last_oracle_price_twap_ts;
        oracle_price_data = OraclePriceData {
            price: (31 * MARK_PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };
        // let old_oracle_twap_2 = amm.last_oracle_price_twap;
        let _new_oracle_twap_2 =
            update_oracle_price_twap(&mut amm, now, &oracle_price_data, None).unwrap();
        assert_eq!(amm.last_oracle_price_twap, 339401666666);
    }

    #[test]
    fn calculate_k_tests() {
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 5122950819670000,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000,
                net_base_asset_amount: -122950819670000,
                ..AMM::default()
            },
            ..Market::default()
        };
        // increase k by .25%
        let update_k_up =
            get_update_k_result(&market, bn::U192::from(501 * AMM_RESERVE_PRECISION)).unwrap();
        let (t_price, t_qar, t_bar) = calculate_terminal_price_and_reserves(&market).unwrap();

        // new terminal reserves are balanced, terminal price = peg)
        assert_eq!(t_qar, 500 * AMM_RESERVE_PRECISION);
        assert_eq!(t_bar, 500 * AMM_RESERVE_PRECISION);
        assert_eq!(t_price, market.amm.peg_multiplier * 10000000);

        assert_eq!(update_k_up.sqrt_k, 501 * AMM_RESERVE_PRECISION);
        assert_eq!(update_k_up.base_asset_reserve, 5133196721309340);
        assert_eq!(update_k_up.quote_asset_reserve, 4889760000002034);

        // cost to increase k is always positive when imbalanced
        let cost = adjust_k_cost_and_update(&mut market, &update_k_up).unwrap();
        assert_eq!(market.amm.terminal_quote_asset_reserve, 5009754110429452);
        assert!(cost > 0);
        assert_eq!(cost, 29448);

        let (t_price2, t_qar2, t_bar2) = calculate_terminal_price_and_reserves(&market).unwrap();
        // since users are net short, new terminal price lower after increasing k
        assert!(t_price2 < t_price);
        // new terminal reserves are unbalanced with quote below base (lower terminal price)
        assert_eq!(t_bar2, 5010245901639340);
        assert_eq!(t_qar2, 5009754110429452);

        // with positive budget, how much can k be increased?
        let (numer1, denom1) = _calculate_budgeted_k_scale(
            AMM_RESERVE_PRECISION * 55414,
            AMM_RESERVE_PRECISION * 55530,
            (QUOTE_PRECISION / 500) as i128, // positive budget
            36365,
            (AMM_RESERVE_PRECISION * 66) as i128,
            100,
        )
        .unwrap();

        assert!(numer1 > denom1);
        assert_eq!(numer1, 8796289171560000);
        assert_eq!(denom1, 8790133110760000);

        let mut pct_change_in_k = (numer1 * 10000) / denom1;
        assert_eq!(pct_change_in_k, 10007); // k was increased .07%

        // with negative budget, how much should k be lowered?
        let (numer1, denom1) = _calculate_budgeted_k_scale(
            AMM_RESERVE_PRECISION * 55414,
            AMM_RESERVE_PRECISION * 55530,
            -((QUOTE_PRECISION / 50) as i128),
            36365,
            (AMM_RESERVE_PRECISION * 66) as i128,
            100,
        )
        .unwrap();
        assert!(numer1 < denom1);
        pct_change_in_k = (numer1 * 1000000) / denom1;
        assert_eq!(pct_change_in_k, 993050); // k was decreased 0.695%

        // show non-linearity with budget
        let (numer1, denom1) = _calculate_budgeted_k_scale(
            AMM_RESERVE_PRECISION * 55414,
            AMM_RESERVE_PRECISION * 55530,
            -((QUOTE_PRECISION / 25) as i128),
            36365,
            (AMM_RESERVE_PRECISION * 66) as i128,
            100,
        )
        .unwrap();
        assert!(numer1 < denom1);
        pct_change_in_k = (numer1 * 1000000) / denom1;
        assert_eq!(pct_change_in_k, 986196); // k was decreased 1.3804%

        // todo:
        let (numer1, denom1) = _calculate_budgeted_k_scale(
            500000000049750000004950,
            499999999950250000000000,
            114638,
            40000,
            49750000004950,
            100,
        )
        .unwrap();

        assert!(numer1 > denom1);
        assert_eq!(numer1, 1001000);
        assert_eq!(denom1, 1000000);

        // todo:
        let (numer1, denom1) = _calculate_budgeted_k_scale(
            500000000049750000004950,
            499999999950250000000000,
            -114638,
            40000,
            49750000004950,
            100,
        )
        .unwrap();

        assert!(numer1 < denom1);
        assert_eq!(numer1, 978000); // 2.2% decrease
        assert_eq!(denom1, 1000000);
    }
}
