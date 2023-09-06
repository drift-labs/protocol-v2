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
            PRICE_PRECISION_I64,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION_U64); // must lose 1 base
    }

    #[test]
    pub fn usdc_not_one() {
        let margin_shortage = 10 * QUOTE_PRECISION; // $10 shortage
        let margin_ratio = MARGIN_PRECISION as u32 / 10; // 10x leverage
        let liquidation_fee = 0; // 0 percent
        let oracle_price = 100 * PRICE_PRECISION_I64; // $100 / base
        let quote_oracle_price = 99 * 10000;
        let base_asset_amount = calculate_base_asset_amount_to_cover_margin_shortage(
            margin_shortage,
            margin_ratio,
            liquidation_fee,
            0,
            oracle_price,
            quote_oracle_price,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 1010101010);

        let quote_oracle_price = 101 * 10000;
        let base_asset_amount = calculate_base_asset_amount_to_cover_margin_shortage(
            margin_shortage,
            margin_ratio,
            liquidation_fee,
            0,
            oracle_price,
            quote_oracle_price,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 990099009);
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
            PRICE_PRECISION_I64,
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
            PRICE_PRECISION_I64,
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

        assert_eq!(liability_transfer, 98019802); // .1 base
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

        assert_eq!(cumulative_funding_rate_delta, 9090910000);
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

        assert_eq!(delta, 916666667);
    }
}

mod validate_transfer_satisfies_limit_price {
    use crate::math::constants::{PRICE_PRECISION_U64, QUOTE_PRECISION};
    use crate::math::liquidation::validate_transfer_satisfies_limit_price;
    use anchor_lang::solana_program::native_token::LAMPORTS_PER_SOL;

    #[test]
    fn sol_asset_usdc_liability() {
        let limit_price = PRICE_PRECISION_U64 / 100; // 1 SOL / $100 USD
        let asset = LAMPORTS_PER_SOL as u128;
        let asset_decimals = 9_u32;
        let liability = 100 * QUOTE_PRECISION;
        let liability_decimals = 6_u32;

        assert!(validate_transfer_satisfies_limit_price(
            asset,
            liability,
            asset_decimals,
            liability_decimals,
            Some(limit_price)
        )
        .is_ok());

        let asset = asset / 10;
        assert!(validate_transfer_satisfies_limit_price(
            asset,
            liability,
            asset_decimals,
            liability_decimals,
            Some(limit_price)
        )
        .is_err());
    }

    #[test]
    fn usdc_asset_sol_liability() {
        let limit_price = PRICE_PRECISION_U64 * 100; // $100 / 1 SOL
        let asset = 100 * QUOTE_PRECISION;
        let asset_decimals = 6_u32;
        let liability = LAMPORTS_PER_SOL as u128;
        let liability_decimals = 9_u32;

        assert!(validate_transfer_satisfies_limit_price(
            asset,
            liability,
            asset_decimals,
            liability_decimals,
            Some(limit_price)
        )
        .is_ok());

        let asset = asset / 10;
        assert!(validate_transfer_satisfies_limit_price(
            asset,
            liability,
            asset_decimals,
            liability_decimals,
            Some(limit_price)
        )
        .is_err());
    }
}

mod calculate_perp_if_fee {
    use crate::math::liquidation::calculate_perp_if_fee;
    use crate::{
        BASE_PRECISION_U64, LIQUIDATION_FEE_PRECISION, MARGIN_PRECISION, PRICE_PRECISION_I64,
        QUOTE_PRECISION,
    };

    #[test]
    fn test() {
        let margin_shortage = 20 * QUOTE_PRECISION;
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let quote_price = PRICE_PRECISION_I64;
        let liquidator_fee = LIQUIDATION_FEE_PRECISION / 100; // 1%
        let margin_ratio = MARGIN_PRECISION / 20; // 5%
        let base_asset_amount = 10 * BASE_PRECISION_U64;
        let max_if_fee = LIQUIDATION_FEE_PRECISION / 20; // 5%

        let fee = calculate_perp_if_fee(
            margin_shortage,
            base_asset_amount,
            margin_ratio,
            liquidator_fee,
            oracle_price,
            quote_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, LIQUIDATION_FEE_PRECISION / 50); // 2%

        let tiny_margin_shortage = QUOTE_PRECISION;
        let fee = calculate_perp_if_fee(
            tiny_margin_shortage,
            base_asset_amount,
            margin_ratio,
            liquidator_fee,
            oracle_price,
            quote_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, 39000); // 3.9%

        let huge_margin_shortage = 1000 * QUOTE_PRECISION;
        let fee = calculate_perp_if_fee(
            huge_margin_shortage,
            base_asset_amount,
            margin_ratio,
            liquidator_fee,
            oracle_price,
            quote_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, 0);

        let large_liquidator_fee = LIQUIDATION_FEE_PRECISION / 10; // 10%
        let fee = calculate_perp_if_fee(
            margin_shortage,
            base_asset_amount,
            margin_ratio,
            large_liquidator_fee,
            oracle_price,
            quote_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, 0);

        let zero_oracle_price = 0;
        let fee = calculate_perp_if_fee(
            margin_shortage,
            base_asset_amount,
            margin_ratio,
            liquidator_fee,
            zero_oracle_price,
            quote_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, 0);

        let zero_quote_price = 0;
        let fee = calculate_perp_if_fee(
            margin_shortage,
            base_asset_amount,
            margin_ratio,
            liquidator_fee,
            oracle_price,
            zero_quote_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, 0);

        let zero_base_asset_amount = 0;
        let fee = calculate_perp_if_fee(
            margin_shortage,
            zero_base_asset_amount,
            margin_ratio,
            liquidator_fee,
            oracle_price,
            quote_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, 0);
    }
}

mod calculate_spot_if_fee {
    use crate::math::liquidation::calculate_spot_if_fee;
    use crate::{
        LIQUIDATION_FEE_PRECISION, PRICE_PRECISION_I64, QUOTE_PRECISION, SPOT_WEIGHT_PRECISION,
    };

    #[test]
    fn test() {
        let margin_shortage = 5 * QUOTE_PRECISION;
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let asset_weight = SPOT_WEIGHT_PRECISION;
        let asset_multiplier = 101 * LIQUIDATION_FEE_PRECISION / 100;
        let liability_weight = 11 * SPOT_WEIGHT_PRECISION / 10;
        let liability_multiplier = LIQUIDATION_FEE_PRECISION;
        let decimals = 9_u32;
        let token_amount = 10_u128.pow(decimals);
        let max_if_fee = LIQUIDATION_FEE_PRECISION / 20; // 5%

        let fee = calculate_spot_if_fee(
            margin_shortage,
            token_amount,
            asset_weight,
            asset_multiplier,
            liability_weight,
            liability_multiplier,
            decimals,
            oracle_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, 36363); // 4% /1.1

        let large_margin_shortage = 100 * QUOTE_PRECISION;
        let fee = calculate_spot_if_fee(
            large_margin_shortage,
            token_amount,
            asset_weight,
            asset_multiplier,
            liability_weight,
            liability_multiplier,
            decimals,
            oracle_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, 0);

        let tiny_margin_shortage = QUOTE_PRECISION;
        let fee = calculate_spot_if_fee(
            tiny_margin_shortage,
            token_amount,
            asset_weight,
            asset_multiplier,
            liability_weight,
            liability_multiplier,
            decimals,
            oracle_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, max_if_fee);

        let large_asset_weight = SPOT_WEIGHT_PRECISION * 2;
        let fee = calculate_spot_if_fee(
            tiny_margin_shortage,
            token_amount,
            large_asset_weight,
            asset_multiplier,
            liability_weight,
            liability_multiplier,
            decimals,
            oracle_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, 0);

        let zero_liability_weight = 0;
        let fee = calculate_spot_if_fee(
            margin_shortage,
            token_amount,
            asset_weight,
            asset_multiplier,
            zero_liability_weight,
            liability_multiplier,
            decimals,
            oracle_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, 0);

        let zero_token_amount = 0;
        let fee = calculate_spot_if_fee(
            margin_shortage,
            zero_token_amount,
            asset_weight,
            asset_multiplier,
            liability_weight,
            liability_multiplier,
            decimals,
            oracle_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, 0);

        let zero_liability_multiplier = 0;
        let fee = calculate_spot_if_fee(
            margin_shortage,
            token_amount,
            asset_weight,
            asset_multiplier,
            liability_weight,
            zero_liability_multiplier,
            decimals,
            oracle_price,
            max_if_fee,
        )
        .unwrap();

        assert_eq!(fee, 0);
    }
}
