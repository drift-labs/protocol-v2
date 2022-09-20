use crate::controller::position::PositionDirection;
use crate::error::ClearingHouseResult;
use crate::math::orders::standardize_base_asset_amount;
use crate::math_error;
use crate::state::market::PerpMarket;
use solana_program::msg;

use super::casting::cast_to_u128;

// assumption: market.amm.amm_jit_is_active() == true
// assumption: taker_baa will improve market balance (see orders.rs & amm_wants_to_make)
pub fn calculate_jit_base_asset_amount(
    market: &PerpMarket,
    taker_base_asset_amount: u128,
    maker_fill_price: u128,
    valid_oracle_price: Option<i128>,
    taker_direction: PositionDirection,
) -> ClearingHouseResult<u128> {
    let mut max_jit_amount = taker_base_asset_amount;

    // check for wash trade
    // simple impl: half max jit amount when likely to be wash
    if let Some(oracle_price) = valid_oracle_price {
        let oracle_price = cast_to_u128(oracle_price)?;

        // maker taking a short below oracle = likely to be a wash
        if taker_direction == PositionDirection::Long && maker_fill_price < oracle_price {
            max_jit_amount = max_jit_amount.checked_div(2).ok_or_else(math_error!())?
        } else if taker_direction == PositionDirection::Short && maker_fill_price > oracle_price {
            max_jit_amount = max_jit_amount.checked_div(2).ok_or_else(math_error!())?
        }
    } else {
        // todo: what to do when oracle price is invalid? probs dont take anything?
        max_jit_amount = 0;
    };

    if max_jit_amount == 0 {
        return Ok(0);
    }

    // check for market imbalance
    // min/max_baa
    let base_reserve_length = market.amm.max_base_asset_reserve - market.amm.min_base_asset_reserve;
    let half_base_reserve_length = base_reserve_length
        .checked_div(2)
        .ok_or_else(math_error!())?;
    let mid_reserve = market.amm.min_base_asset_reserve + half_base_reserve_length;

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

    let damm_is_imbalanced = base_reserve <= mid_reserve - fourth_base_reserve_length
        || base_reserve >= mid_reserve + fourth_base_reserve_length;
    let mut jit_base_asset_amount = if damm_is_imbalanced {
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
