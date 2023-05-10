use crate::controller::position::PositionDirection;
use crate::error::DriftResult;
use crate::math::amm_spread::calculate_inventory_liquidity_ratio;
use crate::math::casting::Cast;
use crate::math::constants::{AMM_RESERVE_PRECISION, PERCENTAGE_PRECISION_I128};
use crate::math::orders::standardize_base_asset_amount;
use crate::math::safe_math::SafeMath;
use crate::state::perp_market::PerpMarket;
use solana_program::msg;

#[cfg(test)]
mod tests;

// assumption: market.amm.amm_jit_is_active() == true
// assumption: taker_baa will improve market balance (see orders.rs & amm_wants_to_make)
pub fn calculate_jit_base_asset_amount(
    market: &PerpMarket,
    maker_base_asset_amount: u64,
    auction_price: u64,
    valid_oracle_price: Option<i64>,
    taker_direction: PositionDirection,
    split_with_lps: bool,
) -> DriftResult<u64> {
    let user_lp_ratio = market
        .amm
        .user_lp_shares
        .safe_div(market.amm.sqrt_k.safe_div(100)?)?
        .cast::<u64>()?;

    // protocol-owend lp only take up to 50% of what the maker is making
    let mut max_jit_amount = if split_with_lps && user_lp_ratio > 0 {
        maker_base_asset_amount
            .safe_mul(user_lp_ratio.safe_add(50)?)?
            .safe_div(100)?
    } else {
        maker_base_asset_amount.safe_div(2)?
    };

    // check for wash trade
    if let Some(oracle_price) = valid_oracle_price {
        let oracle_price = oracle_price.cast::<u64>()?;

        // maker taking a short below oracle = likely to be a wash
        // so we want to take less than 50%
        let wash_reduction_const = 2;
        if taker_direction == PositionDirection::Long && auction_price < oracle_price
            || taker_direction == PositionDirection::Short && auction_price > oracle_price
        {
            max_jit_amount = max_jit_amount.safe_div(wash_reduction_const)?
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

    jit_base_asset_amount = calculate_clamped_jit_base_asset_amount(market, jit_base_asset_amount)?;

    jit_base_asset_amount = jit_base_asset_amount.min(max_jit_amount);

    // last step we always standardize
    jit_base_asset_amount =
        standardize_base_asset_amount(jit_base_asset_amount, market.amm.order_step_size)?;

    Ok(jit_base_asset_amount)
}

// assumption: taker_baa will improve market balance (see orders.rs & amm_wants_to_make)
// note: we split it into two (calc and clamp) bc its easier to maintain tests
pub fn calculate_clamped_jit_base_asset_amount(
    market: &PerpMarket,
    jit_base_asset_amount: u64,
) -> DriftResult<u64> {
    // apply intensity
    // todo more efficient method do here
    let jit_base_asset_amount = jit_base_asset_amount
        .cast::<u128>()?
        .safe_mul(market.amm.amm_jit_intensity as u128)?
        .safe_div(100)?
        .cast::<u64>()?;

    // bound it; dont flip the net_baa
    let max_amm_base_asset_amount = market
        .amm
        .base_asset_amount_with_amm
        .unsigned_abs()
        .cast::<u64>()?;
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
) -> DriftResult<(u64, bool)> {
    let mut jit_base_asset_amount: u64 = 0;
    let mut split_with_lps: bool = false;
    crate::dlog!(market.amm.base_asset_amount_with_amm, market.amm.amm_jit_intensity);
    // crate::dlog!(taker_direction);

    let amm_wants_to_make = match taker_direction {
        PositionDirection::Long => market.amm.base_asset_amount_with_amm < 0,
        PositionDirection::Short => market.amm.base_asset_amount_with_amm > 0,
    } && market.amm.amm_jit_is_active();

    // taker has_limit_price = false means (limit price = 0 AND auction is complete) so
    // market order will always land and fill on amm next round
    let amm_will_fill_next_round: bool =
        !taker_has_limit_price && maker_base_asset_amount < taker_base_asset_amount;
    crate::dlog!(amm_wants_to_make, amm_will_fill_next_round);
    if amm_wants_to_make && !amm_will_fill_next_round {
        let amm_lp_wants_to_make = match taker_direction {
            PositionDirection::Long => {
                market.amm.base_asset_amount_per_lp
                    > market.amm.target_base_asset_amount_per_lp.cast()?
            }
            PositionDirection::Short => {
                market.amm.base_asset_amount_per_lp
                    < market.amm.target_base_asset_amount_per_lp.cast()?
            }
        } && market.amm.amm_lp_jit_is_active();

        let amm_lps_allowed_to_make = if amm_lp_wants_to_make {
            let amm_inventory_pct = calculate_inventory_liquidity_ratio(
                market.amm.base_asset_amount_with_amm,
                market.amm.base_asset_reserve,
                market.amm.min_base_asset_reserve,
                market.amm.max_base_asset_reserve,
            )?;
            crate::dlog!(amm_inventory_pct);
            amm_inventory_pct.abs() < PERCENTAGE_PRECISION_I128 / 10
        } else {
            false
        };
        crate::dlog!(amm_lps_allowed_to_make, amm_lp_wants_to_make);

        split_with_lps = amm_lps_allowed_to_make && amm_lp_wants_to_make;

        jit_base_asset_amount = calculate_jit_base_asset_amount(
            market,
            base_asset_amount,
            maker_price,
            valid_oracle_price,
            taker_direction,
            split_with_lps,
        )?;
    }

    Ok((jit_base_asset_amount, split_with_lps))
}
