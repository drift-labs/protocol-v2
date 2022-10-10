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
