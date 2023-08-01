mod update_spot_position_balance {
    use crate::controller::spot_position::{
        transfer_spot_position_deposit, update_spot_balances_and_cumulative_deposits,
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
        update_spot_balances_and_cumulative_deposits(
            token_amount,
            &SpotBalanceType::Deposit,
            &mut spot_market,
            user.get_quote_spot_position_mut(),
            false,
            None,
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
        update_spot_balances_and_cumulative_deposits(
            token_amount,
            &SpotBalanceType::Borrow,
            &mut spot_market,
            user.get_quote_spot_position_mut(),
            false,
            None,
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
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
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

mod charge_withdraw_fee {
    use crate::controller::spot_position::charge_withdraw_fee;
    use crate::math::constants::SPOT_BALANCE_PRECISION_U64;
    use crate::math::spot_balance::get_token_amount;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::user::{SpotPosition, User, UserStats};
    use crate::test_utils::get_spot_positions;
    use crate::QUOTE_PRECISION_I64;

    #[test]
    fn deposit() {
        let mut user = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                scaled_balance: SPOT_BALANCE_PRECISION_U64,
                cumulative_deposits: QUOTE_PRECISION_I64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };
        let mut user_stats = UserStats::default();
        let mut spot_market = SpotMarket::default_quote_market();

        let oracle_price = QUOTE_PRECISION_I64;

        charge_withdraw_fee(&mut spot_market, oracle_price, &mut user, &mut user_stats).unwrap();

        let token_amount = user
            .get_spot_position(0)
            .unwrap()
            .get_token_amount(&spot_market)
            .unwrap();

        let cumulative_deposits = user.get_spot_position(0).unwrap().cumulative_deposits;

        assert_eq!(token_amount, 999500);
        assert_eq!(cumulative_deposits, QUOTE_PRECISION_I64);
        assert_eq!(user_stats.fees.total_fee_paid, 500);
        assert_eq!(user.cumulative_spot_fees, -500);

        let revenue_pool_amount = get_token_amount(
            spot_market.revenue_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(revenue_pool_amount, 500);
    }
}
