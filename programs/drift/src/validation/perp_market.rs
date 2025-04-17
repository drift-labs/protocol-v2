use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::MAX_BASE_ASSET_AMOUNT_WITH_AMM;
use crate::math::safe_math::SafeMath;

use crate::msg;
use crate::state::perp_market::{MarketStatus, PerpMarket, AMM};
use crate::{validate, BID_ASK_SPREAD_PRECISION};

#[allow(clippy::comparison_chain)]
pub fn validate_perp_market(market: &PerpMarket) -> DriftResult {
    let (_, remainder_base_asset_amount_long) =
        crate::math::orders::standardize_base_asset_amount_with_remainder_i128(
            market.amm.base_asset_amount_long,
            market.amm.order_step_size.cast()?,
        )?;

    let (_, remainder_base_asset_amount_short) =
        crate::math::orders::standardize_base_asset_amount_with_remainder_i128(
            market.amm.base_asset_amount_short,
            market.amm.order_step_size.cast()?,
        )?;

    validate!(
        remainder_base_asset_amount_long == 0 && remainder_base_asset_amount_short == 0,
        ErrorCode::InvalidPositionDelta,
        "market {} invalid base_asset_amount_long/short vs order_step_size, remainder={}/{}",
        market.market_index,
        remainder_base_asset_amount_short,
        market.amm.order_step_size
    )?;
    validate!(
        (market.amm.base_asset_amount_long + market.amm.base_asset_amount_short)
            == market.amm.base_asset_amount_with_amm
                + market.amm.base_asset_amount_with_unsettled_lp,
        ErrorCode::InvalidAmmDetected,
        "Market NET_BAA Error: 
        market.amm.base_asset_amount_long={}, 
        + market.amm.base_asset_amount_short={} 
        != 
        market.amm.base_asset_amount_with_amm={}
        +  market.amm.base_asset_amount_with_unsettled_lp={}",
        market.amm.base_asset_amount_long,
        market.amm.base_asset_amount_short,
        market.amm.base_asset_amount_with_amm,
        market.amm.base_asset_amount_with_unsettled_lp,
    )?;

    validate!(
        market.amm.base_asset_amount_with_amm <= (MAX_BASE_ASSET_AMOUNT_WITH_AMM as i128),
        ErrorCode::InvalidAmmDetected,
        "market {} market.amm.base_asset_amount_with_amm={} is too large",
        market.market_index,
        market.amm.base_asset_amount_with_amm
    )?;

    validate!(
        market.amm.peg_multiplier > 0,
        ErrorCode::InvalidAmmDetected,
        "market {} peg_multiplier out of wack",
        market.market_index,
    )?;

    if market.status != MarketStatus::ReduceOnly {
        validate!(
            market.amm.sqrt_k > market.amm.base_asset_amount_with_amm.unsigned_abs(),
            ErrorCode::InvalidAmmDetected,
            "market {} k out of wack: k={}, net_baa={}",
            market.market_index,
            market.amm.sqrt_k,
            market.amm.base_asset_amount_with_amm
        )?;
    }

    validate!(
        market.amm.sqrt_k >= market.amm.base_asset_reserve
            || market.amm.sqrt_k >= market.amm.quote_asset_reserve,
        ErrorCode::InvalidAmmDetected,
        "market {} k out of wack: k={}, bar={}, qar={}",
        market.market_index,
        market.amm.sqrt_k,
        market.amm.base_asset_reserve,
        market.amm.quote_asset_reserve
    )?;

    validate!(
        market.amm.sqrt_k >= market.amm.user_lp_shares,
        ErrorCode::InvalidAmmDetected,
        "market {} market.amm.sqrt_k < market.amm.user_lp_shares: {} < {}",
        market.market_index,
        market.amm.sqrt_k,
        market.amm.user_lp_shares,
    )?;

    let invariant_sqrt_u192 = crate::bn::U192::from(market.amm.sqrt_k);
    let invariant = invariant_sqrt_u192.safe_mul(invariant_sqrt_u192)?;
    let quote_asset_reserve = invariant
        .safe_div(crate::bn::U192::from(market.amm.base_asset_reserve))?
        .try_to_u128()?;

    let rounding_diff = quote_asset_reserve
        .cast::<i128>()?
        .safe_sub(market.amm.quote_asset_reserve.cast()?)?
        .abs();

    validate!(
        rounding_diff <= 15,
        ErrorCode::InvalidAmmDetected,
        "market {} amm qar/bar/k invalid: k={}, bar={}, qar={}, qar'={} (rounding: {})",
        market.market_index,
        invariant,
        market.amm.base_asset_reserve,
        market.amm.quote_asset_reserve,
        quote_asset_reserve,
        rounding_diff
    )?;

    // todo
    if market.amm.base_spread > 0 {
        // bid quote/base < reserve q/b
        if market.amm.reference_price_offset <= 0 {
            validate!(
                market.amm.bid_base_asset_reserve >= market.amm.base_asset_reserve
                    && market.amm.bid_quote_asset_reserve <= market.amm.quote_asset_reserve,
                ErrorCode::InvalidAmmDetected,
                "market {} amm bid reserves invalid: {} -> {}, quote: {} -> {}",
                market.market_index,
                market.amm.bid_base_asset_reserve,
                market.amm.base_asset_reserve,
                market.amm.bid_quote_asset_reserve,
                market.amm.quote_asset_reserve
            )?;
        }

        if market.amm.reference_price_offset >= 0 {
            // ask quote/base > reserve q/b
            validate!(
                market.amm.ask_base_asset_reserve <= market.amm.base_asset_reserve
                    && market.amm.ask_quote_asset_reserve >= market.amm.quote_asset_reserve,
                ErrorCode::InvalidAmmDetected,
                "market {} amm ask reserves invalid: {} -> {}, quote: {} -> {}",
                market.market_index,
                market.amm.ask_base_asset_reserve,
                market.amm.base_asset_reserve,
                market.amm.ask_quote_asset_reserve,
                market.amm.quote_asset_reserve
            )?;
        }
    }

    validate!(
        market.amm.long_spread + market.amm.short_spread >= market.amm.base_spread,
        ErrorCode::InvalidAmmDetected,
        "market {} amm long_spread + short_spread < base_spread: {} + {} < {}",
        market.market_index,
        market.amm.long_spread,
        market.amm.short_spread,
        market.amm.base_spread
    )?;

    validate!(
        market
            .amm
            .long_spread
            .safe_add(market.amm.short_spread)?
            .cast::<u64>()?
            <= BID_ASK_SPREAD_PRECISION,
        ErrorCode::InvalidAmmDetected,
        "market {} amm long_spread {} + short_spread {} > max bid-ask spread precision (max spread = {})",
        market.market_index,
        market.amm.long_spread,
        market.amm.short_spread,
        market.amm.max_spread,
    )?;

    if market.amm.base_asset_amount_with_amm > 0 {
        // users are long = removed base and added quote = qar increased
        // bid quote/base < reserve q/b
        validate!(
            market.amm.terminal_quote_asset_reserve <= market.amm.quote_asset_reserve,
            ErrorCode::InvalidAmmDetected,
            "market {} terminal_quote_asset_reserve out of wack",
            market.market_index,
        )?;
    } else if market.amm.base_asset_amount_with_amm < 0 {
        validate!(
            market.amm.terminal_quote_asset_reserve >= market.amm.quote_asset_reserve,
            ErrorCode::InvalidAmmDetected,
            "market {} terminal_quote_asset_reserve out of wack (terminal <) {} > {}",
            market.market_index,
            market.amm.terminal_quote_asset_reserve,
            market.amm.quote_asset_reserve
        )?;
    } else {
        validate!(
            market.amm.terminal_quote_asset_reserve == market.amm.quote_asset_reserve,
            ErrorCode::InvalidAmmDetected,
            "market {} terminal_quote_asset_reserve out of wack {}!={}",
            market.market_index,
            market.amm.terminal_quote_asset_reserve,
            market.amm.quote_asset_reserve
        )?;
    }

    if market.amm.base_spread > 0 {
        validate!(
            market.amm.max_spread > market.amm.base_spread
                && market.amm.max_spread < market.margin_ratio_initial * 100,
            ErrorCode::InvalidAmmDetected,
            "market {} amm invalid max_spread",
            market.market_index,
        )?;
    }

    validate!(market
        .insurance_claim
        .max_revenue_withdraw_per_period >= market.insurance_claim.revenue_withdraw_since_last_settle.unsigned_abs(),
        ErrorCode::InvalidAmmDetected,
        "{} market
        .insurance_claim
        .max_revenue_withdraw_per_period={} < |market.insurance_claim.revenue_withdraw_since_last_settle|={}",
        market.market_index,
        market
        .insurance_claim
        .max_revenue_withdraw_per_period,
        market.insurance_claim.revenue_withdraw_since_last_settle.unsigned_abs()
    )?;

    validate!(
        market.amm.base_asset_amount_per_lp < MAX_BASE_ASSET_AMOUNT_WITH_AMM as i128,
        ErrorCode::InvalidAmmDetected,
        "{} market.amm.base_asset_amount_per_lp too large: {}",
        market.market_index,
        market.amm.base_asset_amount_per_lp
    )?;

    validate!(
        market.amm.quote_asset_amount_per_lp < MAX_BASE_ASSET_AMOUNT_WITH_AMM as i128,
        ErrorCode::InvalidAmmDetected,
        "{} market.amm.quote_asset_amount_per_lp too large: {}",
        market.market_index,
        market.amm.quote_asset_amount_per_lp
    )?;

    Ok(())
}

#[allow(clippy::comparison_chain)]
pub fn validate_amm_account_for_fill(amm: &AMM, direction: PositionDirection) -> DriftResult {
    if direction == PositionDirection::Long {
        validate!(
            amm.base_asset_reserve >= amm.min_base_asset_reserve,
            ErrorCode::InvalidAmmForFillDetected,
            "Market baa below min_base_asset_reserve: {} < {}",
            amm.base_asset_reserve,
            amm.min_base_asset_reserve,
        )?;
    }

    if direction == PositionDirection::Short {
        validate!(
            amm.base_asset_reserve <= amm.max_base_asset_reserve,
            ErrorCode::InvalidAmmForFillDetected,
            "Market baa above max_base_asset_reserve"
        )?;
    }

    Ok(())
}
