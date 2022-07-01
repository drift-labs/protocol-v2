use std::cmp::{max, min};

use solana_program::msg;

use crate::controller::amm::SwapDirection;
use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::bn;
use crate::math::bn::U192;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128, cast_to_u64};
use crate::math::constants::{
    BID_ASK_SPREAD_PRECISION, BID_ASK_SPREAD_PRECISION_I128, K_BPS_DECREASE_MAX,
    K_BPS_INCREASE_MAX, K_BPS_UPDATE_SCALE, MARK_PRICE_PRECISION,
    MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128, ONE_HOUR_I128, PEG_PRECISION,
    PRICE_TO_PEG_PRECISION_RATIO,
};
use crate::math::position::{_calculate_base_asset_value, _calculate_base_asset_value_and_pnl};
use crate::math::quote_asset::{asset_to_reserve_amount, reserve_to_asset_amount};
use crate::math_error;
use crate::state::market::{Market, AMM};
use crate::state::oracle::OraclePriceData;
use crate::state::state::{PriceDivergenceGuardRails, ValidityGuardRails};

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

pub fn update_mark_twap(
    amm: &mut AMM,
    now: i64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<u128> {
    let mark_price = match precomputed_mark_price {
        Some(mark_price) => mark_price,
        None => amm.mark_price()?,
    };
    let (bid_price, ask_price) = amm.bid_ask_price(mark_price)?;

    let mark_twap = calculate_new_twap(amm, now, mark_price, amm.last_mark_price_twap)?;
    amm.last_mark_price_twap = mark_twap;

    // todo calculate the mark +/- spread
    let bid_twap = calculate_new_twap(amm, now, bid_price, amm.last_bid_price_twap)?;
    amm.last_bid_price_twap = bid_twap;

    let ask_twap = calculate_new_twap(amm, now, ask_price, amm.last_ask_price_twap)?;
    amm.last_ask_price_twap = ask_twap;

    amm.last_mark_price_twap_ts = now;

    let mid_twap = bid_twap.checked_add(ask_twap).ok_or_else(math_error!())? / 2;

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

    let new_oracle_price_spread = oracle_price
        .checked_sub(amm.last_oracle_price_twap)
        .ok_or_else(math_error!())?;

    // cap new oracle update to 33% delta from twap
    let oracle_price_33pct = oracle_price.checked_div(3).ok_or_else(math_error!())?;

    let capped_oracle_update_price =
        if new_oracle_price_spread.unsigned_abs() > oracle_price_33pct.unsigned_abs() {
            if oracle_price > amm.last_oracle_price_twap {
                amm.last_oracle_price_twap
                    .checked_add(oracle_price_33pct)
                    .ok_or_else(math_error!())?
            } else {
                amm.last_oracle_price_twap
                    .checked_sub(oracle_price_33pct)
                    .ok_or_else(math_error!())?
            }
        } else {
            oracle_price
        };

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
        1,
        cast_to_i128(amm.funding_period)?
            .checked_sub(since_last)
            .ok_or_else(math_error!())?,
    );

    // ensure amm.last_oracle_price is proper
    let capped_last_oracle_price = if amm.last_oracle_price > 0 {
        amm.last_oracle_price
    } else {
        oracle_price
    };

    // nudge last_oracle_price up to .1% toward oracle price
    let capped_last_oracle_price_10bp = capped_last_oracle_price
        .checked_div(1000)
        .ok_or_else(math_error!())?;

    let mut interpolated_oracle_price = min(
        capped_last_oracle_price
            .checked_add(capped_last_oracle_price_10bp)
            .ok_or_else(math_error!())?,
        max(
            capped_last_oracle_price
                .checked_sub(capped_last_oracle_price_10bp)
                .ok_or_else(math_error!())?,
            oracle_price,
        ),
    );

    // if an oracle delay impacted last oracle_twap, shrink toward mark_twap
    interpolated_oracle_price = if amm.last_mark_price_twap_ts > amm.last_oracle_price_twap_ts {
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
            interpolated_oracle_price,
            since_last_valid,
            from_start_valid,
        )?
    } else {
        interpolated_oracle_price
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
    input_asset_amount: u128,
    direction: SwapDirection,
    invariant_sqrt: u128,
) -> ClearingHouseResult<(u128, u128)> {
    let invariant_sqrt_u192 = U192::from(invariant_sqrt);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    if direction == SwapDirection::Remove && swap_amount > input_asset_amount {
        return Err(ErrorCode::TradeSizeTooLarge);
    }

    let new_input_amount = if let SwapDirection::Add = direction {
        input_asset_amount
            .checked_add(swap_amount)
            .ok_or_else(math_error!())?
    } else {
        input_asset_amount
            .checked_sub(swap_amount)
            .ok_or_else(math_error!())?
    };

    let new_input_amount_u192 = U192::from(new_input_amount);
    let new_output_amount = invariant
        .checked_div(new_input_amount_u192)
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    Ok((new_output_amount, new_input_amount))
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
    mark_price: u128,
) -> ClearingHouseResult<(u128, u128)> {
    // 0 - 100
    let curve_update_intensity = cast_to_i128(min(market.amm.curve_update_intensity, 100_u8))?;

    if curve_update_intensity == 0 {
        return Ok((1, 1));
    }

    let mark_div_budget = cast_to_i128(mark_price)?
        .checked_div(budget)
        .ok_or_else(math_error!())?;

    let net_position = market.amm.net_base_asset_amount;
    let one_div_net_position = MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128
        .checked_div(net_position)
        .ok_or_else(math_error!())?;
    let base_asset_reserve = cast_to_i128(market.amm.base_asset_reserve)?;

    let mut numerator = mark_div_budget
        .checked_add(one_div_net_position)
        .ok_or_else(math_error!())?
        .checked_add(
            MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128
                .checked_div(base_asset_reserve)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    let mut denominator = mark_div_budget
        .checked_sub(one_div_net_position)
        .ok_or_else(math_error!())?
        .checked_sub(
            base_asset_reserve
                .checked_mul(one_div_net_position)
                .ok_or_else(math_error!())?
                .checked_div(net_position)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    if numerator < 0 && denominator < 0 {
        numerator = numerator.abs();
        denominator = denominator.abs();
    }

    assert!((numerator > 0 && denominator > 0));

    // assert!(budget >= 0);

    // assert!(numerator <= denominator);

    let (numerator, denominator) = if numerator > denominator {
        let k_pct_upper_bound =
            K_BPS_UPDATE_SCALE + (K_BPS_INCREASE_MAX) * curve_update_intensity / 100;

        let current_pct_change = numerator
            .checked_mul(1000)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?;

        let maximum_pct_change = k_pct_upper_bound
            .checked_mul(1000)
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
            .checked_mul(1000)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?;

        let maximum_pct_change = k_pct_lower_bound
            .checked_mul(1000)
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
        _calculate_base_asset_value(market.amm.net_base_asset_amount, &market.amm, false)?;

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

pub fn calculate_max_base_asset_amount_to_trade(
    amm: &AMM,
    limit_price: u128,
    direction: PositionDirection,
    use_spread: bool,
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

    let base_asset_reserve_before = if use_spread && amm.base_spread > 0 {
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

pub fn should_round_trade(
    amm: &AMM,
    quote_asset_amount: u128,
    base_asset_value: u128,
) -> ClearingHouseResult<bool> {
    let difference = if quote_asset_amount > base_asset_value {
        quote_asset_amount
            .checked_sub(base_asset_value)
            .ok_or_else(math_error!())?
    } else {
        base_asset_value
            .checked_sub(quote_asset_amount)
            .ok_or_else(math_error!())?
    };

    let quote_asset_reserve_amount = asset_to_reserve_amount(difference, amm.peg_multiplier)?;

    Ok(quote_asset_reserve_amount < amm.minimum_quote_asset_trade_size)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::constants::{AMM_RESERVE_PRECISION, MARK_PRICE_PRECISION, QUOTE_PRECISION};

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
        let old_mark_std = amm.mark_std;
        update_amm_mark_std(&mut amm, now, MARK_PRICE_PRECISION * 23);
        assert_eq!(amm.mark_std, (MARK_PRICE_PRECISION * 23) as u64);

        amm.mark_std = MARK_PRICE_PRECISION as u64;
        amm.last_mark_price_twap_ts = now - 60;
        update_amm_mark_std(&mut amm, now, MARK_PRICE_PRECISION * 2);

        //     let expected_out = (MARK_PRICE_PRECISION*2/3600 + (MARK_PRICE_PRECISION - MARK_PRICE_PRECISION/3600)
        // ) as u64;
        //     assert_eq!(amm.mark_std, expected_out);
    }
}
