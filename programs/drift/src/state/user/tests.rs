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
                scaled_balance: (10 * SPOT_BALANCE_PRECISION),
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
                scaled_balance: (60 * SPOT_BALANCE_PRECISION),
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
                scaled_balance: (1000 * SPOT_BALANCE_PRECISION),
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

mod get_worst_case_fill_simulation {
    use crate::math::constants::{
        PRICE_PRECISION_I64, QUOTE_PRECISION_I128, SPOT_BALANCE_PRECISION_U64,
    };
    use crate::math::margin::MarginRequirementType;
    use crate::state::oracle::{OraclePriceData, StrictOraclePrice};
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::user::{OrderFillSimulation, SpotPosition};

    #[test]
    fn no_token_open_bid() {
        let spot_position = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 0,
            open_orders: 1,
            open_bids: 10_i64.pow(9),
            open_asks: 0,
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket::default_base_market();

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: None,
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, -100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, 100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, 80 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -20 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(110 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, -110 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, 110 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, 88 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -22 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(90 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, -100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, 100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, 80 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -20 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn no_token_open_ask() {
        let spot_position = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 0,
            open_orders: 1,
            open_bids: 0,
            open_asks: -(10_i64.pow(9)),
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket::default_base_market();

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: None,
        };

        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, -(10_i128.pow(9)));
        assert_eq!(worst_case_orders_value, 100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, -100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, -120 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -20 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(110 * PRICE_PRECISION_I64),
        };

        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, -(10_i128.pow(9)));
        assert_eq!(worst_case_orders_value, 110 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, -110 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, -132 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -22 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(90 * PRICE_PRECISION_I64),
        };

        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, -(10_i128.pow(9)));
        assert_eq!(worst_case_orders_value, 100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, -100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, -120 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -20 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn deposit_and_open_ask() {
        let spot_position = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 2 * SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_bids: 0,
            open_asks: -(10_i64.pow(9)),
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket::default_base_market();

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: None,
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, 2 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, 0);
        assert_eq!(worst_case_token_value, 200 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, 160 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, 160 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(110 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, 2 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, 0);
        assert_eq!(worst_case_token_value, 200 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, 160 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, 160 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(90 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, 2 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, 0);
        assert_eq!(worst_case_token_value, 180 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, 144 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, 144 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn deposit_and_open_ask_flips_to_borrow() {
        let spot_position = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_bids: 0,
            open_asks: -2 * 10_i64.pow(9),
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket::default_base_market();

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: None,
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, -(10_i128.pow(9)));
        assert_eq!(worst_case_orders_value, 200 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, -100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, -120 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, 80 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(110 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, -(10_i128.pow(9)));
        assert_eq!(worst_case_orders_value, 220 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, -120 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, -144 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, 76 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(90 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, -(10_i128.pow(9)));
        assert_eq!(worst_case_orders_value, 200 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, -110 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, -132 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, 68 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn deposit_and_open_bid() {
        let spot_position = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 2 * SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_bids: 10_i64.pow(9),
            open_asks: 0,
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket::default_base_market();

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: None,
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, 3 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, -100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, 300 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, 240 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, 140 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(110 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, 3 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, -110 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, 310 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, 248 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, 138 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(90 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, 3 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, -100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, 280 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, 224 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, 124 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn borrow_and_open_bid() {
        let spot_position = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: 2 * SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_bids: 10_i64.pow(9),
            open_asks: 0,
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket::default_base_market();

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: None,
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, -2 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, 0);
        assert_eq!(worst_case_token_value, -200 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, -240 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -240 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(110 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, -2 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, 0);
        assert_eq!(worst_case_token_value, -220 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, -264 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -264 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(90 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, -2 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, 0);
        assert_eq!(worst_case_token_value, -200 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, -240 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -240 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn borrow_and_open_bid_flips_to_deposit() {
        let spot_position = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: 2 * SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_bids: 5 * 10_i64.pow(9),
            open_asks: 0,
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket::default_base_market();

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: None,
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, 3 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, -500 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, 300 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, 240 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -260 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(110 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, 3 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, -550 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, 330 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, 264 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -286 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(90 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, 3 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, -500 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, 300 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, 240 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -260 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn borrow_and_open_ask() {
        let spot_position = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: 2 * SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_bids: 0,
            open_asks: -(10_i64.pow(9)),
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket::default_base_market();

        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: None,
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, -3 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, 100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, -300 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, -360 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -260 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(110 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, -3 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, 110 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, -330 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, -396 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -286 * QUOTE_PRECISION_I128);

        let strict_price = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(90 * PRICE_PRECISION_I64),
        };
        let OrderFillSimulation {
            token_amount: worst_case_token_amount,
            orders_value: worst_case_orders_value,
            token_value: worst_case_token_value,
            weighted_token_value: worst_case_weighted_token_value,
            free_collateral_contribution,
        } = spot_position
            .get_worst_case_fill_simulation(
                &spot_market,
                &strict_price,
                None,
                MarginRequirementType::Initial,
            )
            .unwrap();

        assert_eq!(worst_case_token_amount, -3 * 10_i128.pow(9));
        assert_eq!(worst_case_orders_value, 100 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_token_value, -300 * QUOTE_PRECISION_I128);
        assert_eq!(worst_case_weighted_token_value, -360 * QUOTE_PRECISION_I128);
        assert_eq!(free_collateral_contribution, -260 * QUOTE_PRECISION_I128);
    }
}

mod apply_user_custom_margin_ratio {
    use crate::math::constants::{PRICE_PRECISION_I64, QUOTE_PRECISION_I128};
    use crate::state::spot_market::SpotMarket;
    use crate::state::user::OrderFillSimulation;
    use crate::MARGIN_PRECISION;

    #[test]
    fn test() {
        let sol = SpotMarket::default_base_market();
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let custom_margin_ratio = MARGIN_PRECISION / 2; // 2x
        let deposit = OrderFillSimulation {
            token_value: 100 * QUOTE_PRECISION_I128,
            weighted_token_value: 80 * QUOTE_PRECISION_I128,
            free_collateral_contribution: 80 * QUOTE_PRECISION_I128,
            ..OrderFillSimulation::default()
        };

        let expected = OrderFillSimulation {
            token_value: 100 * QUOTE_PRECISION_I128,
            weighted_token_value: 50 * QUOTE_PRECISION_I128,
            free_collateral_contribution: 50 * QUOTE_PRECISION_I128,
            ..OrderFillSimulation::default()
        };

        let actual = deposit
            .apply_user_custom_margin_ratio(&sol, oracle_price, custom_margin_ratio)
            .unwrap();

        assert_eq!(actual, expected);

        let borrow = OrderFillSimulation {
            token_value: -100 * QUOTE_PRECISION_I128,
            weighted_token_value: -120 * QUOTE_PRECISION_I128,
            free_collateral_contribution: -120 * QUOTE_PRECISION_I128,
            ..OrderFillSimulation::default()
        };

        let expected = OrderFillSimulation {
            token_value: -100 * QUOTE_PRECISION_I128,
            weighted_token_value: -150 * QUOTE_PRECISION_I128,
            free_collateral_contribution: -150 * QUOTE_PRECISION_I128,
            ..OrderFillSimulation::default()
        };

        let actual = borrow
            .apply_user_custom_margin_ratio(&sol, oracle_price, custom_margin_ratio)
            .unwrap();

        assert_eq!(actual, expected);

        let bid = OrderFillSimulation {
            token_value: 100 * QUOTE_PRECISION_I128,
            weighted_token_value: 80 * QUOTE_PRECISION_I128,
            orders_value: -100 * QUOTE_PRECISION_I128,
            free_collateral_contribution: -20 * QUOTE_PRECISION_I128,
            ..OrderFillSimulation::default()
        };

        let expected = OrderFillSimulation {
            token_value: 100 * QUOTE_PRECISION_I128,
            weighted_token_value: 50 * QUOTE_PRECISION_I128,
            free_collateral_contribution: -50 * QUOTE_PRECISION_I128,
            orders_value: -100 * QUOTE_PRECISION_I128,
            ..OrderFillSimulation::default()
        };

        let actual = bid
            .apply_user_custom_margin_ratio(&sol, oracle_price, custom_margin_ratio)
            .unwrap();

        assert_eq!(actual, expected);

        let ask = OrderFillSimulation {
            token_value: -100 * QUOTE_PRECISION_I128,
            weighted_token_value: -120 * QUOTE_PRECISION_I128,
            free_collateral_contribution: -20 * QUOTE_PRECISION_I128,
            orders_value: 100 * QUOTE_PRECISION_I128,
            ..OrderFillSimulation::default()
        };

        let expected = OrderFillSimulation {
            token_value: -100 * QUOTE_PRECISION_I128,
            weighted_token_value: -150 * QUOTE_PRECISION_I128,
            free_collateral_contribution: -50 * QUOTE_PRECISION_I128,
            orders_value: 100 * QUOTE_PRECISION_I128,
            ..OrderFillSimulation::default()
        };

        let actual = ask
            .apply_user_custom_margin_ratio(&sol, oracle_price, custom_margin_ratio)
            .unwrap();

        assert_eq!(actual, expected);

        let no_custom_margin_ratio = OrderFillSimulation {
            token_value: -100 * QUOTE_PRECISION_I128,
            weighted_token_value: -120 * QUOTE_PRECISION_I128,
            free_collateral_contribution: -20 * QUOTE_PRECISION_I128,
            orders_value: 100 * QUOTE_PRECISION_I128,
            ..OrderFillSimulation::default()
        };

        let expected = no_custom_margin_ratio;

        let actual = no_custom_margin_ratio
            .apply_user_custom_margin_ratio(&sol, oracle_price, 0)
            .unwrap();

        assert_eq!(actual, expected);
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

        let qualifies = user.qualifies_for_withdraw_fee(&user_stats, 0);

        assert!(!qualifies);

        let user = User {
            total_withdraws: 9_999_999 * QUOTE_PRECISION_U64,
            ..User::default()
        };

        let qualifies = user.qualifies_for_withdraw_fee(&user_stats, 0);

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

        let qualifies = user.qualifies_for_withdraw_fee(&user_stats, 0);

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

        let qualifies = user.qualifies_for_withdraw_fee(&user_stats, 0);

        assert!(qualifies);

        // fee
        let user = User {
            total_withdraws: 13_000_000 * QUOTE_PRECISION_U64,
            last_active_slot: 8900877,
            ..User::default()
        };

        let user_stats = UserStats {
            fees: UserFees {
                total_fee_paid: QUOTE_PRECISION_U64,
                ..UserFees::default()
            },
            ..UserStats::default()
        };

        let qualifies = user.qualifies_for_withdraw_fee(&user_stats, user.last_active_slot + 1);

        assert!(qualifies);

        let qualifies = user.qualifies_for_withdraw_fee(&user_stats, user.last_active_slot + 50);

        assert!(!qualifies);
    }
}

mod update_user_status {
    use crate::state::user::{User, UserStatus};

    #[test]
    fn test() {
        let mut user = User::default();
        assert_eq!(user.status, 0);

        user.enter_liquidation(0).unwrap();

        assert_eq!(user.status, UserStatus::BeingLiquidated as u8);
        assert!(user.is_being_liquidated());

        user.enter_bankruptcy();

        assert_eq!(user.status, UserStatus::Bankrupt as u8);
        assert!(user.is_being_liquidated());
        assert!(user.is_bankrupt());

        let mut user = User {
            status: UserStatus::ReduceOnly as u8,
            ..User::default()
        };

        user.enter_liquidation(0).unwrap();

        assert!(user.is_being_liquidated());
        assert!(user.status & UserStatus::ReduceOnly as u8 > 0);

        user.enter_bankruptcy();

        assert!(user.is_being_liquidated());
        assert!(user.is_bankrupt());
        assert!(user.status & UserStatus::ReduceOnly as u8 > 0);

        user.exit_liquidation();
        assert!(!user.is_being_liquidated());
        assert!(!user.is_bankrupt());
        assert!(user.status & UserStatus::ReduceOnly as u8 > 0);
    }
}

mod resting_limit_order {
    use crate::state::user::{Order, OrderType};
    use crate::PositionDirection;

    #[test]
    fn test() {
        let order = Order {
            order_type: OrderType::Market,
            ..Order::default()
        };
        let slot = 0;

        assert!(!order.is_resting_limit_order(slot).unwrap());

        let order = Order {
            order_type: OrderType::TriggerMarket,
            ..Order::default()
        };

        assert!(!order.is_resting_limit_order(slot).unwrap());

        let order = Order {
            order_type: OrderType::Oracle,
            ..Order::default()
        };

        assert!(!order.is_resting_limit_order(slot).unwrap());

        // limit order before end of auction
        let order = Order {
            order_type: OrderType::Limit,
            post_only: false,
            auction_duration: 10,
            slot: 1,
            ..Order::default()
        };
        let slot = 2;

        assert!(!order.is_resting_limit_order(slot).unwrap());

        // limit order after end of auction
        let order = Order {
            order_type: OrderType::Limit,
            post_only: false,
            auction_duration: 10,
            slot: 1,
            ..Order::default()
        };
        let slot = 12;

        assert!(order.is_resting_limit_order(slot).unwrap());

        // limit order post only
        let order = Order {
            order_type: OrderType::Limit,
            post_only: true,
            ..Order::default()
        };
        let slot = 1;

        assert!(order.is_resting_limit_order(slot).unwrap());

        // trigger order long crosses trigger, auction complete
        let order = Order {
            order_type: OrderType::TriggerLimit,
            direction: PositionDirection::Long,
            trigger_price: 100,
            price: 110,
            slot: 1,
            auction_duration: 10,
            ..Order::default()
        };

        let slot = 12;

        assert!(!order.is_resting_limit_order(slot).unwrap());

        // trigger order long doesnt cross trigger, auction complete
        let order = Order {
            order_type: OrderType::TriggerLimit,
            direction: PositionDirection::Long,
            trigger_price: 100,
            price: 90,
            slot: 1,
            auction_duration: 10,
            ..Order::default()
        };

        let slot = 12;

        assert!(order.is_resting_limit_order(slot).unwrap());

        // trigger order short crosses trigger, auction complete
        let order = Order {
            order_type: OrderType::TriggerLimit,
            direction: PositionDirection::Short,
            trigger_price: 100,
            price: 90,
            slot: 1,
            auction_duration: 10,
            ..Order::default()
        };

        let slot = 12;

        assert!(!order.is_resting_limit_order(slot).unwrap());

        // trigger order long doesnt cross trigger, auction complete
        let order = Order {
            order_type: OrderType::TriggerLimit,
            direction: PositionDirection::Short,
            trigger_price: 100,
            price: 110,
            slot: 1,
            auction_duration: 10,
            ..Order::default()
        };

        let slot = 12;

        assert!(order.is_resting_limit_order(slot).unwrap());
    }
}

mod get_user_stats_age_ts {
    use crate::state::user::UserStats;

    #[test]
    fn test() {
        let user_stats = UserStats::default();

        let now = 1;

        let age = user_stats.get_age_ts(now);

        assert_eq!(age, 1);

        let user_stats = UserStats {
            last_filler_volume_30d_ts: 2,
            last_maker_volume_30d_ts: 3,
            last_taker_volume_30d_ts: 4,
            ..UserStats::default()
        };

        let now = 5;
        let age = user_stats.get_age_ts(now);
        assert_eq!(age, 3);

        let now = 1;
        let age = user_stats.get_age_ts(now);
        assert_eq!(age, 0);
    }
}

mod fuel {
    use crate::state::user::UserStats;
    use crate::QUOTE_PRECISION_U64;

    #[test]
    fn test() {
        let mut user_stats = UserStats::default();

        user_stats
            .update_fuel_maker_bonus(0, QUOTE_PRECISION_U64)
            .unwrap();

        assert_eq!(user_stats.fuel_maker, 0);

        user_stats
            .update_fuel_maker_bonus(1, QUOTE_PRECISION_U64)
            .unwrap();

        assert_eq!(user_stats.fuel_maker, 1);

        user_stats
            .update_fuel_taker_bonus(0, QUOTE_PRECISION_U64)
            .unwrap();

        assert_eq!(user_stats.fuel_taker, 0);

        user_stats
            .update_fuel_taker_bonus(1, QUOTE_PRECISION_U64)
            .unwrap();

        assert_eq!(user_stats.fuel_taker, 1);
    }
}

mod worst_case_liability_value {
    use crate::state::perp_market::ContractType;
    use crate::state::user::PerpPosition;
    use crate::{
        BASE_PRECISION_I128, BASE_PRECISION_I64, MAX_PREDICTION_MARKET_PRICE_I64,
        MAX_PREDICTION_MARKET_PRICE_U128, PRICE_PRECISION_I64, QUOTE_PRECISION,
    };

    #[test]
    fn prediction() {
        let contract_type = ContractType::Prediction;
        let position = PerpPosition {
            base_asset_amount: 0,
            open_bids: BASE_PRECISION_I64,
            open_asks: -BASE_PRECISION_I64,
            ..PerpPosition::default()
        };

        let price = MAX_PREDICTION_MARKET_PRICE_I64 * 3 / 4;

        let (worst_case_base_asset_amount, worst_case_loss) = position
            .worst_case_liability_value(price, contract_type)
            .unwrap();

        assert_eq!(worst_case_base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(worst_case_loss, MAX_PREDICTION_MARKET_PRICE_U128 * 3 / 4);

        let price = MAX_PREDICTION_MARKET_PRICE_I64 / 4;

        let (worst_case_base_asset_amount, worst_case_loss) = position
            .worst_case_liability_value(price, contract_type)
            .unwrap();

        assert_eq!(worst_case_base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(worst_case_loss, MAX_PREDICTION_MARKET_PRICE_U128 * 3 / 4);

        let position = PerpPosition {
            base_asset_amount: 98 * BASE_PRECISION_I64,
            open_bids: 0,
            open_asks: -99 * BASE_PRECISION_I64,
            ..PerpPosition::default()
        };

        let price = MAX_PREDICTION_MARKET_PRICE_I64 / 100;

        let (worst_case_base_asset_amount, worst_case_loss) = position
            .worst_case_liability_value(price, contract_type)
            .unwrap();

        assert_eq!(worst_case_base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(worst_case_loss, MAX_PREDICTION_MARKET_PRICE_U128 * 99 / 100);

        let position = PerpPosition {
            base_asset_amount: -98 * BASE_PRECISION_I64,
            open_bids: 99 * BASE_PRECISION_I64,
            open_asks: 0,
            ..PerpPosition::default()
        };

        let price = MAX_PREDICTION_MARKET_PRICE_I64 * 99 / 100;

        let (worst_case_base_asset_amount, worst_case_loss) = position
            .worst_case_liability_value(price, contract_type)
            .unwrap();

        assert_eq!(worst_case_base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(worst_case_loss, MAX_PREDICTION_MARKET_PRICE_U128 * 99 / 100);
    }

    #[test]
    fn perp() {
        let contract_type = ContractType::Perpetual;
        let position = PerpPosition {
            base_asset_amount: 0,
            open_bids: BASE_PRECISION_I64,
            open_asks: -BASE_PRECISION_I64,
            ..PerpPosition::default()
        };

        let price = 100 * PRICE_PRECISION_I64;

        let (worst_case_base_asset_amount, worst_case_liability) = position
            .worst_case_liability_value(price, contract_type)
            .unwrap();

        assert_eq!(worst_case_base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(worst_case_liability, 100 * QUOTE_PRECISION);

        let contract_type = ContractType::Perpetual;
        let position = PerpPosition {
            base_asset_amount: 0,
            open_bids: 2 * BASE_PRECISION_I64,
            open_asks: -BASE_PRECISION_I64,
            ..PerpPosition::default()
        };

        let price = 100 * PRICE_PRECISION_I64;

        let (worst_case_base_asset_amount, worst_case_liability) = position
            .worst_case_liability_value(price, contract_type)
            .unwrap();

        assert_eq!(worst_case_base_asset_amount, 2 * BASE_PRECISION_I128);
        assert_eq!(worst_case_liability, 200 * QUOTE_PRECISION);

        let position = PerpPosition {
            base_asset_amount: 98 * BASE_PRECISION_I64,
            open_bids: 0,
            open_asks: -99 * BASE_PRECISION_I64,
            ..PerpPosition::default()
        };

        let price = 100 * PRICE_PRECISION_I64;

        let (worst_case_base_asset_amount, worst_case_loss) = position
            .worst_case_liability_value(price, contract_type)
            .unwrap();

        assert_eq!(worst_case_base_asset_amount, 98 * BASE_PRECISION_I128);
        assert_eq!(worst_case_loss, 98 * 100 * QUOTE_PRECISION);

        let position = PerpPosition {
            base_asset_amount: -98 * BASE_PRECISION_I64,
            open_bids: 99 * BASE_PRECISION_I64,
            open_asks: 0,
            ..PerpPosition::default()
        };

        let price = 100 * PRICE_PRECISION_I64;

        let (worst_case_base_asset_amount, worst_case_loss) = position
            .worst_case_liability_value(price, contract_type)
            .unwrap();

        assert_eq!(worst_case_base_asset_amount, -98 * BASE_PRECISION_I128);
        assert_eq!(worst_case_loss, 98 * 100 * QUOTE_PRECISION);
    }
}
