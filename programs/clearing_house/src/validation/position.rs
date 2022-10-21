use crate::error::{ClearingHouseResult, ErrorCode};
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
) -> ClearingHouseResult {
    validate!(
        position.market_index == market.market_index,
        ErrorCode::DefaultError,
        "position/market market_index unequal"
    )?;

    validate!(
        is_multiple_of_step_size(
            position.base_asset_amount.unsigned_abs().cast()?,
            market.amm.order_step_size
        )?,
        ErrorCode::DefaultError,
        "position not multiple of stepsize"
    )?;

    Ok(())
}

pub fn validate_spot_position(position: &SpotPosition) -> ClearingHouseResult {
    validate!(
        position.open_orders <= MAX_OPEN_ORDERS,
        ErrorCode::DefaultError,
        "user spot={} position.open_orders={} is greater than MAX_OPEN_ORDERS={}",
        position.market_index,
        position.open_orders,
        MAX_OPEN_ORDERS,
    )?;

    validate!(
        position.open_bids >= 0,
        ErrorCode::DefaultError,
        "user spot={} position.open_bids={} is less than 0",
        position.market_index,
        position.open_bids,
    )?;

    validate!(
        position.open_asks <= 0,
        ErrorCode::DefaultError,
        "user spot={} position.open_asks={} is greater than 0",
        position.market_index,
        position.open_asks,
    )?;

    Ok(())
}
