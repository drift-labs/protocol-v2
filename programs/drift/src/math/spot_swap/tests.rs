#[cfg(test)]
mod test {
    use crate::math::constants::PRICE_PRECISION_I64;
    use crate::math::margin::MarginRequirementType;

    use crate::math::spot_swap::select_margin_type_for_swap;
    use crate::state::oracle::StrictOraclePrice;
    use crate::state::spot_market::SpotMarket;

    #[test]
    pub fn sell_usdc_buy_sol_decrease_health() {
        let usdc_spot_market = SpotMarket::default_quote_market();

        let sol_spot_market = SpotMarket::default_base_market();

        let usdc_price = PRICE_PRECISION_I64;
        let sol_price = 100 * PRICE_PRECISION_I64;

        let usdc_before = 100 * 10_i128.pow(usdc_spot_market.decimals);
        let sol_before = 0_i128;

        let usdc_after = -100 * 10_i128.pow(usdc_spot_market.decimals);
        let sol_after = 2 * 10_i128.pow(sol_spot_market.decimals);

        let strict_usdc_price = StrictOraclePrice::test(usdc_price);

        let strict_sol_price = StrictOraclePrice::test(sol_price);

        let margin_type = select_margin_type_for_swap(
            &usdc_spot_market,
            &sol_spot_market,
            &strict_usdc_price,
            &strict_sol_price,
            usdc_before,
            sol_before,
            usdc_after,
            sol_after,
            MarginRequirementType::Initial,
        )
        .unwrap();

        assert_eq!(margin_type, MarginRequirementType::Initial);
    }

    #[test]
    pub fn sell_usdc_buy_sol_increase_health() {
        let usdc_spot_market = SpotMarket::default_quote_market();

        let sol_spot_market = SpotMarket::default_base_market();

        let usdc_price = PRICE_PRECISION_I64;
        let sol_price = 100 * PRICE_PRECISION_I64;

        // close sol borrow by selling usdc
        let usdc_before = 200 * 10_i128.pow(usdc_spot_market.decimals);
        let sol_before = -(10_i128.pow(sol_spot_market.decimals));

        let usdc_after = 100 * 10_i128.pow(usdc_spot_market.decimals);
        let sol_after = 0_i128;

        let strict_usdc_price = StrictOraclePrice::test(usdc_price);

        let strict_sol_price = StrictOraclePrice::test(sol_price);

        let margin_type = select_margin_type_for_swap(
            &usdc_spot_market,
            &sol_spot_market,
            &strict_usdc_price,
            &strict_sol_price,
            usdc_before,
            sol_before,
            usdc_after,
            sol_after,
            MarginRequirementType::Initial,
        )
        .unwrap();

        assert_eq!(margin_type, MarginRequirementType::Maintenance);
    }

    #[test]
    pub fn buy_usdc_sell_sol_decrease_health() {
        let usdc_spot_market = SpotMarket::default_quote_market();

        let sol_spot_market = SpotMarket::default_base_market();

        let usdc_price = PRICE_PRECISION_I64;
        let sol_price = 100 * PRICE_PRECISION_I64;

        let usdc_before = 0_i128;
        let sol_before = 10_i128.pow(sol_spot_market.decimals);

        let usdc_after = 200 * 10_i128.pow(usdc_spot_market.decimals);
        let sol_after = -(10_i128.pow(sol_spot_market.decimals));

        let strict_usdc_price = StrictOraclePrice::test(usdc_price);

        let strict_sol_price = StrictOraclePrice::test(sol_price);

        let margin_type = select_margin_type_for_swap(
            &usdc_spot_market,
            &sol_spot_market,
            &strict_usdc_price,
            &strict_sol_price,
            usdc_before,
            sol_before,
            usdc_after,
            sol_after,
            MarginRequirementType::Initial,
        )
        .unwrap();

        assert_eq!(margin_type, MarginRequirementType::Initial);
    }

    #[test]
    pub fn buy_usdc_sell_sol_increase_health() {
        let usdc_spot_market = SpotMarket::default_quote_market();

        let sol_spot_market = SpotMarket::default_base_market();

        let usdc_price = PRICE_PRECISION_I64;
        let sol_price = 100 * PRICE_PRECISION_I64;

        let usdc_before = -100 * 10_i128.pow(usdc_spot_market.decimals);
        let sol_before = 2 * 10_i128.pow(sol_spot_market.decimals);

        let usdc_after = 0_i128;
        let sol_after = 10_i128.pow(sol_spot_market.decimals);

        let strict_usdc_price = StrictOraclePrice::test(usdc_price);

        let strict_sol_price = StrictOraclePrice::test(sol_price);

        let margin_type = select_margin_type_for_swap(
            &usdc_spot_market,
            &sol_spot_market,
            &strict_usdc_price,
            &strict_sol_price,
            usdc_before,
            sol_before,
            usdc_after,
            sol_after,
            MarginRequirementType::Initial,
        )
        .unwrap();

        assert_eq!(margin_type, MarginRequirementType::Maintenance);
    }
}

#[cfg(test)]
mod validate_price_bands_for_swap {
    use crate::error::ErrorCode;
    use crate::math::spot_swap::validate_price_bands_for_swap;
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::spot_market::SpotMarket;
    use crate::{
        LAMPORTS_PER_SOL_U64, PERCENTAGE_PRECISION_U64, PRICE_PRECISION_I64, QUOTE_PRECISION_U64,
    };
    use solana_program::native_token::LAMPORTS_PER_SOL;

    #[test]
    fn sol_in_usdc_out() {
        let in_price = 100 * PRICE_PRECISION_I64;
        let in_market = SpotMarket {
            historical_oracle_data: HistoricalOracleData::default_price(in_price),
            ..SpotMarket::default_base_market()
        };

        let out_price = PRICE_PRECISION_I64;
        let out_market = SpotMarket {
            historical_oracle_data: HistoricalOracleData::default_price(out_price),
            ..SpotMarket::default_quote_market()
        };

        let amount_in = LAMPORTS_PER_SOL_U64;
        let amount_out = 100 * QUOTE_PRECISION_U64;

        let max_5min_twap_divergence = PERCENTAGE_PRECISION_U64 / 2;

        let result = validate_price_bands_for_swap(
            &in_market,
            &out_market,
            amount_in,
            amount_out,
            in_price,
            out_price,
            max_5min_twap_divergence,
        );

        assert_eq!(result, Ok(()));

        // breaches oracle price band
        let amount_out = 79 * QUOTE_PRECISION_U64;

        let result = validate_price_bands_for_swap(
            &in_market,
            &out_market,
            amount_in,
            amount_out,
            in_price,
            out_price,
            max_5min_twap_divergence,
        );

        assert_eq!(result, Err(ErrorCode::PriceBandsBreached));

        // breaches twap price band
        let amount_out = 49 * QUOTE_PRECISION_U64;
        let in_price = 49 * PRICE_PRECISION_I64;

        let result = validate_price_bands_for_swap(
            &in_market,
            &out_market,
            amount_in,
            amount_out,
            in_price,
            out_price,
            max_5min_twap_divergence,
        );

        assert_eq!(result, Err(ErrorCode::PriceBandsBreached));
    }

    #[test]
    fn usdc_in_sol_out() {
        let in_price = PRICE_PRECISION_I64;
        let in_market = SpotMarket {
            historical_oracle_data: HistoricalOracleData::default_price(in_price),
            ..SpotMarket::default_quote_market()
        };

        let out_price = 100 * PRICE_PRECISION_I64;
        let out_market = SpotMarket {
            historical_oracle_data: HistoricalOracleData::default_price(out_price),
            ..SpotMarket::default_base_market()
        };

        let amount_in = 100 * QUOTE_PRECISION_U64;
        let amount_out = LAMPORTS_PER_SOL_U64;

        let max_5min_twap_divergence = PERCENTAGE_PRECISION_U64 / 2;

        let result = validate_price_bands_for_swap(
            &in_market,
            &out_market,
            amount_in,
            amount_out,
            in_price,
            out_price,
            max_5min_twap_divergence,
        );

        assert_eq!(result, Ok(()));

        // breaches oracle price band
        let amount_out = 79 * LAMPORTS_PER_SOL / 100;

        let result = validate_price_bands_for_swap(
            &in_market,
            &out_market,
            amount_in,
            amount_out,
            in_price,
            out_price,
            max_5min_twap_divergence,
        );

        assert_eq!(result, Err(ErrorCode::PriceBandsBreached));

        // breaches twap price band
        let amount_out = 49 * LAMPORTS_PER_SOL / 100;
        let out_price = 200 * PRICE_PRECISION_I64;

        let result = validate_price_bands_for_swap(
            &in_market,
            &out_market,
            amount_in,
            amount_out,
            in_price,
            out_price,
            max_5min_twap_divergence,
        );

        assert_eq!(result, Err(ErrorCode::PriceBandsBreached));
    }

    #[test]
    fn sol_in_btc_out() {
        let in_price = 100 * PRICE_PRECISION_I64;
        let in_market = SpotMarket {
            historical_oracle_data: HistoricalOracleData::default_price(in_price),
            ..SpotMarket::default_base_market()
        };

        let out_price = 20000 * PRICE_PRECISION_I64;
        let out_market = SpotMarket {
            historical_oracle_data: HistoricalOracleData::default_price(out_price),
            decimals: 6,
            ..SpotMarket::default_base_market()
        };

        let amount_in = LAMPORTS_PER_SOL_U64;
        let amount_out = QUOTE_PRECISION_U64 / 200;

        let max_5min_twap_divergence = PERCENTAGE_PRECISION_U64 / 2;

        let result = validate_price_bands_for_swap(
            &in_market,
            &out_market,
            amount_in,
            amount_out,
            in_price,
            out_price,
            max_5min_twap_divergence,
        );

        assert_eq!(result, Ok(()));

        // breaches oracle price band
        let amount_out = 79 * QUOTE_PRECISION_U64 / 20000;

        let result = validate_price_bands_for_swap(
            &in_market,
            &out_market,
            amount_in,
            amount_out,
            in_price,
            out_price,
            max_5min_twap_divergence,
        );

        assert_eq!(result, Err(ErrorCode::PriceBandsBreached));

        // breaches twap price band
        let amount_out = 49 * QUOTE_PRECISION_U64 / 20000;
        let in_price = 49 * PRICE_PRECISION_I64;

        let result = validate_price_bands_for_swap(
            &in_market,
            &out_market,
            amount_in,
            amount_out,
            in_price,
            out_price,
            max_5min_twap_divergence,
        );

        assert_eq!(result, Err(ErrorCode::PriceBandsBreached));
    }
}
