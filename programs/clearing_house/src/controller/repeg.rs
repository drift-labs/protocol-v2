use crate::controller;
use crate::error::*;
use crate::math;
use crate::math::bn;

use crate::math::constants::{
    AMM_ASSET_AMOUNT_PRECISION, MARK_PRICE_MANTISSA, PRICE_TO_PEG_PRECISION_RATIO,
    SHARE_OF_FEES_ALLOCATED_TO_REPEG_DENOMINATOR, SHARE_OF_FEES_ALLOCATED_TO_REPEG_NUMERATOR,
    USDC_PRECISION,
};
use crate::math_error;
use crate::state::market::Market;
use crate::state::user::MarketPosition;

use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

pub fn repeg(
    market: &mut Market,
    price_oracle: &AccountInfo,
    new_peg_candidate: u128,
    clock_slot: u64,
) -> ClearingHouseResult<i128> {
    let amm = market.amm;
    if new_peg_candidate == amm.peg_multiplier {
        return Err(ErrorCode::InvalidRepegRedundant.into());
    }

    let mut new_peg_candidate = new_peg_candidate;

    let (oracle_px, oracle_conf, _oracle_delay) =
        amm.get_oracle_price(price_oracle, 0, clock_slot)?;
    let cur_peg = amm.peg_multiplier;

    let current_mark = amm.mark_price()?;
    let perserve_price;

    if new_peg_candidate == 0 {
        // try to find semi-opt solution
        new_peg_candidate = math::repeg::find_valid_repeg(&market, oracle_px, oracle_conf)?;
        if new_peg_candidate == amm.peg_multiplier {
            return Err(ErrorCode::InvalidRepegRedundant.into());
        }
    }

    let price_spread_0 = (cur_peg as i128)
        .checked_mul(PRICE_TO_PEG_PRECISION_RATIO as i128)
        .ok_or_else(math_error!())?
        .checked_sub(oracle_px)
        .ok_or_else(math_error!())?;
    let price_spread_1 = (new_peg_candidate as i128)
        .checked_mul(PRICE_TO_PEG_PRECISION_RATIO as i128)
        .ok_or_else(math_error!())?
        .checked_sub(oracle_px)
        .ok_or_else(math_error!())?;

    if price_spread_1.abs() > price_spread_0.abs() {
        // decrease
        return Err(ErrorCode::InvalidRepegDirection.into());
    }

    let mut pnl_r = amm.cumulative_fee_realized;
    let net_market_position = market.base_asset_amount;

    let amm_pnl_mantissa = math::repeg::calculate_repeg_candidate_pnl(market, new_peg_candidate)?;
    let amm_pnl_quote_asset = amm_pnl_mantissa
        .unsigned_abs()
        .checked_div(
            MARK_PRICE_MANTISSA
                .checked_div(USDC_PRECISION)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    if net_market_position != 0 && amm_pnl_mantissa == 0 {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    }

    if amm_pnl_mantissa < 0 && amm_pnl_quote_asset == 0 {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    }

    if amm_pnl_mantissa >= 0 {
        pnl_r = pnl_r
            .checked_add(amm_pnl_quote_asset)
            .ok_or_else(math_error!())?;

        perserve_price = false;
    } else if amm_pnl_quote_asset > pnl_r {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    } else {
        pnl_r = (pnl_r)
            .checked_sub(amm_pnl_quote_asset)
            .ok_or_else(math_error!())?;
        if pnl_r
            < amm
                .cumulative_fee
                .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_REPEG_NUMERATOR)
                .ok_or_else(math_error!())?
                .checked_div(SHARE_OF_FEES_ALLOCATED_TO_REPEG_DENOMINATOR)
                .ok_or_else(math_error!())?
        {
            return Err(ErrorCode::InvalidRepegProfitability.into());
        }

        // todo: add for repeg rebate v2
        //add_repeg_rebate(market, new_peg_candidate, amm_pnl_mantissa)
        //perserve_price = true;

        perserve_price = false;
    }

    market.amm.cumulative_fee_realized = pnl_r;
    market.amm.peg_multiplier = new_peg_candidate;

    if perserve_price {
        controller::amm::move_to_price(&mut market.amm, current_mark)?;
    }

    let amm_pnl_quote_asset_signed = if amm_pnl_mantissa > 0 {
        amm_pnl_quote_asset as i128
    } else {
        (amm_pnl_quote_asset as i128)
            .checked_mul(-1)
            .ok_or_else(math_error!())?
    };

    Ok(amm_pnl_quote_asset_signed)
}

#[allow(dead_code)]
fn add_repeg_rebate(
    market: &mut Market,
    new_peg_candidate: u128,
    amm_pnl_mantissa: i128,
) -> ClearingHouseResult {
    let amm = market.amm;
    // profit sharing with only those who held the rewarded position before repeg
    if new_peg_candidate < amm.peg_multiplier {
        if market.base_asset_amount_short.unsigned_abs() > 0 {
            let repeg_profit_per_unit = bn::U256::from(amm_pnl_mantissa.unsigned_abs())
                .checked_mul(bn::U256::from(AMM_ASSET_AMOUNT_PRECISION))
                .ok_or_else(math_error!())?
                .checked_div(bn::U256::from(
                    market.base_asset_amount_short.unsigned_abs(),
                ))
                .ok_or_else(math_error!())?
                .try_to_u128()?;

            market.amm.cumulative_repeg_rebate_short = amm
                .cumulative_repeg_rebate_short
                .checked_add(repeg_profit_per_unit)
                .ok_or_else(math_error!())?;
        }
    } else {
        if market.base_asset_amount_long.unsigned_abs() > 0 {
            let repeg_profit_per_unit = bn::U256::from(amm_pnl_mantissa.unsigned_abs())
                .checked_mul(bn::U256::from(AMM_ASSET_AMOUNT_PRECISION))
                .ok_or_else(math_error!())?
                .checked_div(bn::U256::from(market.base_asset_amount_long.unsigned_abs()))
                .ok_or_else(math_error!())?
                .try_to_u128()?;

            market.amm.cumulative_repeg_rebate_long = amm
                .cumulative_repeg_rebate_long
                .checked_add(repeg_profit_per_unit)
                .ok_or_else(math_error!())?;
        }
    }

    Ok(())
}

#[allow(dead_code)]
fn settle_repeg_rebate(market_position: &mut MarketPosition, market: Market) {
    if market_position.base_asset_amount > 0
        && market_position.last_cumulative_repeg_rebate != market.amm.cumulative_repeg_rebate_long
        || market_position.base_asset_amount < 0
            && market_position.last_cumulative_repeg_rebate
                != market.amm.cumulative_repeg_rebate_short
    {
        let repeg_rebate_share = if market_position.base_asset_amount > 0 {
            market
                .amm
                .cumulative_repeg_rebate_long
                .checked_sub(market_position.last_cumulative_repeg_rebate)
                .unwrap()
        } else {
            market
                .amm
                .cumulative_repeg_rebate_short
                .checked_sub(market_position.last_cumulative_repeg_rebate)
                .unwrap()
        };
        market_position.last_cumulative_repeg_rebate = if market_position.base_asset_amount > 0 {
            market.amm.cumulative_repeg_rebate_long
        } else {
            market.amm.cumulative_repeg_rebate_short
        };

        let _repeg_rebate_share_pnl = bn::U256::from(repeg_rebate_share)
            .checked_mul(bn::U256::from(
                market_position.base_asset_amount.unsigned_abs(),
            ))
            .unwrap()
            .checked_div(bn::U256::from(AMM_ASSET_AMOUNT_PRECISION))
            .unwrap()
            .checked_div(bn::U256::from(MARK_PRICE_MANTISSA))
            .unwrap()
            .try_to_u128()
            .unwrap();

        // user_account.total_fee_paid = user_account
        //     .total_fee_paid
        //     .checked_sub(repeg_rebate_share_pnl)
        //     .unwrap();
    }
}
