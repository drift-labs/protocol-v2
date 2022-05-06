use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::{amm, repeg};

use crate::math::constants::{
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR,
};
use crate::math_error;
use crate::state::market::Market;

use crate::state::state::OracleGuardRails;

use crate::math::casting::cast_to_u128;
use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

pub fn repeg(
    market: &mut Market,
    price_oracle: &AccountInfo,
    new_peg_candidate: u128,
    clock_slot: u64,
    oracle_guard_rails: &OracleGuardRails,
) -> ClearingHouseResult<i128> {
    if new_peg_candidate == market.amm.peg_multiplier {
        return Err(ErrorCode::InvalidRepegRedundant);
    }

    let terminal_price_before = amm::calculate_terminal_price(market)?;

    let adjustment_cost = repeg::adjust_peg_cost(market, new_peg_candidate)?;

    let oracle_price_data = &market.amm.get_oracle_price(price_oracle, clock_slot)?;
    let oracle_price = oracle_price_data.price;
    let oracle_conf = oracle_price_data.confidence;
    let oracle_is_valid =
        amm::is_oracle_valid(&market.amm, oracle_price_data, &oracle_guard_rails.validity)?;

    // if oracle is valid: check on size/direction of repeg
    if oracle_is_valid {
        let terminal_price_after = amm::calculate_terminal_price(market)?;

        let mark_price_after = amm::calculate_price(
            market.amm.quote_asset_reserve,
            market.amm.base_asset_reserve,
            market.amm.peg_multiplier,
        )?;

        let oracle_conf_band_top = cast_to_u128(oracle_price)?
            .checked_add(oracle_conf)
            .ok_or_else(math_error!())?;

        let oracle_conf_band_bottom = cast_to_u128(oracle_price)?
            .checked_sub(oracle_conf)
            .ok_or_else(math_error!())?;

        if cast_to_u128(oracle_price)? > terminal_price_after {
            // only allow terminal up when oracle is higher
            if terminal_price_after < terminal_price_before {
                return Err(ErrorCode::InvalidRepegDirection);
            }

            // only push terminal up to top of oracle confidence band
            if oracle_conf_band_bottom < terminal_price_after {
                return Err(ErrorCode::InvalidRepegProfitability);
            }

            // only push mark up to top of oracle confidence band
            if mark_price_after > oracle_conf_band_top {
                return Err(ErrorCode::InvalidRepegProfitability);
            }
        }

        if cast_to_u128(oracle_price)? < terminal_price_after {
            // only allow terminal down when oracle is lower
            if terminal_price_after > terminal_price_before {
                return Err(ErrorCode::InvalidRepegDirection);
            }

            // only push terminal down to top of oracle confidence band
            if oracle_conf_band_top > terminal_price_after {
                return Err(ErrorCode::InvalidRepegProfitability);
            }

            // only push mark down to bottom of oracle confidence band
            if mark_price_after < oracle_conf_band_bottom {
                return Err(ErrorCode::InvalidRepegProfitability);
            }
        }
    }

    // Reduce pnl to quote asset precision and take the absolute value
    if adjustment_cost > 0 {
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_sub(adjustment_cost.unsigned_abs())
            .or(Some(0))
            .ok_or_else(math_error!())?;

        // Only a portion of the protocol fees are allocated to repegging
        // This checks that the total_fee_minus_distributions does not decrease too much after repeg
        if market.amm.total_fee_minus_distributions
            < market
                .amm
                .total_fee
                .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)
                .ok_or_else(math_error!())?
                .checked_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)
                .ok_or_else(math_error!())?
        {
            return Err(ErrorCode::InvalidRepegProfitability);
        }
    } else {
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(adjustment_cost.unsigned_abs())
            .ok_or_else(math_error!())?;
    }

    Ok(adjustment_cost)
}
