use crate::error::{ClearingHouseResult, ErrorCode};
use crate::state::user::{OrderStatus, User, UserStats};
use crate::validate;
use solana_program::msg;

pub fn validate_user_deletion(user: &User, user_stats: &UserStats) -> ClearingHouseResult {
    validate!(
        !user_stats.is_referrer || user.user_id != 0,
        ErrorCode::UserCantBeDeleted,
        "user id 0 cant be deleted if user is a referrer"
    )?;

    validate!(
        !user.bankrupt,
        ErrorCode::UserCantBeDeleted,
        "user bankrupt"
    )?;

    validate!(
        !user.being_liquidated,
        ErrorCode::UserCantBeDeleted,
        "user being liquidated"
    )?;

    for perp_position in &user.perp_positions {
        validate!(
            perp_position.is_available(),
            ErrorCode::UserCantBeDeleted,
            "user has perp position for market {}",
            perp_position.market_index
        )?;
    }

    for spot_position in &user.spot_positions {
        validate!(
            spot_position.is_available(),
            ErrorCode::UserCantBeDeleted,
            "user has spot position for market {}",
            spot_position.market_index
        )?;
    }

    for order in &user.orders {
        validate!(
            order.status == OrderStatus::Init,
            ErrorCode::UserCantBeDeleted,
            "user has an open order"
        )?;
    }

    Ok(())
}
