mod calculate_base_asset_amount_to_cover_margin_shortage {
    use crate::math::constants::{
        BASE_PRECISION, LIQUIDATION_FEE_PRECISION, MARGIN_PRECISION, MARK_PRICE_PRECISION_I128,
        QUOTE_PRECISION,
    };
    use crate::math::liquidation::calculate_base_asset_amount_to_cover_margin_shortage;

    #[test]
    pub fn zero_percent_liquidation_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let margin_ratio = MARGIN_PRECISION as u32 / 10; // 10x leverage
        let liquidation_fee = 0; // 0 percent
        let oracle_price = 100 * MARK_PRICE_PRECISION_I128; // $100 / base
        let base_asset_amount = calculate_base_asset_amount_to_cover_margin_shortage(
            margin_shortage,
            margin_ratio,
            liquidation_fee,
            oracle_price,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION); // must lose 1 base
    }

    #[test]
    pub fn one_percent_liquidation_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let margin_ratio = MARGIN_PRECISION as u32 / 10; // 10x leverage
        let liquidation_fee = LIQUIDATION_FEE_PRECISION / 100; // 0 percent
        let oracle_price = 100 * MARK_PRICE_PRECISION_I128; // $100 / base
        let base_asset_amount = calculate_base_asset_amount_to_cover_margin_shortage(
            margin_shortage,
            margin_ratio,
            liquidation_fee,
            oracle_price,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION * 10 / 9); // must lose 10/9 base
    }
}

mod calculate_liability_transfer_to_cover_margin_shortage {
    use crate::math::constants::{
        BANK_WEIGHT_PRECISION, LIQUIDATION_FEE_PRECISION, MARK_PRICE_PRECISION_I128,
        QUOTE_PRECISION,
    };
    use crate::math::liquidation::calculate_liability_transfer_to_cover_margin_shortage;

    #[test]
    pub fn zero_asset_and_liability_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let asset_weight = 8 * BANK_WEIGHT_PRECISION / 10; // .8
        let asset_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let liability_weight = 12 * BANK_WEIGHT_PRECISION / 10; // 1.2
        let liability_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let liability_decimals = 9;
        let liability_price = 100 * MARK_PRICE_PRECISION_I128;

        let liability_transfer = calculate_liability_transfer_to_cover_margin_shortage(
            margin_shortage,
            asset_weight,
            asset_liquidation_multiplier,
            liability_weight,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
        )
        .unwrap();

        assert_eq!(liability_transfer, 250000000); // .25 base
    }

    #[test]
    pub fn one_percent_asset_and_liability_fee() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let asset_weight = 8 * BANK_WEIGHT_PRECISION / 10; // .8
        let asset_liquidation_multiplier = 110 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_weight = 12 * BANK_WEIGHT_PRECISION / 10; // 1.2
        let liability_liquidation_multiplier = 90 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_decimals = 9;
        let liability_price = 100 * MARK_PRICE_PRECISION_I128;

        let liability_transfer = calculate_liability_transfer_to_cover_margin_shortage(
            margin_shortage,
            asset_weight,
            asset_liquidation_multiplier,
            liability_weight,
            liability_liquidation_multiplier,
            liability_decimals,
            liability_price,
        )
        .unwrap();

        assert_eq!(liability_transfer, 449984250); // .25 base
    }
}

mod calculate_liability_transfer_implied_by_asset_amount {
    use crate::math::constants::{
        LIQUIDATION_FEE_PRECISION, MARK_PRICE_PRECISION_I128, QUOTE_PRECISION,
    };
    use crate::math::liquidation::calculate_liability_transfer_implied_by_asset_amount;

    #[test]
    pub fn zero_asset_and_liability_fee() {
        let asset_transfer = 10 * QUOTE_PRECISION; // $10
        let asset_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let asset_price = MARK_PRICE_PRECISION_I128;
        let liability_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let liability_decimals = 9;
        let liability_price = 100 * MARK_PRICE_PRECISION_I128;

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
        let asset_price = MARK_PRICE_PRECISION_I128;
        let liability_liquidation_multiplier = 99 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_decimals = 9;
        let liability_price = 100 * MARK_PRICE_PRECISION_I128;

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
        BASE_PRECISION, LIQUIDATION_FEE_PRECISION, MARK_PRICE_PRECISION_I128, QUOTE_PRECISION,
    };
    use crate::math::liquidation::calculate_asset_transfer_for_liability_transfer;

    #[test]
    pub fn zero_asset_and_liability_fee() {
        let asset_amount = 100 * QUOTE_PRECISION;
        let asset_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let asset_price = MARK_PRICE_PRECISION_I128;
        let liability_transfer = BASE_PRECISION;
        let liability_liquidation_multiplier = LIQUIDATION_FEE_PRECISION;
        let liability_decimals = 13;
        let liability_price = 100 * MARK_PRICE_PRECISION_I128;

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
        let asset_price = MARK_PRICE_PRECISION_I128;
        let liability_transfer = BASE_PRECISION;
        let liability_liquidation_multiplier = 99 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_decimals = 13;
        let liability_price = 100 * MARK_PRICE_PRECISION_I128;

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
