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
    MARK_PRICE_PRECISION_I128, MAX_BID_ASK_INVENTORY_SKEW_FACTOR, ONE_HOUR_I128, PEG_PRECISION,
    PRICE_TO_PEG_PRECISION_RATIO, QUOTE_PRECISION,
};
use crate::math::orders::standardize_base_asset_amount;
use crate::math::position::{_calculate_base_asset_value_and_pnl, calculate_base_asset_value};
use crate::math::quote_asset::reserve_to_asset_amount;
use crate::math_error;
use crate::state::market::{Market, AMM};
use crate::state::oracle::OraclePriceData;
use crate::state::state::{PriceDivergenceGuardRails, ValidityGuardRails};
use crate::validate;
use solana_program::msg;
use std::cmp::{max, min};

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

pub fn calculate_bid_ask_bounds(sqrt_k: u128) -> ClearingHouseResult<(u128, u128)> {
    let sqrt_2_precision = 10_000_u128;
    let sqrt_2 = 14_142;

    // worse case if all asks are filled (max reserve)
    let ask_bounded_base = sqrt_k
        .checked_mul(sqrt_2)
        .ok_or_else(math_error!())?
        .checked_div(sqrt_2_precision)
        .ok_or_else(math_error!())?;

    // worse case if all bids are filled (min reserve)
    let bid_bounded_base = sqrt_k
        .checked_mul(sqrt_2_precision)
        .ok_or_else(math_error!())?
        .checked_div(sqrt_2)
        .ok_or_else(math_error!())?;

    Ok((bid_bounded_base, ask_bounded_base))
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

pub fn cap_to_max_spread(
    mut long_spread: u128,
    mut short_spread: u128,
    max_spread: u128,
) -> ClearingHouseResult<(u128, u128)> {
    let total_spread = long_spread
        .checked_add(short_spread)
        .ok_or_else(math_error!())?;

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

    let new_total_spread = long_spread
        .checked_add(short_spread)
        .ok_or_else(math_error!())?;

    validate!(
        new_total_spread <= max_spread,
        ErrorCode::DefaultError,
        "new_total_spread({}) > max_spread({})",
        new_total_spread,
        max_spread
    )?;

    Ok((long_spread, short_spread))
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
    base_asset_reserve: u128,
    min_base_asset_reserve: u128,
    max_base_asset_reserve: u128,
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
    let (max_bids, max_asks) = _calculate_market_open_bids_asks(
        base_asset_reserve,
        min_base_asset_reserve,
        max_base_asset_reserve,
    )?;

    let total_liquidity = max_bids
        .checked_add(max_asks.abs())
        .ok_or_else(math_error!())?;

    // inventory scale
    let inventory_scale = net_base_asset_amount
        .checked_mul(BID_ASK_SPREAD_PRECISION_I128 * 5)
        .ok_or_else(math_error!())?
        .checked_div(total_liquidity.max(1))
        .ok_or_else(math_error!())?
        .unsigned_abs();

    let inventory_scale_capped = min(
        MAX_BID_ASK_INVENTORY_SKEW_FACTOR,
        BID_ASK_SPREAD_PRECISION
            .checked_add(inventory_scale)
            .ok_or_else(math_error!())?,
    );

    if net_base_asset_amount > 0 {
        long_spread = long_spread
            .checked_mul(inventory_scale_capped)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;
    } else if net_base_asset_amount < 0 {
        short_spread = short_spread
            .checked_mul(inventory_scale_capped)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;
    }

    // effective leverage scale
    let net_base_asset_value = cast_to_i128(quote_asset_reserve)?
        .checked_sub(cast_to_i128(terminal_quote_asset_reserve)?)
        .ok_or_else(math_error!())?
        .checked_mul(cast_to_i128(peg_multiplier)?)
        .ok_or_else(math_error!())?
        .checked_div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO_I128)
        .ok_or_else(math_error!())?;

    let local_base_asset_value = net_base_asset_amount
        .checked_mul(cast_to_i128(mark_price)?)
        .ok_or_else(math_error!())?
        .checked_div(AMM_TO_QUOTE_PRECISION_RATIO_I128 * MARK_PRICE_PRECISION_I128)
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
    let (long_spread, short_spread) =
        cap_to_max_spread(long_spread, short_spread, cast_to_u128(max_spread)?)?;

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

    validate!(
        amm.last_oracle_price > 0,
        ErrorCode::InvalidOracle,
        "amm.last_oracle_price <= 0"
    )?;

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
    let bid_twap = calculate_new_twap(
        amm,
        now,
        bid_price,
        amm.last_bid_price_twap,
        amm.funding_period,
    )?;
    amm.last_bid_price_twap = bid_twap;

    let ask_twap = calculate_new_twap(
        amm,
        now,
        ask_price,
        amm.last_ask_price_twap,
        amm.funding_period,
    )?;

    amm.last_ask_price_twap = ask_twap;

    let mid_twap = bid_twap.checked_add(ask_twap).ok_or_else(math_error!())? / 2;

    // update std stat
    update_amm_mark_std(amm, now, trade_price, amm.last_mark_price_twap)?;

    amm.last_mark_price_twap = mid_twap;
    amm.last_mark_price_twap_5min = calculate_new_twap(
        amm,
        now,
        bid_price.checked_add(ask_price).ok_or_else(math_error!())? / 2,
        amm.last_mark_price_twap_5min,
        60 * 5,
    )?;

    amm.last_mark_price_twap_ts = now;

    Ok(mid_twap)
}

pub fn calculate_new_twap(
    amm: &AMM,
    now: i64,
    current_price: u128,
    last_twap: u128,
    period: i64,
) -> ClearingHouseResult<u128> {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.last_mark_price_twap_ts)
            .ok_or_else(math_error!())?,
    ))?;
    let from_start = max(
        1,
        cast_to_i128(period)?
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

        amm.last_oracle_price_twap_5min = oracle_price_twap_5min;
        amm.last_oracle_price_twap = oracle_price_twap;
        amm.last_oracle_price_twap_ts = now;
    } else {
        oracle_price_twap = amm.last_oracle_price_twap
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
        TwapPeriod::FundingPeriod => (amm.last_mark_price_twap, amm.last_oracle_price_twap),
        TwapPeriod::FiveMin => (
            amm.last_mark_price_twap_5min,
            amm.last_oracle_price_twap_5min,
        ),
    };

    let period: i64 = match twap_period {
        TwapPeriod::FundingPeriod => amm.funding_period,
        TwapPeriod::FiveMin => 60 * 5,
    };

    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.last_oracle_price_twap_ts)
            .ok_or_else(math_error!())?,
    ))?;
    let from_start = max(
        0,
        cast_to_i128(period)?
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
    let prev_twap_99 = cast_to_u128(data1)?
        .checked_mul(cast_to_u128(max(
            0,
            weight1_denom
                .checked_sub(weight1_numer)
                .ok_or_else(math_error!())?,
        ))?)
        .ok_or_else(math_error!())?
        .checked_div(cast_to_u128(weight1_denom)?)
        .ok_or_else(math_error!())?;

    cast_to_u64(prev_twap_99)?
        .checked_add(data2)
        .ok_or_else(math_error!())
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

pub fn calculate_terminal_price_and_reserves(amm: &AMM) -> ClearingHouseResult<(u128, u128, u128)> {
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
        Some(mark_price) => mark_price,
        None => amm.mark_price()?,
    };
    let (_oracle_price, price_spread) =
        calculate_oracle_mark_spread(amm, oracle_price_data, Some(mark_price))?;

    price_spread
        .checked_mul(BID_ASK_SPREAD_PRECISION_I128)
        .ok_or_else(math_error!())?
        .checked_div(cast_to_i128(mark_price)?) // todo? better for spread logic
        .ok_or_else(math_error!())
}

pub fn calculate_oracle_twap_5min_mark_spread_pct(
    amm: &AMM,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<i128> {
    let mark_price = match precomputed_mark_price {
        Some(mark_price) => mark_price,
        None => amm.mark_price()?,
    };
    let price_spread = cast_to_i128(mark_price)?
        .checked_sub(amm.last_oracle_price_twap_5min)
        .ok_or_else(math_error!())?;

    // price_spread_pct
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
    if is_oracle_price_nonpositive {
        msg!("Invalid Oracle: Non-positive (oracle_price <=0)");
    }

    let is_oracle_price_too_volatile = ((oracle_price
        .checked_div(max(1, amm.last_oracle_price_twap))
        .ok_or_else(math_error!())?)
    .gt(&valid_oracle_guard_rails.too_volatile_ratio))
        || ((amm
            .last_oracle_price_twap
            .checked_div(max(1, oracle_price))
            .ok_or_else(math_error!())?)
        .gt(&valid_oracle_guard_rails.too_volatile_ratio));
    if is_oracle_price_too_volatile {
        msg!("Invalid Oracle: Too Volatile (last_oracle_price_twap vs oracle_price)");
    }

    let conf_pct_of_price = cast_to_u128(amm.base_spread)?
        .checked_add(max(1, oracle_conf))
        .ok_or_else(math_error!())?
        .checked_mul(BID_ASK_SPREAD_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(cast_to_u128(oracle_price)?)
        .ok_or_else(math_error!())?;

    let max_conf = max(
        cast_to_u128(amm.max_spread)?,
        valid_oracle_guard_rails.confidence_interval_max_size,
    );
    let is_conf_too_large = conf_pct_of_price.gt(&max_conf);
    if is_conf_too_large {
        msg!(
            "Invalid Oracle: Confidence Too Large (is_conf_too_large={:?})",
            conf_pct_of_price
        );
    }
    let is_stale = oracle_delay.gt(&valid_oracle_guard_rails.slots_before_stale);
    if is_stale {
        msg!("Invalid Oracle: Stale (oracle_delay={:?})", oracle_delay);
    }
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
    bound_update: bool,
) -> ClearingHouseResult<UpdateKResult> {
    let sqrt_k_ratio_precision = bn::U192::from(AMM_RESERVE_PRECISION);

    let old_sqrt_k = bn::U192::from(market.amm.sqrt_k);
    let mut sqrt_k_ratio = new_sqrt_k
        .checked_mul(sqrt_k_ratio_precision)
        .ok_or_else(math_error!())?
        .checked_div(old_sqrt_k)
        .ok_or_else(math_error!())?;

    // if decreasing k, max decrease ratio for single transaction is 2.5%
    if bound_update && sqrt_k_ratio < U192::from(9_750_000_000_000_u128) {
        return Err(ErrorCode::InvalidUpdateK);
    }

    if sqrt_k_ratio < sqrt_k_ratio_precision {
        sqrt_k_ratio = sqrt_k_ratio + 1;
    }

    let sqrt_k = new_sqrt_k.try_to_u128().unwrap();

    if bound_update
        && new_sqrt_k < old_sqrt_k
        && market.amm.net_base_asset_amount.unsigned_abs()
            > sqrt_k.checked_div(3).ok_or_else(math_error!())?
    {
        // todo, check less lp_tokens as well
        msg!("new_sqrt_k too small relative to market imbalance");
        return Err(ErrorCode::InvalidUpdateK);
    }

    if market.amm.net_base_asset_amount.unsigned_abs() > sqrt_k {
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
    market.amm.base_asset_reserve = update_k_result.base_asset_reserve;
    market.amm.quote_asset_reserve = update_k_result.quote_asset_reserve;
    market.amm.sqrt_k = update_k_result.sqrt_k;

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

    let (min_base_asset_reserve, max_base_asset_reserve) =
        calculate_bid_ask_bounds(market.amm.sqrt_k)?; // todo: use _new_terminal_base_reserve?
    market.amm.min_base_asset_reserve = min_base_asset_reserve;
    market.amm.max_base_asset_reserve = max_base_asset_reserve;

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

pub fn calculate_max_base_asset_amount_fillable(
    amm: &AMM,
    order_direction: &PositionDirection,
) -> ClearingHouseResult<u128> {
    let max_fill_size = amm.base_asset_reserve / amm.max_base_asset_amount_ratio as u128;
    let max_base_asset_amount_on_side = match order_direction {
        PositionDirection::Long => amm
            .base_asset_reserve
            .saturating_sub(amm.min_base_asset_reserve),
        PositionDirection::Short => amm
            .max_base_asset_reserve
            .saturating_sub(amm.base_asset_reserve),
    };

    standardize_base_asset_amount(
        max_fill_size.min(max_base_asset_amount_on_side),
        amm.base_asset_amount_step_size,
    )
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::controller::amm::update_spreads;
    use crate::controller::lp::burn_lp_shares;
    use crate::controller::lp::mint_lp_shares;
    use crate::controller::lp::settle_lp_position;
    use crate::math::constants::{MARK_PRICE_PRECISION, QUOTE_PRECISION_I128};
    use crate::state::user::MarketPosition;

    #[test]
    fn max_spread_tests() {
        let (l, s) = cap_to_max_spread(3905832905, 3582930, 1000).unwrap();
        assert_eq!(l, 1000);
        assert_eq!(s, 0);

        let (l, s) = cap_to_max_spread(9999, 1, 1000).unwrap();
        assert_eq!(l, 1000);
        assert_eq!(s, 0);

        let (l, s) = cap_to_max_spread(999, 1, 1000).unwrap();
        assert_eq!(l, 999);
        assert_eq!(s, 1);

        let (l, s) = cap_to_max_spread(444, 222, 1000).unwrap();
        assert_eq!(l, 444);
        assert_eq!(s, 222);

        let (l, s) = cap_to_max_spread(150, 2221, 1000).unwrap();
        assert_eq!(l, 0);
        assert_eq!(s, 1000);

        let (l, s) = cap_to_max_spread(2500 - 10, 11, 2500).unwrap();
        assert_eq!(l, 2490);
        assert_eq!(s, 10);

        let (l, s) = cap_to_max_spread(2510, 110, 2500).unwrap();
        assert_eq!(l, 2500);
        assert_eq!(s, 0);
    }

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

        let base_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let min_base_asset_reserve = AMM_RESERVE_PRECISION * 0;
        let max_base_asset_reserve = AMM_RESERVE_PRECISION * 100000;

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
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
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
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
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
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
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
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
        )
        .unwrap();
        assert!(short_spread4 < long_spread4);
        // (1000000/777 + 1 )* 1.562 -> 2012
        assert_eq!(long_spread4, 2012);
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
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
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
        assert_eq!(bar_l, 19983511953833);
        assert_eq!(qar_l, 20016501650165);
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
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
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
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
        )
        .unwrap();

        assert_eq!(long_spread_btc1, 500 / 2);
        // assert_eq!(short_spread_btc1, 197670);
        assert_eq!(short_spread_btc1, 197668); // max spread
    }

    #[test]
    fn calculate_spread_inventory_tests() {
        let base_spread = 1000; // .1%
        let mut last_oracle_mark_spread_pct = 0;
        let mut last_oracle_conf_pct = 0;
        let quote_asset_reserve = AMM_RESERVE_PRECISION * 9;
        let mut terminal_quote_asset_reserve = AMM_RESERVE_PRECISION * 10;
        let peg_multiplier = 34000;
        let mut net_base_asset_amount = -(AMM_RESERVE_PRECISION as i128);
        let mark_price = 345623040000;
        let mut total_fee_minus_distributions = 10000 * QUOTE_PRECISION_I128;

        let base_asset_reserve = AMM_RESERVE_PRECISION * 11;
        let min_base_asset_reserve = AMM_RESERVE_PRECISION * 7;
        let max_base_asset_reserve = AMM_RESERVE_PRECISION * 14;

        let margin_ratio_initial = 2000; // 5x max leverage
        let max_spread = margin_ratio_initial * 100;

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
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
        )
        .unwrap();

        // inventory scale
        let (max_bids, max_asks) = _calculate_market_open_bids_asks(
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
        )
        .unwrap();
        assert_eq!(max_bids, 40000000000000);
        assert_eq!(max_asks, -30000000000000);

        let total_liquidity = max_bids
            .checked_add(max_asks.abs())
            .ok_or_else(math_error!())
            .unwrap();
        assert_eq!(total_liquidity, 70000000000000);
        // inventory scale
        let inventory_scale = net_base_asset_amount
            .checked_mul(BID_ASK_SPREAD_PRECISION_I128 * 5)
            .unwrap()
            .checked_div(total_liquidity)
            .unwrap()
            .unsigned_abs();
        assert_eq!(inventory_scale, 714285);

        assert_eq!(long_spread1, 500);
        assert_eq!(short_spread1, 857);

        net_base_asset_amount = net_base_asset_amount * 2;
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
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
        )
        .unwrap();
        assert_eq!(long_spread1, 500);
        assert_eq!(short_spread1, 1214);

        terminal_quote_asset_reserve = AMM_RESERVE_PRECISION * 11;
        total_fee_minus_distributions = QUOTE_PRECISION_I128 * 5;
        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_mark_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            net_base_asset_amount,
            mark_price * 9 / 10,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
        )
        .unwrap();
        assert_eq!(long_spread1, 500);
        assert_eq!(short_spread1, 2619);

        total_fee_minus_distributions = QUOTE_PRECISION_I128 * 1;
        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_mark_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            net_base_asset_amount,
            mark_price * 9 / 10,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
        )
        .unwrap();
        assert_eq!(long_spread1, 500);
        assert_eq!(short_spread1, 6070); // 1214 * 5

        // flip sign
        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_mark_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            -net_base_asset_amount,
            mark_price * 9 / 10,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
        )
        .unwrap();
        assert_eq!(long_spread1, 6070);
        assert_eq!(short_spread1, 500);

        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_mark_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            -net_base_asset_amount * 5,
            mark_price * 9 / 10,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve,
            max_base_asset_reserve,
        )
        .unwrap();
        assert_eq!(long_spread1, 12500);
        assert_eq!(short_spread1, 500);

        let (long_spread1, short_spread1) = calculate_spread(
            base_spread,
            last_oracle_mark_spread_pct,
            last_oracle_conf_pct,
            max_spread,
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            -net_base_asset_amount,
            mark_price * 9 / 10,
            total_fee_minus_distributions,
            base_asset_reserve,
            min_base_asset_reserve / 2,
            max_base_asset_reserve * 2,
        )
        .unwrap();
        assert_eq!(long_spread1, 3520);
        assert_eq!(short_spread1, 500);
    }

    #[test]
    fn k_update_results_bound_flag() {
        let init_reserves = 100 * AMM_RESERVE_PRECISION;
        let amm = AMM {
            sqrt_k: init_reserves,
            base_asset_reserve: init_reserves,
            quote_asset_reserve: init_reserves,
            ..AMM::default()
        };
        let market = Market {
            amm,
            ..Market::default()
        };

        let new_sqrt_k = U192::from(AMM_RESERVE_PRECISION);
        let is_error = get_update_k_result(&market, new_sqrt_k, true).is_err();
        assert!(is_error);

        let is_ok = get_update_k_result(&market, new_sqrt_k, false).is_ok();
        assert!(is_ok)
    }

    #[test]
    fn calc_mark_std_tests() {
        let prev = 1656682258;
        let mut now = prev + 60;
        let mut amm = AMM {
            // base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            mark_std: MARK_PRICE_PRECISION as u64,
            last_oracle_price: MARK_PRICE_PRECISION as i128,
            last_mark_price_twap_ts: prev,
            ..AMM::default()
        };
        update_amm_mark_std(&mut amm, now, MARK_PRICE_PRECISION * 23, 0).unwrap();
        assert_eq!(amm.mark_std, 230000000000);

        amm.mark_std = MARK_PRICE_PRECISION as u64;
        amm.last_mark_price_twap_ts = now - 60;
        update_amm_mark_std(&mut amm, now, MARK_PRICE_PRECISION * 2, 0).unwrap();
        assert_eq!(amm.mark_std, 20000000000);

        let mut px = MARK_PRICE_PRECISION;
        let stop_time = now + 3600 * 2;
        while now <= stop_time {
            now += 1;
            if now % 15 == 0 {
                px = px * 1012 / 1000;
                amm.last_oracle_price = amm.last_oracle_price * 10119 / 10000;
            } else {
                px = px * 100000 / 100133;
                amm.last_oracle_price = amm.last_oracle_price * 100001 / 100133;
            }
            let trade_direction = PositionDirection::Long;
            update_mark_twap(&mut amm, now, Some(px), Some(trade_direction)).unwrap();
        }
        assert_eq!(now, 1656689519);
        assert_eq!(px, 404665520);
        assert_eq!(amm.mark_std, 1077512);

        // sol price looking thinkg
        let mut px: u128 = 319_366_586_000;
        let stop_time = now + 3600 * 2;
        while now <= stop_time {
            now += 1;
            if now % 15 == 0 {
                px = 319_866_586_000; //31.98
                amm.last_oracle_price = (px - 1000000) as i128;
                let trade_direction = PositionDirection::Long;
                update_mark_twap(&mut amm, now, Some(px), Some(trade_direction)).unwrap();
            }
            if now % 189 == 0 {
                px = 318_836_516_000; //31.88
                amm.last_oracle_price = (px + 1000000) as i128;
                let trade_direction = PositionDirection::Short;
                update_mark_twap(&mut amm, now, Some(px), Some(trade_direction)).unwrap();
            }
        }
        assert_eq!(now, 1656696720);
        assert_eq!(px, 319866586000);
        assert_eq!(amm.mark_std, 132809001);

        // sol price looking thinkg
        let mut px: u128 = 319_366_586_000;
        let stop_time = now + 3600 * 2;
        while now <= stop_time {
            now += 1;
            if now % 2 == 1 {
                px = 319_866_586_000; //31.98
                amm.last_oracle_price = (px - 1000000) as i128;
                let trade_direction = PositionDirection::Long;
                update_mark_twap(&mut amm, now, Some(px), Some(trade_direction)).unwrap();
            }
            if now % 2 == 0 {
                px = 318_836_516_000; //31.88
                amm.last_oracle_price = (px + 1000000) as i128;
                let trade_direction = PositionDirection::Short;
                update_mark_twap(&mut amm, now, Some(px), Some(trade_direction)).unwrap();
            }
        }
        assert_eq!(now, 1656703921);
        assert_eq!(px, 319866586000);
        assert_eq!(amm.mark_std, 686546667); //.068
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
        assert_eq!(amm.last_oracle_price_twap_5min, 333920000000);

        let _new_oracle_twap_2 =
            update_oracle_price_twap(&mut amm, now + 60 * 5, &oracle_price_data, None).unwrap();

        assert_eq!(amm.last_oracle_price_twap, 336951527777);
        assert_eq!(
            amm.last_oracle_price_twap_5min,
            31 * MARK_PRICE_PRECISION_I128
        );

        oracle_price_data = OraclePriceData {
            price: (32 * MARK_PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let _new_oracle_twap_2 =
            update_oracle_price_twap(&mut amm, now + 60 * 5 + 60, &oracle_price_data, None)
                .unwrap();
        assert_eq!(amm.last_oracle_price_twap_5min, 312000000000);
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
            get_update_k_result(&market, bn::U192::from(501 * AMM_RESERVE_PRECISION), true)
                .unwrap();
        let (t_price, t_qar, t_bar) = calculate_terminal_price_and_reserves(&market.amm).unwrap();

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

        let (t_price2, t_qar2, t_bar2) =
            calculate_terminal_price_and_reserves(&market.amm).unwrap();
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

    #[test]
    fn calculate_k_with_lps_tests() {
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 999900009999000 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50_000_000,
                net_base_asset_amount: (AMM_RESERVE_PRECISION / 10) as i128,
                base_asset_amount_step_size: 3,
                max_spread: 1000,
                ..AMM::default_test()
            },
            margin_ratio_initial: 1000,
            base_asset_amount_long: (AMM_RESERVE_PRECISION / 10) as i128,
            ..Market::default()
        };
        // let (t_price, _t_qar, _t_bar) = calculate_terminal_price_and_reserves(&market.amm).unwrap();
        // market.amm.terminal_quote_asset_reserve = _t_qar;

        let mut position = MarketPosition {
            ..MarketPosition::default()
        };

        mint_lp_shares(&mut position, &mut market, AMM_RESERVE_PRECISION, 0).unwrap();

        market.amm.market_position_per_lp = MarketPosition {
            base_asset_amount: 1,
            quote_asset_amount: -QUOTE_PRECISION_I128,
            ..MarketPosition::default()
        };

        let mark_price = market.amm.mark_price().unwrap();
        update_spreads(&mut market.amm, mark_price).unwrap();

        settle_lp_position(&mut position, &mut market).unwrap();

        assert_eq!(position.base_asset_amount, 0);
        assert_eq!(position.quote_asset_amount, -QUOTE_PRECISION_I128);
        assert_eq!(position.last_net_base_asset_amount_per_lp, 0);
        assert_eq!(
            position.last_net_quote_asset_amount_per_lp,
            -QUOTE_PRECISION_I128
        );

        // increase k by 1%
        let update_k_up =
            get_update_k_result(&market, bn::U192::from(102 * AMM_RESERVE_PRECISION), false)
                .unwrap();
        let (t_price, _t_qar, _t_bar) = calculate_terminal_price_and_reserves(&market.amm).unwrap();

        // new terminal reserves are balanced, terminal price = peg)
        // assert_eq!(t_qar, 999900009999000);
        // assert_eq!(t_bar, 1000100000000000);
        assert_eq!(t_price, 499011369495392); //
                                              // assert_eq!(update_k_up.sqrt_k, 101 * AMM_RESERVE_PRECISION);

        let cost = adjust_k_cost(&mut market, &update_k_up).unwrap();
        assert_eq!(
            market.amm.net_base_asset_amount,
            (AMM_RESERVE_PRECISION / 10) as i128
        );
        assert_eq!(cost, 49406); //0.05

        // lp whale adds
        let lp_whale_amount = 1000 * AMM_RESERVE_PRECISION;
        mint_lp_shares(&mut position, &mut market, lp_whale_amount, 0).unwrap();

        // ensure same cost
        let update_k_up =
            get_update_k_result(&market, bn::U192::from(1102 * AMM_RESERVE_PRECISION), false)
                .unwrap();
        let cost = adjust_k_cost(&mut market, &update_k_up).unwrap();
        assert_eq!(
            market.amm.net_base_asset_amount,
            (AMM_RESERVE_PRECISION / 10) as i128
        );
        assert_eq!(cost, 49406); //0.05

        let update_k_down =
            get_update_k_result(&market, bn::U192::from(1001 * AMM_RESERVE_PRECISION), false)
                .unwrap();
        let cost = adjust_k_cost(&mut market, &update_k_down).unwrap();
        assert_eq!(cost, -4995004995); //amm rug

        // lp whale removes
        burn_lp_shares(&mut position, &mut market, lp_whale_amount, 0).unwrap();

        // ensure same cost
        let update_k_up =
            get_update_k_result(&market, bn::U192::from(102 * AMM_RESERVE_PRECISION), false)
                .unwrap();
        let cost = adjust_k_cost(&mut market, &update_k_up).unwrap();
        assert_eq!(
            market.amm.net_base_asset_amount,
            (AMM_RESERVE_PRECISION / 10) as i128
        );
        assert_eq!(cost, 49406); //0.05

        let update_k_down =
            get_update_k_result(&market, bn::U192::from(79 * AMM_RESERVE_PRECISION), false)
                .unwrap();
        let cost = adjust_k_cost(&mut market, &update_k_down).unwrap();
        assert_eq!(cost, -1407044); //0.05

        // lp owns 50% of vAMM, same k
        position.lp_shares = 50 * AMM_RESERVE_PRECISION;
        market.amm.user_lp_shares = 50 * AMM_RESERVE_PRECISION;
        // cost to increase k is always positive when imbalanced
        let cost = adjust_k_cost(&mut market, &update_k_up).unwrap();
        assert_eq!(
            market.amm.net_base_asset_amount,
            (AMM_RESERVE_PRECISION / 10) as i128
        );
        assert_eq!(cost, 187807); //0.19

        // lp owns 99% of vAMM, same k
        position.lp_shares = 99 * AMM_RESERVE_PRECISION;
        market.amm.user_lp_shares = 99 * AMM_RESERVE_PRECISION;
        let cost2 = adjust_k_cost(&mut market, &update_k_up).unwrap();
        assert!(cost2 > cost);
        assert_eq!(cost2, 76804916); //216.45

        // lp owns 100% of vAMM, same k
        position.lp_shares = 100 * AMM_RESERVE_PRECISION;
        market.amm.user_lp_shares = 100 * AMM_RESERVE_PRECISION;
        let cost3 = adjust_k_cost(&mut market, &update_k_up).unwrap();
        assert!(cost3 > cost);
        assert!(cost3 > cost2);
        assert_eq!(cost3, 216450216);

        // //  todo: support this
        // market.amm.net_base_asset_amount = -(AMM_RESERVE_PRECISION as i128);
        // let cost2 = adjust_k_cost(&mut market, &update_k_up).unwrap();
        // assert!(cost2 > cost);
        // assert_eq!(cost2, 249999999999850000000001);
    }
}
