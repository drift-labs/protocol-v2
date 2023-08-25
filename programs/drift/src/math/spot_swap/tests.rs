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

        let strict_usdc_price = StrictOraclePrice {
            current: usdc_price,
            twap_5min: None,
        };

        let strict_sol_price = StrictOraclePrice {
            current: sol_price,
            twap_5min: None,
        };

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

        let strict_usdc_price = StrictOraclePrice {
            current: usdc_price,
            twap_5min: None,
        };

        let strict_sol_price = StrictOraclePrice {
            current: sol_price,
            twap_5min: None,
        };

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

        let strict_usdc_price = StrictOraclePrice {
            current: usdc_price,
            twap_5min: None,
        };

        let strict_sol_price = StrictOraclePrice {
            current: sol_price,
            twap_5min: None,
        };

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

        let strict_usdc_price = StrictOraclePrice {
            current: usdc_price,
            twap_5min: None,
        };

        let strict_sol_price = StrictOraclePrice {
            current: sol_price,
            twap_5min: None,
        };

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
