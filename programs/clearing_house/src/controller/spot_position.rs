use crate::checked_decrement;
use crate::checked_increment;
use crate::controller::position::PositionDirection;
use crate::controller::spot_balance::update_spot_balances;
use crate::error::ClearingHouseResult;
use crate::error::ErrorCode;
use crate::math::casting::{cast, Cast};
use crate::math_error;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::user::SpotPosition;
use crate::validate;
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

pub fn transfer_spot_position_deposit(
    token_amount: i128,
    spot_market: &mut SpotMarket,
    from_spot_position: &mut SpotPosition,
    to_spot_position: &mut SpotPosition,
) -> ClearingHouseResult {
    validate!(
        from_spot_position.market_index == to_spot_position.market_index,
        ErrorCode::DefaultError,
        "transfer market indexes arent equal",
    )?;

    update_spot_position_balance(
        token_amount.unsigned_abs(),
        if token_amount > 0 {
            &SpotBalanceType::Borrow
        } else {
            &SpotBalanceType::Deposit
        },
        spot_market,
        from_spot_position,
        false,
    )?;

    update_spot_position_balance(
        token_amount.unsigned_abs(),
        if token_amount > 0 {
            &SpotBalanceType::Deposit
        } else {
            &SpotBalanceType::Borrow
        },
        spot_market,
        to_spot_position,
        false,
    )?;

    Ok(())
}

#[cfg(test)]
mod test {
    mod update_spot_position_balance {
        use crate::controller::spot_position::{
            transfer_spot_position_deposit, update_spot_position_balance,
        };
        use crate::math::constants::{
            LAMPORTS_PER_SOL_I64, SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64,
        };
        use crate::state::spot_market::{SpotBalanceType, SpotMarket};
        use crate::state::user::{SpotPosition, User};

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

        #[test]
        fn transfer() {
            let mut user = User::default();
            let mut user2 = User::default();

            let mut spot_market = SpotMarket {
                deposit_balance: 101 * SPOT_BALANCE_PRECISION,
                ..SpotMarket::default_quote_market()
            };

            let token_amount = 100_i128;
            transfer_spot_position_deposit(
                token_amount,
                &mut spot_market,
                user.get_quote_spot_position_mut(),
                user2.get_quote_spot_position_mut(),
            )
            .unwrap();

            assert_eq!(user.get_quote_spot_position_mut().cumulative_deposits, -100);
            assert_eq!(user2.get_quote_spot_position_mut().cumulative_deposits, 100);

            transfer_spot_position_deposit(
                -token_amount * 2,
                &mut spot_market,
                user.get_quote_spot_position_mut(),
                user2.get_quote_spot_position_mut(),
            )
            .unwrap();

            assert_eq!(user.get_quote_spot_position_mut().cumulative_deposits, 100);
            assert_eq!(
                user2.get_quote_spot_position_mut().cumulative_deposits,
                -100
            );
        }

        #[test]
        fn transfer_fail() {
            let mut user = User::default();

            let mut spot_positions = [SpotPosition::default(); 8];
            spot_positions[0] = SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                balance: SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };

            spot_positions[1] = SpotPosition {
                market_index: 1,
                open_orders: 1,
                open_bids: LAMPORTS_PER_SOL_I64,
                ..SpotPosition::default()
            };

            let mut user2 = User {
                spot_positions,
                ..User::default()
            };

            let mut spot_market = SpotMarket {
                deposit_balance: 101 * SPOT_BALANCE_PRECISION,
                ..SpotMarket::default_quote_market()
            };

            let mut sol_market = SpotMarket {
                deposit_balance: 101 * SPOT_BALANCE_PRECISION,
                ..SpotMarket::default_base_market()
            };

            let token_amount = 100_i128;
            assert!(transfer_spot_position_deposit(
                token_amount,
                &mut spot_market,
                user.get_quote_spot_position_mut(),
                user2.get_spot_position_mut(1).unwrap(),
            )
            .is_err());

            let token_amount = 100_i128;
            assert!(transfer_spot_position_deposit(
                token_amount,
                &mut sol_market,
                user.get_quote_spot_position_mut(),
                user2.get_spot_position_mut(1).unwrap(),
            )
            .is_err());
        }
    }
}
