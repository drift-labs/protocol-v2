mod calculate_base_asset_amount_to_cover_margin_shortage {
    use crate::math::constants::{
        AMM_TO_QUOTE_PRECISION_RATIO, BASE_PRECISION_U64, LIQUIDATION_FEE_PRECISION,
        LIQUIDATION_FEE_PRECISION_U128, MARGIN_PRECISION, MARGIN_PRECISION_U128, PRICE_PRECISION,
        PRICE_PRECISION_I64, QUOTE_PRECISION,
    };
    use crate::math::liquidation::calculate_base_asset_amount_to_cover_margin_shortage;

    #[test]
    pub fn zero_percent_liquidation_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let margin_ratio = MARGIN_PRECISION as u32 / 10; // 10x leverage
        let liquidation_fee = 0; // 0 percent
        let oracle_price = 100 * PRICE_PRECISION_I64; // $100 / base
        let base_asset_amount = calculate_base_asset_amount_to_cover_margin_shortage(
            margin_shortage,
            margin_ratio,
            liquidation_fee,
            0,
            oracle_price,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION_U64); // must lose 1 base
    }

    #[test]
    pub fn one_percent_liquidation_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let margin_ratio = MARGIN_PRECISION as u32 / 10; // 10x leverage
        let liquidation_fee = LIQUIDATION_FEE_PRECISION / 100; // 1 percent
        let oracle_price = 100 * PRICE_PRECISION_I64; // $100 / base
        let base_asset_amount = calculate_base_asset_amount_to_cover_margin_shortage(
            margin_shortage,
            margin_ratio,
            liquidation_fee,
            0,
            oracle_price,
        )
        .unwrap();

        let freed_collateral = (base_asset_amount as u128) * (oracle_price as u128)
            / PRICE_PRECISION
            / AMM_TO_QUOTE_PRECISION_RATIO
            * margin_ratio as u128
            / MARGIN_PRECISION_U128;

        let negative_pnl = (base_asset_amount as u128) * (oracle_price as u128)
            / PRICE_PRECISION
            / AMM_TO_QUOTE_PRECISION_RATIO
            * liquidation_fee as u128
            / LIQUIDATION_FEE_PRECISION_U128;

        assert_eq!(freed_collateral - negative_pnl, 10000000); // ~$10

        assert_eq!(base_asset_amount, BASE_PRECISION_U64 * 10 / 9); // must lose 10/9 base
    }

    #[test]
    pub fn one_percent_liquidation_fee_and_one_percent_if_liquidation_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let margin_ratio = MARGIN_PRECISION as u32 / 10; // 10x leverage
        let liquidation_fee = LIQUIDATION_FEE_PRECISION / 100; // 1 percent
        let oracle_price = 100 * PRICE_PRECISION_I64; // $100 / base
        let if_liquidation_fee = LIQUIDATION_FEE_PRECISION / 100; // 1 percent
        let base_asset_amount = calculate_base_asset_amount_to_cover_margin_shortage(
            margin_shortage,
            margin_ratio,
            liquidation_fee,
            if_liquidation_fee,
            oracle_price,
        )
        .unwrap();

        let if_fee = (base_asset_amount as u128) * (oracle_price as u128)
            / PRICE_PRECISION
            / AMM_TO_QUOTE_PRECISION_RATIO
            * if_liquidation_fee as u128
            / LIQUIDATION_FEE_PRECISION_U128;

        let freed_collateral = (base_asset_amount as u128) * (oracle_price as u128)
            / PRICE_PRECISION
            / AMM_TO_QUOTE_PRECISION_RATIO
            * margin_ratio as u128
            / MARGIN_PRECISION_U128;

        let negative_pnl = (base_asset_amount as u128) * (oracle_price as u128)
            / PRICE_PRECISION
            / AMM_TO_QUOTE_PRECISION_RATIO
            * liquidation_fee as u128
            / LIQUIDATION_FEE_PRECISION_U128;

        let if_fee_consume_collateral = if_fee;

        assert_eq!(
            freed_collateral - negative_pnl - if_fee_consume_collateral,
            10000000 // ~$10
        );

        assert_eq!(base_asset_amount, 1250000000); // must lose 10/9 base
    }
}

mod calculate_liability_transfer_to_cover_margin_shortage {
    use crate::math::constants::{
        LIQUIDATION_FEE_PRECISION, LIQUIDATION_FEE_PRECISION_U128, PRICE_PRECISION,
        PRICE_PRECISION_I64, QUOTE_PRECISION, SPOT_WEIGHT_PRECISION, SPOT_WEIGHT_PRECISION_U128,
    };
    use crate::math::liquidation::calculate_liability_transfer_to_cover_margin_shortage;

    #[test]
    pub fn zero_asset_and_liability_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let asset_weight = 8 * SPOT_WEIGHT_PRECISION / 10; // .8
        let asset_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let liability_weight = 12 * SPOT_WEIGHT_PRECISION / 10; // 1.2
        let liability_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let liability_decimals = 9;
        let liability_price = 100 * PRICE_PRECISION_I64;

        let liability_transfer = calculate_liability_transfer_to_cover_margin_shortage(
            margin_shortage,
            asset_weight,
            asset_liquidation_multiplier,
            liability_weight,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
            0,
        )
        .unwrap();

        assert_eq!(liability_transfer, 250000000); // .25 base
    }

    #[test]
    pub fn ten_percent_asset_and_liability_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let asset_weight = 8 * SPOT_WEIGHT_PRECISION / 10; // .8
        let asset_liquidation_multiplier = 110 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_weight = 12 * SPOT_WEIGHT_PRECISION / 10; // 1.2
        let liability_liquidation_multiplier = 90 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_decimals = 9;
        let liability_price = 100 * PRICE_PRECISION_I64;

        let liability_transfer = calculate_liability_transfer_to_cover_margin_shortage(
            margin_shortage,
            asset_weight,
            asset_liquidation_multiplier,
            liability_weight,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
            0,
        )
        .unwrap();

        assert_eq!(liability_transfer, 449984250);
    }

    #[test]
    pub fn zero_asset_and_liability_fee_with_one_percent_if_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let asset_weight = 8 * SPOT_WEIGHT_PRECISION / 10; // .8
        let asset_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let liability_weight = 12 * SPOT_WEIGHT_PRECISION / 10; // 1.2
        let liability_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let liability_decimals = 9;
        let liability_price = 100 * PRICE_PRECISION_I64;
        let if_liquidation_fee = LIQUIDATION_FEE_PRECISION / 100;

        let liability_transfer = calculate_liability_transfer_to_cover_margin_shortage(
            margin_shortage,
            asset_weight,
            asset_liquidation_multiplier,
            liability_weight,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
            if_liquidation_fee,
        )
        .unwrap();

        let if_fee =
            liability_transfer * if_liquidation_fee as u128 / LIQUIDATION_FEE_PRECISION_U128;

        let liability_transfer_freed_collateral =
            liability_transfer * (liability_price as u128) / PRICE_PRECISION / 1000
                * (liability_weight - asset_weight) as u128
                / SPOT_WEIGHT_PRECISION_U128;

        let if_fee_consumed_collateral =
            if_fee * (liability_price as u128) / PRICE_PRECISION / 1000 * liability_weight as u128
                / SPOT_WEIGHT_PRECISION_U128;

        assert_eq!(
            liability_transfer_freed_collateral - if_fee_consumed_collateral,
            10000001
        );
        assert_eq!(liability_transfer, 257731958);
    }

    #[test]
    pub fn ten_percent_asset_and_liability_fee_with_one_percent_if_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let asset_weight = 8 * SPOT_WEIGHT_PRECISION / 10; // .8
        let asset_liquidation_multiplier = 110 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_weight = 12 * SPOT_WEIGHT_PRECISION / 10; // 1.2
        let liability_liquidation_multiplier = 90 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_decimals = 9;
        let liability_price = 100 * PRICE_PRECISION_I64;
        let if_liquidation_fee = LIQUIDATION_FEE_PRECISION / 100;

        let liability_transfer = calculate_liability_transfer_to_cover_margin_shortage(
            margin_shortage,
            asset_weight,
            asset_liquidation_multiplier,
            liability_weight,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
            if_liquidation_fee,
        )
        .unwrap();

        let if_fee =
            liability_transfer * (if_liquidation_fee as u128) / LIQUIDATION_FEE_PRECISION_U128;

        let liability_transfer_freed_collateral =
            liability_transfer * (liability_price as u128) / PRICE_PRECISION / 1000
                * (liability_weight as u128
                    - asset_weight as u128 * asset_liquidation_multiplier as u128
                        / liability_liquidation_multiplier as u128)
                / SPOT_WEIGHT_PRECISION_U128;

        let if_fee_consumed_collateral =
            if_fee * (liability_price as u128) / PRICE_PRECISION / 1000
                * (liability_weight as u128)
                / SPOT_WEIGHT_PRECISION_U128;

        assert_eq!(
            liability_transfer_freed_collateral - if_fee_consumed_collateral,
            10003330 // ~$10
        );
        assert_eq!(liability_transfer, 475669504);
    }
}

mod calculate_liability_transfer_implied_by_asset_amount {
    use crate::math::constants::{LIQUIDATION_FEE_PRECISION, PRICE_PRECISION_I64, QUOTE_PRECISION};
    use crate::math::liquidation::calculate_liability_transfer_implied_by_asset_amount;

    #[test]
    pub fn zero_asset_and_liability_fee() {
        let asset_transfer = 10 * QUOTE_PRECISION; // $10
        let asset_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let asset_price = PRICE_PRECISION_I64;
        let liability_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let liability_decimals = 9;
        let liability_price = 100 * PRICE_PRECISION_I64;

        let liability_transfer = calculate_liability_transfer_implied_by_asset_amount(
            asset_transfer,
            asset_liquidation_multiplier,
            6,
            asset_price,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
        )
        .unwrap();

        assert_eq!(liability_transfer, 100000000); // .1 base
    }

    #[test]
    pub fn one_percent_asset_and_liability_fee() {
        let asset_transfer = 10 * QUOTE_PRECISION; // $10
        let asset_liquidation_multiplier = 101 * LIQUIDATION_FEE_PRECISION / 100;
        let asset_price = PRICE_PRECISION_I64;
        let liability_liquidation_multiplier = 99 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_decimals = 9;
        let liability_price = 100 * PRICE_PRECISION_I64;

        let liability_transfer = calculate_liability_transfer_implied_by_asset_amount(
            asset_transfer,
            asset_liquidation_multiplier,
            6,
            asset_price,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
        )
        .unwrap();

        assert_eq!(liability_transfer, 98019801); // .1 base
    }
}

mod calculate_asset_transfer_for_liability_transfer {
    use crate::math::constants::{
        BASE_PRECISION, LIQUIDATION_FEE_PRECISION, PRICE_PRECISION_I64, QUOTE_PRECISION,
    };
    use crate::math::liquidation::calculate_asset_transfer_for_liability_transfer;

    #[test]
    pub fn zero_asset_and_liability_fee() {
        let asset_amount = 100 * QUOTE_PRECISION;
        let asset_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let asset_price = PRICE_PRECISION_I64;
        let liability_transfer = BASE_PRECISION;
        let liability_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let liability_decimals = 9;
        let liability_price = 100 * PRICE_PRECISION_I64;

        let asset_transfer = calculate_asset_transfer_for_liability_transfer(
            asset_amount,
            asset_liquidation_multiplier,
            6,
            asset_price,
            liability_transfer,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
        )
        .unwrap();

        assert_eq!(asset_transfer, 100000000); // 100 quote
    }

    #[test]
    pub fn one_percent_asset_and_liability_fee() {
        let asset_amount = 200 * QUOTE_PRECISION;
        let asset_liquidation_multiplier = 101 * LIQUIDATION_FEE_PRECISION / 100;
        let asset_price = PRICE_PRECISION_I64;
        let liability_transfer = BASE_PRECISION;
        let liability_liquidation_multiplier = 99 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_decimals = 9;
        let liability_price = 100 * PRICE_PRECISION_I64;

        let asset_transfer = calculate_asset_transfer_for_liability_transfer(
            asset_amount,
            asset_liquidation_multiplier,
            6,
            asset_price,
            liability_transfer,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
        )
        .unwrap();

        assert_eq!(asset_transfer, 102020202); // 100 quote
    }
}

mod calculate_funding_rate_deltas_to_resolve_bankruptcy {
    use crate::math::constants::{BASE_PRECISION_I128, QUOTE_PRECISION_I128};
    use crate::math::liquidation::calculate_funding_rate_deltas_to_resolve_bankruptcy;
    use crate::state::perp_market::{PerpMarket, AMM};

    #[test]
    fn total_base_asset_amount_is_zero() {
        let loss = -QUOTE_PRECISION_I128;
        let market = PerpMarket {
            amm: AMM {
                base_asset_amount_long: 0,
                base_asset_amount_short: 0,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        assert!(calculate_funding_rate_deltas_to_resolve_bankruptcy(loss, &market).is_err());
    }

    #[test]
    fn total_base_asset_amount_not_zero() {
        let loss = -100 * QUOTE_PRECISION_I128;
        let market = PerpMarket {
            amm: AMM {
                base_asset_amount_long: 7 * BASE_PRECISION_I128,
                base_asset_amount_short: -4 * BASE_PRECISION_I128,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        let cumulative_funding_rate_delta =
            calculate_funding_rate_deltas_to_resolve_bankruptcy(loss, &market).unwrap();

        assert_eq!(cumulative_funding_rate_delta, 9090909000);
    }
}

mod calculate_cumulative_deposit_interest_delta_to_resolve_bankruptcy {
    use crate::math::constants::{
        QUOTE_PRECISION, SPOT_BALANCE_PRECISION, SPOT_CUMULATIVE_INTEREST_PRECISION,
    };
    use crate::math::liquidation::calculate_cumulative_deposit_interest_delta_to_resolve_bankruptcy;
    use crate::state::spot_market::SpotMarket;

    #[test]
    fn zero_total_deposits() {
        let loss = 100 * QUOTE_PRECISION;
        let spot_market = SpotMarket {
            deposit_balance: 0,
            cumulative_deposit_interest: 1111 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
            ..SpotMarket::default()
        };

        let delta =
            calculate_cumulative_deposit_interest_delta_to_resolve_bankruptcy(loss, &spot_market)
                .unwrap();

        assert_eq!(delta, 0);
    }

    #[test]
    fn non_zero_total_deposits() {
        let loss = 11 * QUOTE_PRECISION;
        let spot_market = SpotMarket {
            deposit_balance: 120 * SPOT_BALANCE_PRECISION,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            ..SpotMarket::default()
        };

        let delta =
            calculate_cumulative_deposit_interest_delta_to_resolve_bankruptcy(loss, &spot_market)
                .unwrap();

        assert_eq!(delta, 916666666);
    }
}

mod auto_deleveraging {
    use crate::math::constants::{
        BASE_PRECISION_I128, BASE_PRECISION_I64, PRICE_PRECISION_I64,
        PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128, QUOTE_PRECISION_I128, QUOTE_PRECISION_I64,
    };
    use crate::math::liquidation::{calculate_perp_market_deleverage_payment, DeleverageUserStats};
    use crate::state::perp_market::{PerpMarket, AMM};
    use solana_program::msg;

    #[test]
    fn no_position_base_case_adl() {
        let market = PerpMarket {
            amm: AMM {
                base_asset_amount_long: 0,
                base_asset_amount_short: 0,
                ..AMM::default()
            },
            number_of_users: 0,
            ..PerpMarket::default()
        };

        // user has no position / funds
        let dus = DeleverageUserStats {
            base_asset_amount: 0,
            quote_asset_amount: 0,
            quote_entry_amount: 0,
            // unrealized_pnl: 0,
            free_collateral: 0,
        };

        let delev_payment =
            calculate_perp_market_deleverage_payment(0, dus, &market, 100 * PRICE_PRECISION_I64)
                .unwrap();
        assert_eq!(delev_payment, 0);

        let delev_payment = calculate_perp_market_deleverage_payment(
            -QUOTE_PRECISION_I128,
            dus,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128,
            dus,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        //todo
    }

    #[test]
    fn small_unsettled_pnl_adl() {
        let market = PerpMarket {
            amm: AMM {
                base_asset_amount_long: 0,
                base_asset_amount_short: 0,
                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        // user has positive upnl
        let dus = DeleverageUserStats {
            base_asset_amount: 0,
            quote_asset_amount: QUOTE_PRECISION_I64,
            quote_entry_amount: 0,
            // unrealized_pnl: QUOTE_PRECISION_I128,
            free_collateral: QUOTE_PRECISION_I128 * 2,
        };

        // user has negative upnl
        let dus_neg = DeleverageUserStats {
            base_asset_amount: 0,
            quote_asset_amount: -QUOTE_PRECISION_I64,
            quote_entry_amount: 0,
            // unrealized_pnl: -QUOTE_PRECISION_I128,
            free_collateral: 0,
        };

        let delev_payment = calculate_perp_market_deleverage_payment(
            -QUOTE_PRECISION_I128,
            dus,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, QUOTE_PRECISION_I128);

        let delev_payment = calculate_perp_market_deleverage_payment(
            -QUOTE_PRECISION_I128 / 2,
            dus,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, QUOTE_PRECISION_I128 / 2);

        let delev_payment = calculate_perp_market_deleverage_payment(
            -QUOTE_PRECISION_I128 * 200,
            dus,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, QUOTE_PRECISION_I128);

        let delev_payment = calculate_perp_market_deleverage_payment(
            -QUOTE_PRECISION_I128 * 200,
            dus_neg,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        // strange input should be 0 still
        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * 200,
            dus_neg,
            &market,
            -100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);
    }

    #[test]
    fn imbalance_base_pnl_adl() {
        let market = PerpMarket {
            amm: AMM {
                base_asset_amount_long: BASE_PRECISION_I128 * 100,
                base_asset_amount_short: -BASE_PRECISION_I128,
                quote_asset_amount_long: -QUOTE_PRECISION_I128 * 100 * 100
                    + QUOTE_PRECISION_I128 * 5,
                quote_asset_amount_short: QUOTE_PRECISION_I128 * 100,
                quote_entry_amount_long: -QUOTE_PRECISION_I128 * 100 * 100,
                quote_entry_amount_short: QUOTE_PRECISION_I128 * 100,
                ..AMM::default()
            },
            number_of_users: 3,
            ..PerpMarket::default()
        };

        // user has positive upnl but 0 lifetime pnl
        let dus = DeleverageUserStats {
            base_asset_amount: BASE_PRECISION_I64,
            quote_asset_amount: -QUOTE_PRECISION_I64 * 95,
            quote_entry_amount: -QUOTE_PRECISION_I64 * 100,
            // unrealized_pnl: QUOTE_PRECISION_I128 * 5,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };

        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        // user has positive lifetime upnl but below mean
        let dus = DeleverageUserStats {
            base_asset_amount: BASE_PRECISION_I64,
            quote_asset_amount: -QUOTE_PRECISION_I64 * 95,
            quote_entry_amount: -QUOTE_PRECISION_I64 * 99,
            // unrealized_pnl: QUOTE_PRECISION_I128 * 6,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };
        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus,
            &market,
            101 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 1_000_000);

        // user has positive lifetime upnl but above mean
        let dus = DeleverageUserStats {
            base_asset_amount: BASE_PRECISION_I64,
            quote_asset_amount: -QUOTE_PRECISION_I64 * 95,
            quote_entry_amount: -QUOTE_PRECISION_I64 * 90,
            // unrealized_pnl: QUOTE_PRECISION_I128 * 11,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };
        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus,
            &market,
            101 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 10_000_000);

        // user has odd-lot base and positive lifetime upnl but above mean ex-loss_to_socialize
        let dus = DeleverageUserStats {
            base_asset_amount: BASE_PRECISION_I64 * 25 / 23,
            quote_asset_amount: (-QUOTE_PRECISION_I64 * 95 + 908324) * 25 / 23,
            quote_entry_amount: (-QUOTE_PRECISION_I64 * 90 - 43634) * 25 / 23,
            // unrealized_pnl: (QUOTE_PRECISION_I128 * 11 + 43634) * 25/23,
            free_collateral: 1000 * QUOTE_PRECISION_I128 + 463444,
        };
        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus,
            &market,
            101 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 10822138);

        // user has odd-lot base and positive lifetime upnl but above mean ex-loss_to_socialize and near liq
        let dus = DeleverageUserStats {
            base_asset_amount: BASE_PRECISION_I64 * 25 / 23,
            quote_asset_amount: (-QUOTE_PRECISION_I64 * 95 + 908324) * 25 / 23,
            quote_entry_amount: (-QUOTE_PRECISION_I64 * 90 - 43634) * 25 / 23,
            // unrealized_pnl: (QUOTE_PRECISION_I128 * 11 + 43634) * 25/23,
            free_collateral: 2 * QUOTE_PRECISION_I128,
        };
        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus,
            &market,
            101 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 2000000);
    }

    #[test]
    fn imbalance_base_shorts_pnl_adl() {
        let market = PerpMarket {
            amm: AMM {
                base_asset_amount_long: BASE_PRECISION_I128,
                base_asset_amount_short: -BASE_PRECISION_I128 * 100,
                quote_asset_amount_long: -QUOTE_PRECISION_I128 * 100 + QUOTE_PRECISION_I128 * 5,
                quote_asset_amount_short: QUOTE_PRECISION_I128 * 100 * 100,
                quote_entry_amount_long: -QUOTE_PRECISION_I128 * 100,
                quote_entry_amount_short: QUOTE_PRECISION_I128 * 100 * 100,
                ..AMM::default()
            },
            number_of_users: 3,
            ..PerpMarket::default()
        };

        // user has positive upnl
        let dus = DeleverageUserStats {
            base_asset_amount: -BASE_PRECISION_I64,
            quote_asset_amount: QUOTE_PRECISION_I64 * 105,
            quote_entry_amount: QUOTE_PRECISION_I64 * 100,
            // unrealized_pnl: QUOTE_PRECISION_I128 * 5,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };

        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        // user has positive lifetime upnl but below  mean ex-loss_to_socialize
        let dus = DeleverageUserStats {
            base_asset_amount: -BASE_PRECISION_I64,
            quote_asset_amount: QUOTE_PRECISION_I64 * 105,
            quote_entry_amount: QUOTE_PRECISION_I64 * 101,
            // unrealized_pnl: QUOTE_PRECISION_I128 * 6,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };
        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus,
            &market,
            101 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        // user has positive lifetime upnl but above mean ex-loss_to_socialize
        let dus = DeleverageUserStats {
            base_asset_amount: -BASE_PRECISION_I64,
            quote_asset_amount: QUOTE_PRECISION_I64 * 105,
            quote_entry_amount: QUOTE_PRECISION_I64 * 110,
            // unrealized_pnl: QUOTE_PRECISION_I128 * 11,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };
        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus,
            &market,
            101 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0); // todo: 1 more than long version?

        // user has odd-lot base and positive lifetime upnl but above mean ex-loss_to_socialize
        let dus = DeleverageUserStats {
            base_asset_amount: -BASE_PRECISION_I64 * 25 / 23,
            quote_asset_amount: (QUOTE_PRECISION_I64 * 105 - 908324) * 25 / 23,
            quote_entry_amount: (QUOTE_PRECISION_I64 * 110 + 43634) * 25 / 23,
            // unrealized_pnl: (QUOTE_PRECISION_I128 * 11 + 43634) * 25/23,
            free_collateral: 1000 * QUOTE_PRECISION_I128 + 463444,
        };
        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus,
            &market,
            101 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        // user has odd-lot base and positive lifetime upnl but above mean ex-loss_to_socialize and near liq
        let dus = DeleverageUserStats {
            base_asset_amount: -BASE_PRECISION_I64 * 25 / 23,
            quote_asset_amount: (QUOTE_PRECISION_I64 * 105 - 908324) * 25 / 23,
            quote_entry_amount: (QUOTE_PRECISION_I64 * 110 + 43634) * 25 / 23,
            // unrealized_pnl: (QUOTE_PRECISION_I128 * 11 + 43634) * 25/23,
            free_collateral: 2 * QUOTE_PRECISION_I128,
        };
        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus,
            &market,
            101 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);
    }

    #[test]
    fn multiple_users_first_to_adl_test() {
        let market = PerpMarket {
            amm: AMM {
                base_asset_amount_long: BASE_PRECISION_I128 * 102,
                base_asset_amount_short: -BASE_PRECISION_I128 * 54,
                quote_asset_amount_long: -QUOTE_PRECISION_I128 * 30 * 9 / 10 * 102
                    + QUOTE_PRECISION_I128 * 5
                    + (200 * QUOTE_PRECISION_I128),
                quote_asset_amount_short: QUOTE_PRECISION_I128 * 30 * 11 / 10,
                quote_entry_amount_long: -QUOTE_PRECISION_I128 * 30 * 100 * 8 / 10,
                quote_entry_amount_short: QUOTE_PRECISION_I128 * 30 * 54 * 12 / 10,
                ..AMM::default()
            },
            number_of_users: 5, // at least 6 with base or quote including the loss
            ..PerpMarket::default()
        };

        let dus1 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_long * 30 / 100) as i64,
            quote_asset_amount: (market.amm.quote_asset_amount_long * 29 / 100) as i64,
            quote_entry_amount: (market.amm.quote_entry_amount_long * 29 / 100) as i64,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };

        // tiny
        let dus2 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_long / 100) as i64,
            quote_asset_amount: (market.amm.quote_asset_amount_long / 100) as i64,
            quote_entry_amount: (market.amm.quote_entry_amount_long / 100) as i64,
            free_collateral: 100 * QUOTE_PRECISION_I128,
        };

        let dus3 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_long * 69 / 100) as i64,
            quote_asset_amount: (market.amm.quote_asset_amount_long * 70 / 100) as i64 - 100,
            quote_entry_amount: (market.amm.quote_entry_amount_long * 70 / 100) as i64,
            free_collateral: 5000 * QUOTE_PRECISION_I128,
        };

        let dus4 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_short * 50 / 100) as i64,
            quote_asset_amount: ((market.amm.quote_asset_amount_short + 200 * QUOTE_PRECISION_I128)
                * 49
                / 100) as i64,
            quote_entry_amount: (market.amm.quote_entry_amount_short * 49 / 100) as i64,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };

        let dus5 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_short * 50 / 100) as i64,
            quote_asset_amount: ((market.amm.quote_asset_amount_short + 200 * QUOTE_PRECISION_I128)
                * 51
                / 100) as i64,
            quote_entry_amount: (market.amm.quote_entry_amount_short * 51 / 100) as i64,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };

        // levered loss
        let dus6 = DeleverageUserStats {
            base_asset_amount: 0,
            quote_asset_amount: -(200 * QUOTE_PRECISION_I128) as i64,
            quote_entry_amount: 0,
            free_collateral: 0,
        };

        // filler
        let dus7 = DeleverageUserStats {
            base_asset_amount: 0,
            quote_asset_amount: 100_i64,
            quote_entry_amount: 0,
            free_collateral: 10 * QUOTE_PRECISION_I128,
        };

        assert_eq!(
            dus1.base_asset_amount
                + dus2.base_asset_amount
                + dus3.base_asset_amount
                + dus7.base_asset_amount,
            market.amm.base_asset_amount_long as i64
        );
        assert_eq!(
            dus1.quote_asset_amount
                + dus2.quote_asset_amount
                + dus3.quote_asset_amount
                + dus7.quote_asset_amount,
            market.amm.quote_asset_amount_long as i64
        );
        assert_eq!(
            dus1.quote_entry_amount
                + dus2.quote_entry_amount
                + dus3.quote_entry_amount
                + dus7.quote_entry_amount,
            market.amm.quote_entry_amount_long as i64
        );

        assert_eq!(
            dus4.base_asset_amount + dus5.base_asset_amount + dus6.base_asset_amount,
            market.amm.base_asset_amount_short as i64
        );
        assert_eq!(
            dus4.quote_asset_amount + dus5.quote_asset_amount + dus6.quote_asset_amount,
            market.amm.quote_asset_amount_short as i64
        );
        assert_eq!(
            dus4.quote_entry_amount + dus5.quote_entry_amount + dus6.quote_entry_amount,
            market.amm.quote_entry_amount_short as i64
        );

        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus1,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 23_999_977);

        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus2,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 40_000_000);

        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus3,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus4,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus5,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus6,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus7,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        // rich filler
        let dus8 = DeleverageUserStats {
            base_asset_amount: 0,
            quote_asset_amount: QUOTE_PRECISION_I64 * 2000,
            quote_entry_amount: 0,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };

        let delev_payment = calculate_perp_market_deleverage_payment(
            QUOTE_PRECISION_I128 * -200,
            dus8,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 200000000);
    }

    #[test]
    fn multiple_users_adl_sequence_test() {
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_amount_long: BASE_PRECISION_I128 * 102,
                base_asset_amount_short: -BASE_PRECISION_I128 * 54,
                quote_asset_amount_long: -QUOTE_PRECISION_I128 * 30 * 9 / 10 * 102
                    + QUOTE_PRECISION_I128 * 5
                    + (200 * QUOTE_PRECISION_I128),
                quote_asset_amount_short: QUOTE_PRECISION_I128 * 30 * 11 / 10,
                quote_entry_amount_long: -QUOTE_PRECISION_I128 * 30 * 100 * 8 / 10,
                quote_entry_amount_short: QUOTE_PRECISION_I128 * 30 * 54 * 12 / 10,
                ..AMM::default()
            },
            number_of_users: 5, // at least 6 with base or quote including the loss
            ..PerpMarket::default()
        };

        let mut dus1 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_long * 30 / 100) as i64,
            quote_asset_amount: (market.amm.quote_asset_amount_long * 29 / 100) as i64,
            quote_entry_amount: (market.amm.quote_entry_amount_long * 29 / 100) as i64,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };

        // tiny
        let mut dus2 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_long / 100) as i64,
            quote_asset_amount: (market.amm.quote_asset_amount_long / 100) as i64,
            quote_entry_amount: (market.amm.quote_entry_amount_long / 100) as i64,
            free_collateral: 100 * QUOTE_PRECISION_I128,
        };

        let mut dus3 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_long * 69 / 100) as i64,
            quote_asset_amount: (market.amm.quote_asset_amount_long * 70 / 100) as i64 - 100,
            quote_entry_amount: (market.amm.quote_entry_amount_long * 70 / 100) as i64,
            free_collateral: 5000 * QUOTE_PRECISION_I128,
        };

        let dus4 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_short * 50 / 100) as i64,
            quote_asset_amount: ((market.amm.quote_asset_amount_short + 200 * QUOTE_PRECISION_I128)
                * 49
                / 100) as i64,
            quote_entry_amount: (market.amm.quote_entry_amount_short * 49 / 100) as i64,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };

        let dus5 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_short * 50 / 100) as i64,
            quote_asset_amount: ((market.amm.quote_asset_amount_short + 200 * QUOTE_PRECISION_I128)
                * 51
                / 100) as i64,
            quote_entry_amount: (market.amm.quote_entry_amount_short * 51 / 100) as i64,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };

        // levered loss
        let dus6 = DeleverageUserStats {
            base_asset_amount: 0,
            quote_asset_amount: -(200 * QUOTE_PRECISION_I128) as i64,
            quote_entry_amount: 0,
            free_collateral: 0,
        };

        // filler
        let dus7 = DeleverageUserStats {
            base_asset_amount: 0,
            quote_asset_amount: 100_i64,
            quote_entry_amount: 0,
            free_collateral: 10 * QUOTE_PRECISION_I128,
        };

        assert_eq!(
            dus1.base_asset_amount
                + dus2.base_asset_amount
                + dus3.base_asset_amount
                + dus7.base_asset_amount,
            market.amm.base_asset_amount_long as i64
        );
        assert_eq!(
            dus1.quote_asset_amount
                + dus2.quote_asset_amount
                + dus3.quote_asset_amount
                + dus7.quote_asset_amount,
            market.amm.quote_asset_amount_long as i64
        );
        assert_eq!(
            dus1.quote_entry_amount
                + dus2.quote_entry_amount
                + dus3.quote_entry_amount
                + dus7.quote_entry_amount,
            market.amm.quote_entry_amount_long as i64
        );

        assert_eq!(
            dus4.base_asset_amount + dus5.base_asset_amount + dus6.base_asset_amount,
            market.amm.base_asset_amount_short as i64
        );
        assert_eq!(
            dus4.quote_asset_amount + dus5.quote_asset_amount + dus6.quote_asset_amount,
            market.amm.quote_asset_amount_short as i64
        );
        assert_eq!(
            dus4.quote_entry_amount + dus5.quote_entry_amount + dus6.quote_entry_amount,
            market.amm.quote_entry_amount_short as i64
        );

        let mut remaining_levered_loss = QUOTE_PRECISION_I128 * -200;

        let delev_payment = calculate_perp_market_deleverage_payment(
            remaining_levered_loss,
            dus1,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 23_999_977);
        assert_eq!(
            dus1.quote_entry_amount * PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128 as i64
                / dus1.base_asset_amount,
            -22745098
        );

        dus1.quote_asset_amount -= delev_payment as i64;
        dus1.quote_entry_amount -= delev_payment as i64;
        market.amm.quote_asset_amount_long -= delev_payment;
        market.amm.quote_entry_amount_long -= delev_payment;
        remaining_levered_loss += delev_payment;

        assert_eq!(dus1.quote_asset_amount, -763209977);
        assert_eq!(dus1.quote_entry_amount, -719999977);
        assert_eq!(dus1.base_asset_amount, 30600000000);
        assert_eq!(remaining_levered_loss, -176_000_023);

        assert_eq!(
            dus1.quote_entry_amount * PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128 as i64
                / dus1.base_asset_amount,
            -23529411
        );

        let delev_payment = calculate_perp_market_deleverage_payment(
            remaining_levered_loss,
            dus1,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 7_199_996);

        dus1.quote_asset_amount -= delev_payment as i64;
        dus1.quote_entry_amount -= delev_payment as i64;
        market.amm.quote_asset_amount_long -= delev_payment;
        market.amm.quote_entry_amount_long -= delev_payment;
        remaining_levered_loss += delev_payment;

        assert_eq!(dus1.quote_asset_amount, -770409973);
        assert_eq!(dus1.quote_entry_amount, -727199973);
        assert_eq!(dus1.base_asset_amount, 30600000000);

        assert_eq!(
            dus1.quote_entry_amount * PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128 as i64
                / dus1.base_asset_amount,
            -23764705
        );

        // shrinking rets
        let delev_payment = calculate_perp_market_deleverage_payment(
            remaining_levered_loss,
            dus1,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 2_159_992);

        // lets switch over now
        assert_eq!(
            dus2.quote_entry_amount * PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128 as i64
                / dus2.base_asset_amount,
            -23529411
        );
        let delev_payment = calculate_perp_market_deleverage_payment(
            remaining_levered_loss,
            dus2,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 311_999);

        dus2.quote_asset_amount -= delev_payment as i64;
        dus2.quote_entry_amount -= delev_payment as i64;
        market.amm.quote_asset_amount_long -= delev_payment;
        market.amm.quote_entry_amount_long -= delev_payment;
        remaining_levered_loss += delev_payment;

        assert_eq!(dus2.quote_asset_amount, -25801999);
        assert_eq!(dus2.quote_entry_amount, -24311999);
        assert_eq!(dus2.base_asset_amount, 1020000000);
        assert_eq!(remaining_levered_loss, -168_488_028);

        // lets switch over again now
        assert_eq!(
            dus3.quote_entry_amount * PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128 as i64
                / dus3.base_asset_amount,
            -23870417
        );
        let delev_payment = calculate_perp_market_deleverage_payment(
            remaining_levered_loss,
            dus3,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);

        dus3.quote_asset_amount -= delev_payment as i64;
        dus3.quote_entry_amount -= delev_payment as i64;
        market.amm.quote_asset_amount_long -= delev_payment;
        market.amm.quote_entry_amount_long -= delev_payment;
        remaining_levered_loss += delev_payment;

        let delev_payment = calculate_perp_market_deleverage_payment(
            remaining_levered_loss,
            dus3,
            &market,
            100 * PRICE_PRECISION_I64,
        )
        .unwrap();
        assert_eq!(delev_payment, 0);
        dus3.quote_asset_amount -= delev_payment as i64;
        dus3.quote_entry_amount -= delev_payment as i64;
        market.amm.quote_asset_amount_long -= delev_payment;
        market.amm.quote_entry_amount_long -= delev_payment;
        remaining_levered_loss += delev_payment;

        assert_eq!(remaining_levered_loss, -168488028);
    }

    #[test]
    fn multiple_users_adl_automated_sequence_test() {
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_amount_long: BASE_PRECISION_I128 * 102,
                base_asset_amount_short: -BASE_PRECISION_I128 * 54,
                quote_asset_amount_long: -QUOTE_PRECISION_I128 * 30 * 9 / 10 * 102
                    + QUOTE_PRECISION_I128 * 5
                    + (200 * QUOTE_PRECISION_I128),
                quote_asset_amount_short: QUOTE_PRECISION_I128 * 30 * 11 / 10,
                quote_entry_amount_long: -QUOTE_PRECISION_I128 * 30 * 100 * 8 / 10,
                quote_entry_amount_short: QUOTE_PRECISION_I128 * 30 * 54 * 12 / 10,
                ..AMM::default()
            },
            number_of_users: 5, // at least 6 with base or quote including the loss
            ..PerpMarket::default()
        };

        let mut dus1 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_long * 30 / 100) as i64,
            quote_asset_amount: (market.amm.quote_asset_amount_long * 29 / 100) as i64,
            quote_entry_amount: (market.amm.quote_entry_amount_long * 29 / 100) as i64,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };

        // tiny
        let mut dus2 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_long / 100) as i64,
            quote_asset_amount: (market.amm.quote_asset_amount_long / 100) as i64,
            quote_entry_amount: (market.amm.quote_entry_amount_long / 100) as i64,
            free_collateral: 100 * QUOTE_PRECISION_I128,
        };

        let mut dus3 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_long * 69 / 100) as i64,
            quote_asset_amount: (market.amm.quote_asset_amount_long * 70 / 100) as i64 - 100,
            quote_entry_amount: (market.amm.quote_entry_amount_long * 70 / 100) as i64,
            free_collateral: 5000 * QUOTE_PRECISION_I128,
        };

        let mut dus4 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_short * 50 / 100) as i64,
            quote_asset_amount: ((market.amm.quote_asset_amount_short + 200 * QUOTE_PRECISION_I128)
                * 49
                / 100) as i64,
            quote_entry_amount: (market.amm.quote_entry_amount_short * 49 / 100) as i64,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };

        let mut dus5 = DeleverageUserStats {
            base_asset_amount: (market.amm.base_asset_amount_short * 50 / 100) as i64,
            quote_asset_amount: ((market.amm.quote_asset_amount_short + 200 * QUOTE_PRECISION_I128)
                * 51
                / 100) as i64,
            quote_entry_amount: (market.amm.quote_entry_amount_short * 51 / 100) as i64,
            free_collateral: 1000 * QUOTE_PRECISION_I128,
        };

        // levered loss
        let mut dus6 = DeleverageUserStats {
            base_asset_amount: 0,
            quote_asset_amount: -(200 * QUOTE_PRECISION_I128) as i64,
            quote_entry_amount: 0,
            free_collateral: 0,
        };

        // filler
        let mut dus7 = DeleverageUserStats {
            base_asset_amount: 0,
            quote_asset_amount: 100_i64,
            quote_entry_amount: 0,
            free_collateral: 10 * QUOTE_PRECISION_I128,
        };

        assert_eq!(
            dus1.base_asset_amount
                + dus2.base_asset_amount
                + dus3.base_asset_amount
                + dus7.base_asset_amount,
            market.amm.base_asset_amount_long as i64
        );
        assert_eq!(
            dus1.quote_asset_amount
                + dus2.quote_asset_amount
                + dus3.quote_asset_amount
                + dus7.quote_asset_amount,
            market.amm.quote_asset_amount_long as i64
        );
        assert_eq!(
            dus1.quote_entry_amount
                + dus2.quote_entry_amount
                + dus3.quote_entry_amount
                + dus7.quote_entry_amount,
            market.amm.quote_entry_amount_long as i64
        );

        assert_eq!(
            dus4.base_asset_amount + dus5.base_asset_amount + dus6.base_asset_amount,
            market.amm.base_asset_amount_short as i64
        );
        assert_eq!(
            dus4.quote_asset_amount + dus5.quote_asset_amount + dus6.quote_asset_amount,
            market.amm.quote_asset_amount_short as i64
        );
        assert_eq!(
            dus4.quote_entry_amount + dus5.quote_entry_amount + dus6.quote_entry_amount,
            market.amm.quote_entry_amount_short as i64
        );

        let mut remaining_levered_loss = QUOTE_PRECISION_I128 * -200;

        let mut dus_list: Vec<&mut DeleverageUserStats> = vec![];
        dus_list.push(&mut dus1);
        dus_list.push(&mut dus2);
        dus_list.push(&mut dus3);
        dus_list.push(&mut dus4);
        dus_list.push(&mut dus5);
        dus_list.push(&mut dus6);
        dus_list.push(&mut dus7);

        let mut v = Vec::new();
        let l = 7;
        v.resize(l, 0_i128);

        let mut count = 0;
        let mut zaps = 0;
        while remaining_levered_loss < 0 && count < 1000 {
            let mut idx = 0;
            for mut dus in dus_list.iter_mut() {
                let delev_payment = calculate_perp_market_deleverage_payment(
                    remaining_levered_loss,
                    **dus,
                    &market,
                    100 * PRICE_PRECISION_I64,
                )
                .unwrap();

                if delev_payment > 0 {
                    msg!("{}: delev_payment={}", count, delev_payment);
                    dus.quote_asset_amount -= delev_payment as i64;
                    dus.quote_entry_amount -= delev_payment as i64;
                    market.amm.quote_asset_amount_long -= delev_payment;
                    market.amm.quote_entry_amount_long -= delev_payment;
                    remaining_levered_loss += delev_payment;
                    zaps += 1;
                }

                count += 1;
                v[idx] += delev_payment;
                idx += 1;
            }
        }

        assert_eq!(remaining_levered_loss, 0);
        assert_eq!(count > 500, true);
        assert_eq!(zaps, 155);
        assert_eq!(v, [83070095, 6026159, 110903746, 0, 0, 0, 0]);
    }
}
