mod get_claimable_pnl {
    use crate::math::amm::calculate_net_user_pnl;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I64, MAX_CONCENTRATION_COEFFICIENT,
        PRICE_PRECISION_I64, QUOTE_PRECISION, QUOTE_PRECISION_I128, QUOTE_PRECISION_I64,
        QUOTE_SPOT_MARKET_INDEX, SPOT_BALANCE_PRECISION, SPOT_CUMULATIVE_INTEREST_PRECISION,
        SPOT_WEIGHT_PRECISION,
    };
    use crate::math::position::calculate_base_asset_value_and_pnl_with_oracle_price;
    use crate::math::spot_balance::get_token_amount;
    use crate::state::oracle::OracleSource;
    use crate::state::perp_market::{PerpMarket, PoolBalance, AMM};
    use crate::state::spot_market::{SpotBalance, SpotMarket};
    use crate::state::user::{PerpPosition, User};
    use crate::test_utils::get_positions;

    #[test]
    fn long_negative_unrealized_pnl() {
        let user = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 50 * PRICE_PRECISION_I64;
        let unsettled_pnl = user.perp_positions[0]
            .get_claimable_pnl(oracle_price, 0)
            .unwrap();
        assert_eq!(unsettled_pnl, -50 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn long_positive_unrealized_pnl_more_than_max_pnl_to_settle() {
        let user = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -50 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * PRICE_PRECISION_I64;
        let unsettled_pnl = user.perp_positions[0]
            .get_claimable_pnl(oracle_price, 0)
            .unwrap();
        assert_eq!(unsettled_pnl, 50 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn long_positive_unrealized_pnl_more_than_max_pnl_and_pool_excess_to_settle() {
        let user = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -50 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * PRICE_PRECISION_I64;
        let (base_asset_value, unrealized_pnl) =
            calculate_base_asset_value_and_pnl_with_oracle_price(
                &user.perp_positions[0],
                oracle_price,
            )
            .unwrap();
        assert_eq!(base_asset_value, 150 * QUOTE_PRECISION);
        assert_eq!(unrealized_pnl, 100 * QUOTE_PRECISION_I128);

        let excess_pnl_pool = 49 * QUOTE_PRECISION_I128;
        let unsettled_pnl = user.perp_positions[0]
            .get_claimable_pnl(oracle_price, excess_pnl_pool)
            .unwrap();
        assert_eq!(unsettled_pnl, 99 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn long_positive_unrealized_pnl_less_than_max_pnl_to_settle() {
        let user = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -50 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 75 * PRICE_PRECISION_I64;
        let unsettled_pnl = user.perp_positions[0]
            .get_claimable_pnl(oracle_price, 0)
            .unwrap();
        assert_eq!(unsettled_pnl, 25 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn long_positive_unrealized_pnl_less_than_max_pnl_and_pool_excess_to_settle() {
        let user = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -50 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 75 * PRICE_PRECISION_I64;
        let unsettled_pnl = user.perp_positions[0]
            .get_claimable_pnl(oracle_price, QUOTE_PRECISION_I128)
            .unwrap();
        assert_eq!(unsettled_pnl, 25 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn long_no_negative_pnl_if_already_settled_to_oracle() {
        let user = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -150 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * PRICE_PRECISION_I64;
        let unsettled_pnl = user.perp_positions[0]
            .get_claimable_pnl(oracle_price, 0)
            .unwrap();
        assert_eq!(unsettled_pnl, 0);
    }

    #[test]
    fn short_negative_unrealized_pnl() {
        let user = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: -BASE_PRECISION_I64,
                quote_asset_amount: 100 * QUOTE_PRECISION_I64,
                quote_entry_amount: 100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * PRICE_PRECISION_I64;
        let unsettled_pnl = user.perp_positions[0]
            .get_claimable_pnl(oracle_price, 0)
            .unwrap();
        assert_eq!(unsettled_pnl, -50 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn short_positive_unrealized_pnl_more_than_max_pnl_to_settle() {
        let user = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: -BASE_PRECISION_I64,
                quote_asset_amount: 150 * QUOTE_PRECISION_I64,
                quote_entry_amount: 100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 50 * PRICE_PRECISION_I64;
        let unsettled_pnl = user.perp_positions[0]
            .get_claimable_pnl(oracle_price, 0)
            .unwrap();
        assert_eq!(unsettled_pnl, 50 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn short_positive_unrealized_pnl_less_than_max_pnl_to_settle() {
        let user = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: -BASE_PRECISION_I64,
                quote_asset_amount: 150 * QUOTE_PRECISION_I64,
                quote_entry_amount: 100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 125 * PRICE_PRECISION_I64;
        let unsettled_pnl = user.perp_positions[0]
            .get_claimable_pnl(oracle_price, 0)
            .unwrap();
        assert_eq!(unsettled_pnl, 25 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn short_no_negative_pnl_if_already_settled_to_oracle() {
        let user = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: -BASE_PRECISION_I64,
                quote_asset_amount: 150 * QUOTE_PRECISION_I64,
                quote_entry_amount: 100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * PRICE_PRECISION_I64;
        let unsettled_pnl = user.perp_positions[0]
            .get_claimable_pnl(oracle_price, 0)
            .unwrap();
        assert_eq!(unsettled_pnl, 0);
    }

    #[test]
    fn multiple_users_test_no_claimable() {
        let usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 1000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            ..SpotMarket::default()
        };

        let perp_market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 150_000,
                concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
                total_fee_minus_distributions: 1000 * QUOTE_PRECISION_I128,
                curve_update_intensity: 100,
                base_asset_amount_with_amm: AMM_RESERVE_PRECISION as i128,
                quote_asset_amount: -100 * QUOTE_PRECISION_I128,
                ..AMM::default()
            },
            pnl_pool: PoolBalance {
                scaled_balance: (10 * SPOT_BALANCE_PRECISION) as u128,
                market_index: QUOTE_SPOT_MARKET_INDEX,
                ..PoolBalance::default()
            },
            ..PerpMarket::default()
        };

        let user1 = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: -BASE_PRECISION_I64,
                quote_asset_amount: 150 * QUOTE_PRECISION_I64,
                quote_entry_amount: 100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let user2 = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -150 * QUOTE_PRECISION_I64,
                quote_entry_amount: -50 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -50 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let user3 = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let oracle_price = 150 * PRICE_PRECISION_I64;

        let pnl_pool_token_amount = get_token_amount(
            perp_market.pnl_pool.scaled_balance,
            &usdc_market,
            perp_market.pnl_pool.balance_type(),
        )
        .unwrap() as i128;
        assert_eq!(pnl_pool_token_amount, 10000000);

        let net_user_pnl = calculate_net_user_pnl(&perp_market.amm, oracle_price).unwrap();
        assert_eq!(net_user_pnl, 50000000);

        let max_pnl_pool_excess = if net_user_pnl < pnl_pool_token_amount {
            pnl_pool_token_amount
                .checked_sub(net_user_pnl.max(0))
                .unwrap()
        } else {
            0
        };
        assert_eq!(max_pnl_pool_excess, 0);

        let unsettled_pnl1 = user1.perp_positions[0]
            .get_claimable_pnl(oracle_price, max_pnl_pool_excess)
            .unwrap();
        assert_eq!(unsettled_pnl1, 0);

        let unsettled_pnl2 = user2.perp_positions[0]
            .get_claimable_pnl(oracle_price, max_pnl_pool_excess)
            .unwrap();
        assert_eq!(unsettled_pnl2, 0);

        let unsettled_pnl3 = user3.perp_positions[0]
            .get_claimable_pnl(oracle_price, max_pnl_pool_excess)
            .unwrap();
        assert_eq!(unsettled_pnl3, 0);
    }

    #[test]
    fn multiple_users_test_partially_claimable_from_pnl_pool_excess() {
        let usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 1000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            ..SpotMarket::default()
        };

        let mut perp_market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 150_000,
                concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
                total_fee_minus_distributions: 1000 * QUOTE_PRECISION_I128,
                curve_update_intensity: 100,
                base_asset_amount_with_amm: AMM_RESERVE_PRECISION as i128,
                quote_asset_amount: -99 * QUOTE_PRECISION_I128,
                ..AMM::default()
            },
            pnl_pool: PoolBalance {
                scaled_balance: (60 * SPOT_BALANCE_PRECISION) as u128,
                market_index: QUOTE_SPOT_MARKET_INDEX,
                ..PoolBalance::default()
            },
            ..PerpMarket::default()
        };

        let user1 = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: -BASE_PRECISION_I64,
                quote_asset_amount: 150 * QUOTE_PRECISION_I64,
                quote_entry_amount: 100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let user2 = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -149 * QUOTE_PRECISION_I64,
                quote_entry_amount: -150 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -150 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let user3 = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let oracle_price = 150 * PRICE_PRECISION_I64;

        let pnl_pool_token_amount = get_token_amount(
            perp_market.pnl_pool.scaled_balance,
            &usdc_market,
            perp_market.pnl_pool.balance_type(),
        )
        .unwrap() as i128;
        assert_eq!(pnl_pool_token_amount, 60000000);

        let net_user_pnl = calculate_net_user_pnl(&perp_market.amm, oracle_price).unwrap();
        assert_eq!(net_user_pnl, 51000000);

        let max_pnl_pool_excess = if net_user_pnl < pnl_pool_token_amount {
            pnl_pool_token_amount
                .checked_sub(net_user_pnl.max(0))
                .unwrap()
        } else {
            0
        };
        assert_eq!(max_pnl_pool_excess, 9_000_000);
        assert_eq!(max_pnl_pool_excess - net_user_pnl, -42_000_000);

        let unsettled_pnl1 = user1.perp_positions[0]
            .get_claimable_pnl(oracle_price, max_pnl_pool_excess)
            .unwrap();
        assert_eq!(
            user1.perp_positions[0]
                .get_unrealized_pnl(oracle_price)
                .unwrap(),
            0
        );
        assert_eq!(unsettled_pnl1, 0);

        let unsettled_pnl2 = user2.perp_positions[0]
            .get_claimable_pnl(oracle_price, max_pnl_pool_excess)
            .unwrap();
        assert_eq!(
            user2.perp_positions[0]
                .get_unrealized_pnl(oracle_price)
                .unwrap(),
            1_000_000
        );
        assert_eq!(unsettled_pnl2, 1_000_000);

        let unsettled_pnl3 = user3.perp_positions[0]
            .get_claimable_pnl(oracle_price, max_pnl_pool_excess)
            .unwrap();

        assert_eq!(
            user3.perp_positions[0]
                .get_unrealized_pnl(oracle_price)
                .unwrap(),
            50_000_000
        );
        assert_eq!(unsettled_pnl3, 9_000_000);

        perp_market.amm.quote_asset_amount = -100 * QUOTE_PRECISION_I128;
        let net_user_pnl = calculate_net_user_pnl(&perp_market.amm, oracle_price).unwrap();
        assert_eq!(net_user_pnl, 50000000);
        let max_pnl_pool_excess = if net_user_pnl < pnl_pool_token_amount {
            (pnl_pool_token_amount - QUOTE_PRECISION_I128)
                .checked_sub(net_user_pnl.max(0))
                .unwrap()
        } else {
            0
        };

        assert_eq!(max_pnl_pool_excess, 9_000_000);

        let unsettled_pnl3 = user3.perp_positions[0]
            .get_claimable_pnl(oracle_price, max_pnl_pool_excess)
            .unwrap();

        assert_eq!(
            user3.perp_positions[0]
                .get_unrealized_pnl(oracle_price)
                .unwrap(),
            50_000_000
        );
        assert_eq!(unsettled_pnl3, 9_000_000);
    }

    #[test]
    fn multiple_users_test_fully_claimable_from_pnl_pool_excess() {
        let usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 1000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            ..SpotMarket::default()
        };

        let perp_market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 150_000,
                concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
                total_fee_minus_distributions: 1000 * QUOTE_PRECISION_I128,
                curve_update_intensity: 100,
                base_asset_amount_with_amm: AMM_RESERVE_PRECISION as i128,
                quote_asset_amount: -100 * QUOTE_PRECISION_I128,
                ..AMM::default()
            },
            pnl_pool: PoolBalance {
                scaled_balance: (1000 * SPOT_BALANCE_PRECISION) as u128,
                market_index: 0,
                ..PoolBalance::default()
            },
            ..PerpMarket::default()
        };

        let user1 = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: -BASE_PRECISION_I64,
                quote_asset_amount: 150 * QUOTE_PRECISION_I64,
                quote_entry_amount: 100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let user2 = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -150 * QUOTE_PRECISION_I64,
                quote_entry_amount: -160 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -160 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let user3 = User {
            perp_positions: get_positions(PerpPosition {
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let oracle_price = 160 * PRICE_PRECISION_I64;

        let pnl_pool_token_amount = get_token_amount(
            perp_market.pnl_pool.scaled_balance,
            &usdc_market,
            perp_market.pnl_pool.balance_type(),
        )
        .unwrap() as i128;
        assert_eq!(pnl_pool_token_amount, 1000000000);

        let net_user_pnl = calculate_net_user_pnl(&perp_market.amm, oracle_price).unwrap();
        assert_eq!(net_user_pnl, 60000000);

        let max_pnl_pool_excess = if net_user_pnl < pnl_pool_token_amount {
            pnl_pool_token_amount
                .checked_sub(net_user_pnl.max(0))
                .unwrap()
        } else {
            0
        };
        assert_eq!(max_pnl_pool_excess, 940000000);
        assert_eq!(max_pnl_pool_excess - net_user_pnl, 880000000);

        let unsettled_pnl1 = user1.perp_positions[0]
            .get_claimable_pnl(oracle_price, max_pnl_pool_excess)
            .unwrap();
        assert_eq!(
            user1.perp_positions[0]
                .get_unrealized_pnl(oracle_price)
                .unwrap(),
            -10000000
        );
        assert_eq!(unsettled_pnl1, -10000000);

        let unsettled_pnl2 = user2.perp_positions[0]
            .get_claimable_pnl(oracle_price, max_pnl_pool_excess)
            .unwrap();
        assert_eq!(
            user2.perp_positions[0]
                .get_unrealized_pnl(oracle_price)
                .unwrap(),
            10000000
        );
        assert_eq!(unsettled_pnl2, 10000000);

        let unsettled_pnl3 = user3.perp_positions[0]
            .get_claimable_pnl(oracle_price, max_pnl_pool_excess)
            .unwrap();

        assert_eq!(
            user3.perp_positions[0]
                .get_unrealized_pnl(oracle_price)
                .unwrap(),
            60000000
        );
        assert_eq!(unsettled_pnl3, 60000000);
    }
}

mod get_worst_case_token_amount {
    use crate::math::constants::{
        PRICE_PRECISION_I64, QUOTE_PRECISION_I128, SPOT_BALANCE_PRECISION_U64,
        SPOT_CUMULATIVE_INTEREST_PRECISION,
    };
    use crate::state::oracle::{OraclePriceData, OracleSource};
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::user::SpotPosition;

    #[test]
    fn no_token_open_bid() {
        let spot_position = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 0,
            open_orders: 1,
            open_bids: 10_i64.pow(9),
            open_asks: 0,
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_orders_value) = spot_position
            .get_worst_case_token_amount(&spot_market, &oracle_price_data, None, None)
            .unwrap();

        assert_eq!(worst_case_token_amount, 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, -100 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn no_token_open_ask() {
        let spot_position = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 0,
            open_orders: 1,
            open_bids: 0,
            open_asks: -(10_i64.pow(9)),
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_orders_value) = spot_position
            .get_worst_case_token_amount(&spot_market, &oracle_price_data, None, None)
            .unwrap();

        assert_eq!(worst_case_token_amount, -(10_i128.pow(9)));
        assert_eq!(worst_case_orders_value, 100 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn deposit_and_open_ask() {
        let spot_position = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 2 * SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_bids: 0,
            open_asks: -(10_i64.pow(9)),
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_orders_value) = spot_position
            .get_worst_case_token_amount(&spot_market, &oracle_price_data, None, None)
            .unwrap();

        assert_eq!(worst_case_token_amount, 2 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, 0);
    }

    #[test]
    fn deposit_and_open_ask_flips_to_borrow() {
        let spot_position = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_bids: 0,
            open_asks: -2 * 10_i64.pow(9),
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_orders_value) = spot_position
            .get_worst_case_token_amount(&spot_market, &oracle_price_data, None, None)
            .unwrap();

        assert_eq!(worst_case_token_amount, -(10_i128.pow(9)));
        assert_eq!(worst_case_orders_value, 200 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn deposit_and_open_bid() {
        let spot_position = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 2 * SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_bids: 0,
            open_asks: 10_i64.pow(9),
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_orders_value) = spot_position
            .get_worst_case_token_amount(&spot_market, &oracle_price_data, None, None)
            .unwrap();

        assert_eq!(worst_case_token_amount, 3 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, -100 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn borrow_and_open_bid() {
        let spot_position = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: 2 * SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_bids: 10_i64.pow(9),
            open_asks: 0,
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_orders_value) = spot_position
            .get_worst_case_token_amount(&spot_market, &oracle_price_data, None, None)
            .unwrap();

        assert_eq!(worst_case_token_amount, -2 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, 0);
    }

    #[test]
    fn borrow_and_open_bid_flips_to_deposit() {
        let spot_position = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: 2 * SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_bids: 5 * 10_i64.pow(9),
            open_asks: 0,
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_orders_value) = spot_position
            .get_worst_case_token_amount(&spot_market, &oracle_price_data, None, None)
            .unwrap();

        assert_eq!(worst_case_token_amount, 3 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, -500 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn borrow_and_open_ask() {
        let spot_position = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: 2 * SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_bids: 0,
            open_asks: -(10_i64.pow(9)),
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_orders_value) = spot_position
            .get_worst_case_token_amount(&spot_market, &oracle_price_data, None, None)
            .unwrap();

        assert_eq!(worst_case_token_amount, -3 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, 100 * QUOTE_PRECISION_I128);
    }
}

mod get_base_asset_amount_unfilled {
    use crate::controller::position::PositionDirection;
    use crate::state::user::Order;

    #[test]
    fn existing_position_is_none() {
        let order = Order {
            base_asset_amount: 1,
            base_asset_amount_filled: 0,
            ..Order::default()
        };

        assert_eq!(order.get_base_asset_amount_unfilled(None).unwrap(), 1)
    }

    #[test]
    fn order_is_not_reduce_only() {
        let order = Order {
            base_asset_amount: 1,
            base_asset_amount_filled: 0,
            reduce_only: false,
            ..Order::default()
        };

        assert_eq!(order.get_base_asset_amount_unfilled(Some(1)).unwrap(), 1)
    }

    #[test]
    fn order_is_reduce_only_and_post_only() {
        let order = Order {
            base_asset_amount: 1,
            base_asset_amount_filled: 0,
            reduce_only: true,
            post_only: true,
            ..Order::default()
        };

        assert_eq!(order.get_base_asset_amount_unfilled(Some(1)).unwrap(), 1)
    }

    #[test]
    fn no_existing_position() {
        let order = Order {
            base_asset_amount: 1,
            base_asset_amount_filled: 0,
            reduce_only: true,
            ..Order::default()
        };

        assert_eq!(order.get_base_asset_amount_unfilled(Some(0)).unwrap(), 0)
    }

    #[test]
    fn bid_with_long_existing_position() {
        let order = Order {
            base_asset_amount: 1,
            base_asset_amount_filled: 0,
            reduce_only: true,
            direction: PositionDirection::Long,
            ..Order::default()
        };

        assert_eq!(order.get_base_asset_amount_unfilled(Some(1)).unwrap(), 0)
    }

    #[test]
    fn bid_with_smaller_short_existing_position() {
        let order = Order {
            base_asset_amount: 5,
            base_asset_amount_filled: 0,
            reduce_only: true,
            direction: PositionDirection::Long,
            ..Order::default()
        };

        assert_eq!(order.get_base_asset_amount_unfilled(Some(-3)).unwrap(), 3)
    }

    #[test]
    fn bid_with_larger_short_existing_position() {
        let order = Order {
            base_asset_amount: 5,
            base_asset_amount_filled: 0,
            reduce_only: true,
            direction: PositionDirection::Long,
            ..Order::default()
        };

        assert_eq!(order.get_base_asset_amount_unfilled(Some(-6)).unwrap(), 5)
    }

    #[test]
    fn ask_with_short_existing_position() {
        let order = Order {
            base_asset_amount: 1,
            base_asset_amount_filled: 0,
            reduce_only: true,
            direction: PositionDirection::Short,
            ..Order::default()
        };

        assert_eq!(order.get_base_asset_amount_unfilled(Some(-1)).unwrap(), 0)
    }

    #[test]
    fn ask_with_smaller_long_existing_position() {
        let order = Order {
            base_asset_amount: 5,
            base_asset_amount_filled: 0,
            reduce_only: true,
            direction: PositionDirection::Short,
            ..Order::default()
        };

        assert_eq!(order.get_base_asset_amount_unfilled(Some(3)).unwrap(), 3)
    }

    #[test]
    fn ask_with_larger_long_existing_position() {
        let order = Order {
            base_asset_amount: 5,
            base_asset_amount_filled: 0,
            reduce_only: true,
            direction: PositionDirection::Short,
            ..Order::default()
        };

        assert_eq!(order.get_base_asset_amount_unfilled(Some(6)).unwrap(), 5)
    }
}

mod open_orders {
    use crate::state::user::User;

    #[test]
    fn test() {
        let mut user = User::default();

        user.increment_open_orders(false);

        assert_eq!(user.open_orders, 1);
        assert!(user.has_open_order);
        assert_eq!(user.open_auctions, 0);
        assert!(!user.has_open_auction);

        user.increment_open_orders(true);

        assert_eq!(user.open_orders, 2);
        assert!(user.has_open_order);
        assert_eq!(user.open_auctions, 1);
        assert!(user.has_open_auction);

        user.decrement_open_orders(false);

        assert_eq!(user.open_orders, 1);
        assert!(user.has_open_order);
        assert_eq!(user.open_auctions, 1);
        assert!(user.has_open_auction);

        user.decrement_open_orders(true);

        assert_eq!(user.open_orders, 0);
        assert!(!user.has_open_order);
        assert_eq!(user.open_auctions, 0);
        assert!(!user.has_open_auction);
    }
}

mod qualifies_for_withdraw_fee {
    use crate::state::user::{User, UserFees, UserStats};
    use crate::QUOTE_PRECISION_U64;

    #[test]
    fn test() {
        let user = User::default();
        let user_stats = UserStats::default();

        let qualifies = user.qualifies_for_withdraw_fee(&user_stats);

        assert!(!qualifies);

        let user = User {
            total_withdraws: 9_999_999 * QUOTE_PRECISION_U64,
            ..User::default()
        };

        let qualifies = user.qualifies_for_withdraw_fee(&user_stats);

        assert!(!qualifies);

        let user = User {
            total_withdraws: 10_000_000 * QUOTE_PRECISION_U64,
            ..User::default()
        };

        let user_stats = UserStats {
            fees: UserFees {
                total_fee_paid: 1_000 * QUOTE_PRECISION_U64,
                ..UserFees::default()
            },
            ..UserStats::default()
        };

        let qualifies = user.qualifies_for_withdraw_fee(&user_stats);

        assert!(!qualifies);

        let user = User {
            total_withdraws: 10_000_000 * QUOTE_PRECISION_U64,
            ..User::default()
        };

        let user_stats = UserStats {
            fees: UserFees {
                total_fee_paid: 999 * QUOTE_PRECISION_U64,
                ..UserFees::default()
            },
            ..UserStats::default()
        };

        let qualifies = user.qualifies_for_withdraw_fee(&user_stats);

        assert!(qualifies);
    }
}
