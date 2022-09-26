mod calculate_base_asset_amount_to_cover_margin_shortage {
    use crate::math::constants::{
        AMM_TO_QUOTE_PRECISION_RATIO, BASE_PRECISION, LIQUIDATION_FEE_PRECISION, MARGIN_PRECISION,
        PRICE_PRECISION, PRICE_PRECISION_I128, QUOTE_PRECISION,
    };
    use crate::math::liquidation::calculate_base_asset_amount_to_cover_margin_shortage;

    #[test]
    pub fn zero_percent_liquidation_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let margin_ratio = MARGIN_PRECISION as u32 / 10; // 10x leverage
        let liquidation_fee = 0; // 0 percent
        let oracle_price = 100 * PRICE_PRECISION_I128; // $100 / base
        let base_asset_amount = calculate_base_asset_amount_to_cover_margin_shortage(
            margin_shortage,
            margin_ratio,
            liquidation_fee,
            0,
            oracle_price,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION); // must lose 1 base
    }

    #[test]
    pub fn one_percent_liquidation_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let margin_ratio = MARGIN_PRECISION as u32 / 10; // 10x leverage
        let liquidation_fee = LIQUIDATION_FEE_PRECISION / 100; // 1 percent
        let oracle_price = 100 * PRICE_PRECISION_I128; // $100 / base
        let base_asset_amount = calculate_base_asset_amount_to_cover_margin_shortage(
            margin_shortage,
            margin_ratio,
            liquidation_fee,
            0,
            oracle_price,
        )
        .unwrap();

        let freed_collateral = base_asset_amount * oracle_price.unsigned_abs()
            / PRICE_PRECISION
            / AMM_TO_QUOTE_PRECISION_RATIO
            * margin_ratio as u128
            / MARGIN_PRECISION;

        let negative_pnl = base_asset_amount * oracle_price.unsigned_abs()
            / PRICE_PRECISION
            / AMM_TO_QUOTE_PRECISION_RATIO
            * liquidation_fee
            / LIQUIDATION_FEE_PRECISION;

        assert_eq!(freed_collateral - negative_pnl, 10000000); // ~$10

        assert_eq!(base_asset_amount, BASE_PRECISION * 10 / 9); // must lose 10/9 base
    }

    #[test]
    pub fn one_percent_liquidation_fee_and_one_percent_if_liquidation_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let margin_ratio = MARGIN_PRECISION as u32 / 10; // 10x leverage
        let liquidation_fee = LIQUIDATION_FEE_PRECISION / 100; // 1 percent
        let oracle_price = 100 * PRICE_PRECISION_I128; // $100 / base
        let if_liquidation_fee = LIQUIDATION_FEE_PRECISION / 100; // 1 percent
        let base_asset_amount = calculate_base_asset_amount_to_cover_margin_shortage(
            margin_shortage,
            margin_ratio,
            liquidation_fee,
            if_liquidation_fee,
            oracle_price,
        )
        .unwrap();

        let if_fee = base_asset_amount * oracle_price.unsigned_abs()
            / PRICE_PRECISION
            / AMM_TO_QUOTE_PRECISION_RATIO
            * if_liquidation_fee
            / LIQUIDATION_FEE_PRECISION;

        let freed_collateral = base_asset_amount * oracle_price.unsigned_abs()
            / PRICE_PRECISION
            / AMM_TO_QUOTE_PRECISION_RATIO
            * margin_ratio as u128
            / MARGIN_PRECISION;

        let negative_pnl = base_asset_amount * oracle_price.unsigned_abs()
            / PRICE_PRECISION
            / AMM_TO_QUOTE_PRECISION_RATIO
            * liquidation_fee
            / LIQUIDATION_FEE_PRECISION;

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
        LIQUIDATION_FEE_PRECISION, PRICE_PRECISION, PRICE_PRECISION_I128, QUOTE_PRECISION,
        SPOT_WEIGHT_PRECISION,
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
        let liability_price = 100 * PRICE_PRECISION_I128;

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
        let liability_price = 100 * PRICE_PRECISION_I128;

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
        let liability_price = 100 * PRICE_PRECISION_I128;
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

        let if_fee = liability_transfer * if_liquidation_fee / LIQUIDATION_FEE_PRECISION;

        let liability_transfer_freed_collateral =
            liability_transfer * liability_price.unsigned_abs() / PRICE_PRECISION / 1000
                * (liability_weight - asset_weight)
                / SPOT_WEIGHT_PRECISION;

        let if_fee_consumed_collateral =
            if_fee * liability_price.unsigned_abs() / PRICE_PRECISION / 1000 * liability_weight
                / SPOT_WEIGHT_PRECISION;

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
        let liability_price = 100 * PRICE_PRECISION_I128;
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

        let if_fee = liability_transfer * if_liquidation_fee / LIQUIDATION_FEE_PRECISION;

        let liability_transfer_freed_collateral =
            liability_transfer * liability_price.unsigned_abs() / PRICE_PRECISION / 1000
                * (liability_weight
                    - asset_weight * asset_liquidation_multiplier
                        / liability_liquidation_multiplier)
                / SPOT_WEIGHT_PRECISION;

        let if_fee_consumed_collateral =
            if_fee * liability_price.unsigned_abs() / PRICE_PRECISION / 1000 * liability_weight
                / SPOT_WEIGHT_PRECISION;

        assert_eq!(
            liability_transfer_freed_collateral - if_fee_consumed_collateral,
            10003330 // ~$10
        );
        assert_eq!(liability_transfer, 475669504);
    }
}

mod calculate_liability_transfer_implied_by_asset_amount {
    use crate::math::constants::{
        LIQUIDATION_FEE_PRECISION, PRICE_PRECISION_I128, QUOTE_PRECISION,
    };
    use crate::math::liquidation::calculate_liability_transfer_implied_by_asset_amount;

    #[test]
    pub fn zero_asset_and_liability_fee() {
        let asset_transfer = 10 * QUOTE_PRECISION; // $10
        let asset_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let asset_price = PRICE_PRECISION_I128;
        let liability_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let liability_decimals = 9;
        let liability_price = 100 * PRICE_PRECISION_I128;

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
        let asset_price = PRICE_PRECISION_I128;
        let liability_liquidation_multiplier = 99 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_decimals = 9;
        let liability_price = 100 * PRICE_PRECISION_I128;

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
        BASE_PRECISION, LIQUIDATION_FEE_PRECISION, PRICE_PRECISION_I128, QUOTE_PRECISION,
    };
    use crate::math::liquidation::calculate_asset_transfer_for_liability_transfer;

    #[test]
    pub fn zero_asset_and_liability_fee() {
        let asset_amount = 100 * QUOTE_PRECISION;
        let asset_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let asset_price = PRICE_PRECISION_I128;
        let liability_transfer = BASE_PRECISION;
        let liability_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let liability_decimals = 9;
        let liability_price = 100 * PRICE_PRECISION_I128;

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
        let asset_price = PRICE_PRECISION_I128;
        let liability_transfer = BASE_PRECISION;
        let liability_liquidation_multiplier = 99 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_decimals = 9;
        let liability_price = 100 * PRICE_PRECISION_I128;

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
    use crate::state::market::PerpMarket;

    #[test]
    fn total_base_asset_amount_is_zero() {
        let loss = -QUOTE_PRECISION_I128;
        let market = PerpMarket {
            base_asset_amount_long: 0,
            base_asset_amount_short: 0,
            ..PerpMarket::default()
        };

        let cumulative_funding_rate_delta =
            calculate_funding_rate_deltas_to_resolve_bankruptcy(loss, &market).unwrap();

        assert_eq!(cumulative_funding_rate_delta, 0);
    }

    #[test]
    fn total_base_asset_amount_not_zero() {
        let loss = -100 * QUOTE_PRECISION_I128;
        let market = PerpMarket {
            base_asset_amount_long: 7 * BASE_PRECISION_I128,
            base_asset_amount_short: -4 * BASE_PRECISION_I128,
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
