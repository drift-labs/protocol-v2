use crate::controller::position::PositionDirection;
use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::constants::{AMM_RESERVE_PRECISION, PERCENTAGE_PRECISION_U64};
use crate::math::orders::standardize_base_asset_amount;
use crate::math::safe_math::SafeMath;
use crate::state::perp_market::{AMMLiquiditySplit, PerpMarket};
#[cfg(test)]
mod tests;

// assumption: market.amm.amm_jit_is_active() == true
// assumption: taker_baa will improve market balance (see orders.rs & amm_wants_to_jit_make)
pub fn calculate_jit_base_asset_amount(
    market: &PerpMarket,
    maker_base_asset_amount: u64,
    auction_price: u64,
    valid_oracle_price: Option<i64>,
    taker_direction: PositionDirection,
    liquidity_split: AMMLiquiditySplit,
) -> DriftResult<u64> {
    // AMM can only take up to 50% of size the maker is offering
    let mut max_jit_amount = maker_base_asset_amount.safe_div(2)?;
    // check for wash trade
    if let Some(oracle_price) = valid_oracle_price {
        let baseline_price = oracle_price;
        let baseline_price_u64 = oracle_price.cast::<u64>()?;
        let five_bps_of_baseline = baseline_price_u64 / 2000;

        // maker taking a short below oracle = likely to be a wash
        // so we want to take under 50% of typical

        if taker_direction == PositionDirection::Long
            && auction_price < baseline_price_u64.safe_sub(five_bps_of_baseline)?
            || taker_direction == PositionDirection::Short
                && auction_price > baseline_price_u64.saturating_add(five_bps_of_baseline)
        {
            // shrink by at least 50% based on distance from oracle
            let opposite_spread_price = if taker_direction == PositionDirection::Long {
                market
                    .amm
                    .short_spread
                    .cast::<u64>()?
                    .safe_mul(baseline_price_u64)?
                    .safe_div(PERCENTAGE_PRECISION_U64)?
            } else {
                market
                    .amm
                    .long_spread
                    .cast::<u64>()?
                    .safe_mul(baseline_price_u64)?
                    .safe_div(PERCENTAGE_PRECISION_U64)?
            };

            let price_difference_from_baseline = auction_price
                .cast::<i64>()?
                .safe_sub(baseline_price)?
                .unsigned_abs();

            let max_jit_amount_scale_numerator =
                opposite_spread_price.saturating_sub(price_difference_from_baseline);

            max_jit_amount = max_jit_amount
                .safe_mul(max_jit_amount_scale_numerator)?
                .safe_div(opposite_spread_price.max(1))?;
        }
    } else {
        max_jit_amount = 0;
    };

    if max_jit_amount == 0 {
        return Ok(0);
    }

    // check for market imbalance
    // e.g,
    //     0    2.5    5   7.5   10
    // min | -- | -- mid -- |-- | max
    //          mim         mam
    // base @ mid = ratio = 1
    // base @ mim = ratio = 2.5 / 7.5 = 3 == imbalanced
    // ratio >= 3 == imbalanced

    let (max_bids, max_asks) = crate::math::amm::calculate_market_open_bids_asks(&market.amm)?;
    let (max_bids, max_asks) = (max_bids.unsigned_abs(), max_asks.unsigned_abs());

    let numerator = max_bids.max(max_asks);
    let denominator = max_bids.min(max_asks);
    let ratio = numerator
        .safe_mul(AMM_RESERVE_PRECISION)?
        .safe_div(denominator)
        .unwrap_or(u128::MAX);

    let imbalanced_bound = 15_u128.safe_mul(AMM_RESERVE_PRECISION.safe_div(10)?)?;

    let amm_is_imbalanced = ratio >= imbalanced_bound;

    // take more when amm is imbalanced
    let mut jit_base_asset_amount = if amm_is_imbalanced {
        maker_base_asset_amount
    } else {
        maker_base_asset_amount.safe_div(4)?
    };

    if jit_base_asset_amount == 0 {
        return Ok(0);
    }

    jit_base_asset_amount =
        calculate_clamped_jit_base_asset_amount(market, liquidity_split, jit_base_asset_amount)?;

    jit_base_asset_amount = jit_base_asset_amount.min(max_jit_amount);

    // last step we always standardize
    jit_base_asset_amount =
        standardize_base_asset_amount(jit_base_asset_amount, market.amm.order_step_size)?;

    Ok(jit_base_asset_amount)
}

// assumption: taker_baa will improve market balance (see orders.rs & amm_wants_to_jit_make)
// note: we split it into two (calc and clamp) bc its easier to maintain tests
pub fn calculate_clamped_jit_base_asset_amount(
    market: &PerpMarket,
    liquidity_split: AMMLiquiditySplit,
    jit_base_asset_amount: u64,
) -> DriftResult<u64> {
    // apply intensity
    // todo more efficient method do here
    let jit_base_asset_amount: u64 = jit_base_asset_amount
        .cast::<u128>()?
        .safe_mul(market.amm.amm_jit_intensity.min(100).cast::<u128>()?)?
        .safe_div(100_u128)?
        .cast::<u64>()?;

    // bound it; dont flip the net_baa
    let max_amm_base_asset_amount = if liquidity_split != AMMLiquiditySplit::LPOwned {
        market
            .amm
            .base_asset_amount_with_amm
            .unsigned_abs()
            .cast::<u64>()?
    } else {
        market
            .amm
            .imbalanced_base_asset_amount_with_lp()?
            .unsigned_abs()
            .cast::<u64>()?
    };

    let jit_base_asset_amount = jit_base_asset_amount.min(max_amm_base_asset_amount);

    Ok(jit_base_asset_amount)
}

pub fn calculate_amm_jit_liquidity(
    market: &mut PerpMarket,
    taker_direction: PositionDirection,
    maker_price: u64,
    valid_oracle_price: Option<i64>,
    base_asset_amount: u64,
    taker_base_asset_amount: u64,
    maker_base_asset_amount: u64,
    taker_has_limit_price: bool,
) -> DriftResult<(u64, AMMLiquiditySplit)> {
    let mut jit_base_asset_amount: u64 = 0;
    let mut liquidity_split: AMMLiquiditySplit = AMMLiquiditySplit::ProtocolOwned;

    // taker has_limit_price = false means (limit price = 0 AND auction is complete) so
    // market order will always land and fill on amm next round
    let amm_will_fill_next_round: bool =
        !taker_has_limit_price && maker_base_asset_amount < taker_base_asset_amount;

    // return early
    if amm_will_fill_next_round {
        return Ok((jit_base_asset_amount, liquidity_split));
    }
    let amm_wants_to_jit_make = market.amm.amm_wants_to_jit_make(taker_direction)?;

    let amm_lp_wants_to_jit_make = market.amm.amm_lp_wants_to_jit_make(taker_direction)?;
    let amm_lp_allowed_to_jit_make = market
        .amm
        .amm_lp_allowed_to_jit_make(amm_wants_to_jit_make)?;
    let split_with_lps = amm_lp_allowed_to_jit_make && amm_lp_wants_to_jit_make;

    if amm_wants_to_jit_make {
        liquidity_split = if split_with_lps {
            AMMLiquiditySplit::Shared
        } else {
            AMMLiquiditySplit::ProtocolOwned
        };

        jit_base_asset_amount = calculate_jit_base_asset_amount(
            market,
            base_asset_amount,
            maker_price,
            valid_oracle_price,
            taker_direction,
            liquidity_split,
        )?;
    } else if split_with_lps {
        liquidity_split = AMMLiquiditySplit::LPOwned;

        jit_base_asset_amount = calculate_jit_base_asset_amount(
            market,
            base_asset_amount,
            maker_price,
            valid_oracle_price,
            taker_direction,
            liquidity_split,
        )?;
    }

    Ok((jit_base_asset_amount, liquidity_split))
}
