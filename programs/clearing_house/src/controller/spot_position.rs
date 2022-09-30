use crate::checked_decrement;
use crate::checked_increment;
use crate::controller::position::PositionDirection;
use crate::controller::spot_balance::update_spot_balances;
use crate::error::ClearingHouseResult;
use crate::math::casting::{cast, Cast};
use crate::math_error;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::user::SpotPosition;
use solana_program::msg;

pub fn increase_spot_open_bids_and_asks(
    spot_position: &mut SpotPosition,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u64,
) -> ClearingHouseResult {
    match direction {
        PositionDirection::Long => {
            spot_position.open_bids = spot_position
                .open_bids
                .checked_add(base_asset_amount_unfilled.cast()?)
                .ok_or_else(math_error!())?;
        }
        PositionDirection::Short => {
            spot_position.open_asks = spot_position
                .open_asks
                .checked_sub(base_asset_amount_unfilled.cast()?)
                .ok_or_else(math_error!())?;
        }
    }

    Ok(())
}

pub fn decrease_spot_open_bids_and_asks(
    spot_position: &mut SpotPosition,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u64,
) -> ClearingHouseResult {
    match direction {
        PositionDirection::Long => {
            spot_position.open_bids = spot_position
                .open_bids
                .checked_sub(base_asset_amount_unfilled.cast()?)
                .ok_or_else(math_error!())?;
        }
        PositionDirection::Short => {
            spot_position.open_asks = spot_position
                .open_asks
                .checked_add(base_asset_amount_unfilled.cast()?)
                .ok_or_else(math_error!())?;
        }
    }

    Ok(())
}

pub fn update_spot_position_balance(
    token_amount: u128,
    update_direction: &SpotBalanceType,
    spot_market: &mut SpotMarket,
    spot_position: &mut SpotPosition,
    force_round_up: bool,
) -> ClearingHouseResult {
    update_spot_balances(
        token_amount,
        update_direction,
        spot_market,
        spot_position,
        force_round_up,
    )?;

    match update_direction {
        SpotBalanceType::Deposit => {
            checked_increment!(spot_position.cumulative_deposits, cast(token_amount)?)
        }
        SpotBalanceType::Borrow => {
            checked_decrement!(spot_position.cumulative_deposits, cast(token_amount)?)
        }
    }

    Ok(())
}

#[cfg(test)]
mod test {
    mod update_spot_position_balance {
        use crate::controller::spot_position::update_spot_position_balance;
        use crate::math::constants::SPOT_BALANCE_PRECISION;
        use crate::state::spot_market::{SpotBalanceType, SpotMarket};
        use crate::state::user::User;

        #[test]
        fn deposit() {
            let mut user = User::default();
            let mut spot_market = SpotMarket::default_quote_market();

            let token_amount = 100_u128;
            update_spot_position_balance(
                token_amount,
                &SpotBalanceType::Deposit,
                &mut spot_market,
                user.get_quote_spot_position_mut(),
                false,
            )
            .unwrap();

            assert_eq!(user.get_quote_spot_position_mut().cumulative_deposits, 100);
        }

        #[test]
        fn borrow() {
            let mut user = User::default();
            let mut spot_market = SpotMarket {
                deposit_balance: 101 * SPOT_BALANCE_PRECISION,
                ..SpotMarket::default_quote_market()
            };

            let token_amount = 100_u128;
            update_spot_position_balance(
                token_amount,
                &SpotBalanceType::Borrow,
                &mut spot_market,
                user.get_quote_spot_position_mut(),
                false,
            )
            .unwrap();

            assert_eq!(user.get_quote_spot_position_mut().cumulative_deposits, -100);
        }
    }
}
