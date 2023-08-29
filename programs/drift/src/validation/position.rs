use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::MAX_OPEN_ORDERS;
use crate::math::orders::is_multiple_of_step_size;
use crate::state::perp_market::PerpMarket;
use crate::state::user::{PerpPosition, SpotPosition};
use crate::validate;
use solana_program::msg;

pub fn validate_perp_position_with_perp_market(
    position: &PerpPosition,
    market: &PerpMarket,
) -> DriftResult {
    if position.lp_shares != 0 {
        validate!(
            position.per_lp_base == market.amm.per_lp_base,
            ErrorCode::InvalidPerpPositionDetected,
            "position/market per_lp_base unequal"
        )?;
    }

    validate!(
        position.market_index == market.market_index,
        ErrorCode::InvalidPerpPositionDetected,
        "position/market market_index unequal"
    )?;

    validate!(
        is_multiple_of_step_size(
            position.base_asset_amount.unsigned_abs().cast()?,
            market.amm.order_step_size
        )?,
        ErrorCode::InvalidPerpPositionDetected,
        "position not multiple of stepsize"
    )?;

    Ok(())
}

pub fn validate_spot_position(position: &SpotPosition) -> DriftResult {
    validate!(
        position.open_orders <= MAX_OPEN_ORDERS,
        ErrorCode::InvalidSpotPositionDetected,
        "user spot={} position.open_orders={} is greater than MAX_OPEN_ORDERS={}",
        position.market_index,
        position.open_orders,
        MAX_OPEN_ORDERS,
    )?;

    validate!(
        position.open_bids >= 0,
        ErrorCode::InvalidSpotPositionDetected,
        "user spot={} position.open_bids={} is less than 0",
        position.market_index,
        position.open_bids,
    )?;

    validate!(
        position.open_asks <= 0,
        ErrorCode::InvalidSpotPositionDetected,
        "user spot={} position.open_asks={} is greater than 0",
        position.market_index,
        position.open_asks,
    )?;

    Ok(())
}
