use crate::error::{DriftResult, ErrorCode};
use crate::state::spot_market::SpotBalanceType;
use crate::state::user::{OrderStatus, User, UserStats};
use crate::{validate, State, THIRTEEN_DAY};
use solana_program::msg;

pub fn validate_user_deletion(
    user: &User,
    user_stats: &UserStats,
    state: &State,
    now: i64,
) -> DriftResult {
    validate!(
        !user_stats.is_referrer || user.sub_account_id != 0,
        ErrorCode::UserCantBeDeleted,
        "user id 0 cant be deleted if user is a referrer"
    )?;

    validate!(
        !user.is_bankrupt(),
        ErrorCode::UserCantBeDeleted,
        "user bankrupt"
    )?;

    validate!(
        !user.is_being_liquidated(),
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

    if state.max_initialize_user_fee > 0 {
        let estimated_user_stats_age = user_stats.get_user_stats_age_ts(now)?;
        if estimated_user_stats_age < THIRTEEN_DAY as i64 {
            validate!(
                user.idle,
                ErrorCode::UserCantBeDeleted,
                "user is not idle with fresh user stats account creation ({} < {})",
                estimated_user_stats_age,
                THIRTEEN_DAY
            )?;
        }
    }

    Ok(())
}

pub fn validate_user_is_idle(user: &User, slot: u64, accelerated: bool) -> DriftResult {
    let slots_since_last_active = slot.saturating_sub(user.last_active_slot);

    let slots_before_idle = if accelerated {
        9000_u64 // 60 * 60 / .4 (~1 hour)
    } else {
        1512000_u64 // 60 * 60 * 24 * 7 / .4 (~1 week)
    };

    validate!(
        slots_since_last_active >= slots_before_idle,
        ErrorCode::UserNotInactive,
        "user only been idle for {} slot",
        slots_since_last_active
    )?;

    validate!(
        !user.is_bankrupt(),
        ErrorCode::UserNotInactive,
        "user bankrupt"
    )?;

    validate!(
        !user.is_being_liquidated(),
        ErrorCode::UserNotInactive,
        "user being liquidated"
    )?;

    for perp_position in &user.perp_positions {
        validate!(
            perp_position.is_available(),
            ErrorCode::UserNotInactive,
            "user has perp position for market {}",
            perp_position.market_index
        )?;
    }

    for spot_position in &user.spot_positions {
        validate!(
            spot_position.balance_type != SpotBalanceType::Borrow
                || spot_position.scaled_balance == 0,
            ErrorCode::UserNotInactive,
            "user has borrow for market {}",
            spot_position.market_index
        )?;

        validate!(
            spot_position.open_orders == 0,
            ErrorCode::UserNotInactive,
            "user has open order for market {}",
            spot_position.market_index
        )?;
    }

    for order in &user.orders {
        validate!(
            order.status == OrderStatus::Init,
            ErrorCode::UserNotInactive,
            "user has an open order"
        )?;
    }

    Ok(())
}
