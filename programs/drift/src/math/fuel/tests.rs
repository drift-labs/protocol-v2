mod calculate_perp_fuel_bonus {
    use crate::math::fuel::calculate_perp_fuel_bonus;
    use crate::state::perp_market::PerpMarket;
    use crate::{FUEL_WINDOW_U128, QUOTE_PRECISION_I128};

    #[test]
    fn test() {
        let mut perp_market = PerpMarket::default();
        perp_market.fuel_boost_position = 1;
        let bonus =
            calculate_perp_fuel_bonus(&perp_market, QUOTE_PRECISION_I128, FUEL_WINDOW_U128 as i64)
                .unwrap();
        assert_eq!(bonus, 10);
    }
}

mod calculate_spot_fuel_bonus {
    use crate::math::fuel::calculate_spot_fuel_bonus;

    use crate::state::spot_market::SpotMarket;
    use crate::{FUEL_WINDOW_U128, QUOTE_PRECISION_I128};

    #[test]
    fn test() {
        let mut spot_market = SpotMarket::default();
        spot_market.fuel_boost_deposits = 1;
        let bonus =
            calculate_spot_fuel_bonus(&spot_market, QUOTE_PRECISION_I128, FUEL_WINDOW_U128 as i64)
                .unwrap();
        assert_eq!(bonus, 10);

        spot_market.fuel_boost_borrows = 1;

        let bonus =
            calculate_spot_fuel_bonus(&spot_market, -QUOTE_PRECISION_I128, FUEL_WINDOW_U128 as i64)
                .unwrap();
        assert_eq!(bonus, 10);
    }
}

mod calculate_insurance_fuel_bonus {
    use crate::math::fuel::calculate_insurance_fuel_bonus;

    use crate::state::spot_market::SpotMarket;
    use crate::{FUEL_WINDOW_U128, QUOTE_PRECISION_U64};

    #[test]
    fn test() {
        let mut spot_market = SpotMarket::default();
        spot_market.fuel_boost_insurance = 1;
        let bonus = calculate_insurance_fuel_bonus(
            &spot_market,
            QUOTE_PRECISION_U64,
            0,
            FUEL_WINDOW_U128 as u32,
        )
        .unwrap();
        assert_eq!(bonus, 10);
    }
}
