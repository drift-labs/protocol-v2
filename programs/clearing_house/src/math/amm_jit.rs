use crate::controller::position::PositionDirection;
use crate::error::ClearingHouseResult;
use crate::math::casting::cast_to_u128;
use crate::math::orders::standardize_base_asset_amount;
use crate::math_error;
use crate::state::market::PerpMarket;
use solana_program::msg;

// assumption: market.amm.amm_jit_is_active() == true
// assumption: taker_baa will improve market balance (see orders.rs & amm_wants_to_make)
pub fn calculate_jit_base_asset_amount(
    market: &PerpMarket,
    taker_base_asset_amount: u128,
    auction_price: u128,
    valid_oracle_price: Option<i128>,
    taker_direction: PositionDirection,
) -> ClearingHouseResult<u128> {
    let mut max_jit_amount = taker_base_asset_amount;

    // check for wash trade
    // simple impl: half max jit amount when likely to be wash
    if let Some(oracle_price) = valid_oracle_price {
        let oracle_price = cast_to_u128(oracle_price)?;

        // maker taking a short below oracle = likely to be a wash
        if taker_direction == PositionDirection::Long && auction_price < oracle_price {
            max_jit_amount = max_jit_amount.checked_div(4).ok_or_else(math_error!())?
        } else if taker_direction == PositionDirection::Short && auction_price > oracle_price {
            max_jit_amount = max_jit_amount.checked_div(4).ok_or_else(math_error!())?
        }
    } else {
        max_jit_amount = 0;
    };

    if max_jit_amount == 0 {
        return Ok(0);
    }

    // check for market imbalance
    // min/max_baa
    let base_reserve_length = market
        .amm
        .max_base_asset_reserve
        .checked_sub(market.amm.min_base_asset_reserve)
        .ok_or_else(math_error!())?;

    let half_base_reserve_length = base_reserve_length
        .checked_div(2)
        .ok_or_else(math_error!())?;

    let mid_reserve = market
        .amm
        .min_base_asset_reserve
        .checked_add(half_base_reserve_length)
        .ok_or_else(math_error!())?;

    let fourth_base_reserve_length = base_reserve_length
        .checked_div(4)
        .ok_or_else(math_error!())?;

    let base_reserve = market.amm.base_asset_reserve;

    // min | --|-- mid --|-- | max
    //       ^             ^
    // if bar is in these quadrents = imbalanced so we take more baa
    // simple impl:
    // if we balanced we take 1/4
    // if we not balanced we take 1/2

    let imbalance_lower_bound = mid_reserve
        .checked_sub(fourth_base_reserve_length)
        .ok_or_else(math_error!())?;

    let imbalance_upper_bound = mid_reserve
        .checked_add(fourth_base_reserve_length)
        .ok_or_else(math_error!())?;

    let amm_is_imbalanced =
        base_reserve < imbalance_lower_bound || base_reserve > imbalance_upper_bound;

    let mut jit_base_asset_amount = if amm_is_imbalanced {
        taker_base_asset_amount
            .checked_div(2)
            .ok_or_else(math_error!())?
    } else {
        taker_base_asset_amount
            .checked_div(4)
            .ok_or_else(math_error!())?
    };

    if jit_base_asset_amount == 0 {
        return Ok(0);
    }

    jit_base_asset_amount =
        calculate_clampped_jit_base_asset_amount(market, jit_base_asset_amount)?;

    jit_base_asset_amount = jit_base_asset_amount.min(max_jit_amount);

    // last step we always standardize
    jit_base_asset_amount = standardize_base_asset_amount(
        jit_base_asset_amount,
        market.amm.base_asset_amount_step_size,
    )?;

    Ok(jit_base_asset_amount)
}

// assumption: taker_baa will improve market balance (see orders.rs & amm_wants_to_make)
// note: we split it into two (calc and clamp) bc its easier to maintain tests
pub fn calculate_clampped_jit_base_asset_amount(
    market: &PerpMarket,
    jit_base_asset_amount: u128,
) -> ClearingHouseResult<u128> {
    // apply intensity
    // todo more efficient method do here
    let jit_base_asset_amount = jit_base_asset_amount
        .checked_mul(market.amm.amm_jit_intensity as u128)
        .ok_or_else(math_error!())?
        .checked_div(100)
        .ok_or_else(math_error!())?;

    // bound it; dont flip the net_baa
    let max_amm_base_asset_amount = market.amm.net_base_asset_amount.unsigned_abs();
    let jit_base_asset_amount = jit_base_asset_amount.min(max_amm_base_asset_amount);

    Ok(jit_base_asset_amount)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::state::market::AMM;

    #[test]
    fn invalid_oracle_test() {
        let market = PerpMarket {
            amm: AMM {
                net_base_asset_amount: 100,
                amm_jit_intensity: 100,
                min_base_asset_reserve: 50,
                max_base_asset_reserve: 100,
                base_asset_reserve: 75, // perf half balanced
                ..AMM::default_test()
            },
            ..PerpMarket::default()
        };

        let jit_baa_balanced = calculate_jit_base_asset_amount(
            &market,
            100,
            200,
            None, // invalid oracle ...
            PositionDirection::Short,
        )
        .unwrap();

        assert_eq!(jit_baa_balanced, 0);
    }

    #[test]
    fn imbalanced_short_amm_jit() {
        let mut market = PerpMarket {
            amm: AMM {
                net_base_asset_amount: 100,
                amm_jit_intensity: 100,
                min_base_asset_reserve: 50,
                max_base_asset_reserve: 100,
                base_asset_reserve: 75, // perf half balanced
                ..AMM::default_test()
            },
            ..PerpMarket::default()
        };

        let jit_baa_balanced =
            calculate_jit_base_asset_amount(&market, 100, 200, Some(300), PositionDirection::Short)
                .unwrap();

        let base_reserve_length =
            market.amm.max_base_asset_reserve - market.amm.min_base_asset_reserve;
        let half_base_reserve_length = base_reserve_length
            .checked_div(2)
            .ok_or_else(math_error!())
            .unwrap();
        let mid_reserve = market.amm.min_base_asset_reserve + half_base_reserve_length;
        let fourth_base_reserve_length = base_reserve_length
            .checked_div(4)
            .ok_or_else(math_error!())
            .unwrap();

        // make it imbalanced
        market.amm.base_asset_reserve = mid_reserve + fourth_base_reserve_length + 1;

        let jit_baa_imbalanced =
            calculate_jit_base_asset_amount(&market, 100, 200, Some(300), PositionDirection::Short)
                .unwrap();

        // take more when imbalanced
        assert!(
            jit_baa_balanced < jit_baa_imbalanced,
            "{} {}",
            jit_baa_balanced,
            jit_baa_imbalanced,
        );

        // make it imbalanced
        market.amm.base_asset_reserve = mid_reserve - fourth_base_reserve_length - 1;
        let jit_baa_imbalanced =
            calculate_jit_base_asset_amount(&market, 100, 200, Some(300), PositionDirection::Short)
                .unwrap();

        // take more when imbalanced
        assert!(
            jit_baa_balanced < jit_baa_imbalanced,
            "{} {}",
            jit_baa_balanced,
            jit_baa_imbalanced,
        );
    }

    #[test]
    fn imbalanced_long_amm_jit() {
        let mut market = PerpMarket {
            amm: AMM {
                net_base_asset_amount: 100,
                amm_jit_intensity: 100,
                min_base_asset_reserve: 50,
                max_base_asset_reserve: 100,
                base_asset_reserve: 75, // perf half balanced
                ..AMM::default_test()
            },
            ..PerpMarket::default()
        };

        let jit_baa_balanced =
            calculate_jit_base_asset_amount(&market, 100, 200, Some(100), PositionDirection::Long)
                .unwrap();

        let base_reserve_length =
            market.amm.max_base_asset_reserve - market.amm.min_base_asset_reserve;
        let half_base_reserve_length = base_reserve_length
            .checked_div(2)
            .ok_or_else(math_error!())
            .unwrap();
        let mid_reserve = market.amm.min_base_asset_reserve + half_base_reserve_length;
        let fourth_base_reserve_length = base_reserve_length
            .checked_div(4)
            .ok_or_else(math_error!())
            .unwrap();

        // make it imbalanced
        market.amm.base_asset_reserve = mid_reserve + fourth_base_reserve_length + 1;

        let jit_baa_imbalanced =
            calculate_jit_base_asset_amount(&market, 100, 200, Some(100), PositionDirection::Long)
                .unwrap();

        // take more when imbalanced
        assert!(
            jit_baa_balanced < jit_baa_imbalanced,
            "{} {}",
            jit_baa_balanced,
            jit_baa_imbalanced,
        );

        // make it imbalanced
        market.amm.base_asset_reserve = mid_reserve - fourth_base_reserve_length - 1;
        let jit_baa_imbalanced =
            calculate_jit_base_asset_amount(&market, 100, 200, Some(100), PositionDirection::Long)
                .unwrap();

        // take more when imbalanced
        assert!(
            jit_baa_balanced < jit_baa_imbalanced,
            "{} {}",
            jit_baa_balanced,
            jit_baa_imbalanced,
        );
    }

    #[test]
    fn wash_trade_long_amm_jit() {
        let market = PerpMarket {
            amm: AMM {
                net_base_asset_amount: -100,
                amm_jit_intensity: 100,
                ..AMM::default_test()
            },
            ..PerpMarket::default()
        };

        let jit_baa_no_wash =
            calculate_jit_base_asset_amount(&market, 100, 200, Some(100), PositionDirection::Long)
                .unwrap();

        let jit_baa_wash =
            calculate_jit_base_asset_amount(&market, 100, 50, Some(100), PositionDirection::Long)
                .unwrap();

        assert!(
            jit_baa_no_wash > jit_baa_wash,
            "{} {}",
            jit_baa_no_wash,
            jit_baa_wash
        );
    }

    #[test]
    fn wash_trade_short_amm_jit() {
        let market = PerpMarket {
            amm: AMM {
                net_base_asset_amount: 100,
                amm_jit_intensity: 100,
                ..AMM::default_test()
            },
            ..PerpMarket::default()
        };

        let jit_baa_no_wash =
            calculate_jit_base_asset_amount(&market, 100, 100, Some(200), PositionDirection::Short)
                .unwrap();

        // fill above oracle
        let jit_baa_wash =
            calculate_jit_base_asset_amount(&market, 100, 200, Some(100), PositionDirection::Short)
                .unwrap();

        assert!(jit_baa_no_wash > jit_baa_wash);
    }

    #[test]
    fn balanced_market_zero_jit() {
        let market = PerpMarket {
            amm: AMM {
                net_base_asset_amount: 0,
                amm_jit_intensity: 100,
                ..AMM::default_test()
            },
            ..PerpMarket::default()
        };
        let jit_base_asset_amount = 100;

        let jit_amount =
            calculate_clampped_jit_base_asset_amount(&market, jit_base_asset_amount).unwrap();
        assert_eq!(jit_amount, 0);
    }

    #[test]
    fn balanced_market_zero_intensity() {
        let market = PerpMarket {
            amm: AMM {
                net_base_asset_amount: 100,
                amm_jit_intensity: 0,
                ..AMM::default_test()
            },
            ..PerpMarket::default()
        };
        let jit_base_asset_amount = 100;

        let jit_amount =
            calculate_clampped_jit_base_asset_amount(&market, jit_base_asset_amount).unwrap();
        assert_eq!(jit_amount, 0);
    }

    #[test]
    fn balanced_market_full_intensity() {
        let market = PerpMarket {
            amm: AMM {
                net_base_asset_amount: 100,
                amm_jit_intensity: 100,
                ..AMM::default_test()
            },
            ..PerpMarket::default()
        };
        let jit_base_asset_amount = 100;

        let jit_amount =
            calculate_clampped_jit_base_asset_amount(&market, jit_base_asset_amount).unwrap();
        assert_eq!(jit_amount, 100);
    }

    #[test]
    fn balanced_market_half_intensity() {
        let market = PerpMarket {
            amm: AMM {
                net_base_asset_amount: 100,
                amm_jit_intensity: 50,
                ..AMM::default_test()
            },
            ..PerpMarket::default()
        };
        let jit_base_asset_amount = 100;

        let jit_amount =
            calculate_clampped_jit_base_asset_amount(&market, jit_base_asset_amount).unwrap();
        assert_eq!(jit_amount, 50);
    }
}
