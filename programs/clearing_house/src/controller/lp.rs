use crate::controller::position::update_unsettled_pnl;
use crate::error::ClearingHouseResult;
use crate::math::constants::AMM_RESERVE_PRECISION;
use crate::math::constants::AMM_RESERVE_PRECISION_I128;
use crate::math_error;
use crate::state::market::Market;
use crate::MarketPosition;

use crate::bn::U192;
use crate::controller::position::update_position_and_market;
use crate::controller::position::PositionDelta;
use crate::math::amm::{get_update_k_result, update_k};
use crate::math::casting::cast_to_i128;
use crate::math::orders::standardize_base_asset_amount_with_remainder_i128;
use anchor_lang::prelude::msg;

use crate::state::market::AMM;

pub fn calculate_settled_lp_base_quote(
    amm: &AMM,
    position: &MarketPosition,
) -> ClearingHouseResult<(i128, u128)> {
    let total_lp_shares = amm.sqrt_k;
    let n_shares = position.lp_shares;
    let n_shares_i128 = cast_to_i128(n_shares)?;

    // give them slice of the damm market position
    let amm_net_base_asset_amount_per_lp = amm
        .market_position_per_lp
        .base_asset_amount
        .checked_sub(position.last_net_base_asset_amount_per_lp)
        .ok_or_else(math_error!())?;

    let base_asset_amount = amm_net_base_asset_amount_per_lp
        .checked_mul(n_shares_i128)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION_I128)
        .ok_or_else(math_error!())?;

    let amm_net_quote_asset_amount_per_lp = if amm.market_position_per_lp.base_asset_amount.signum()
        == position.last_net_base_asset_amount_per_lp.signum()
    {
        if position.last_net_base_asset_amount_per_lp.unsigned_abs()
            > amm.market_position_per_lp.base_asset_amount.unsigned_abs()
        {
            position
                .last_net_quote_asset_amount_per_lp
                .checked_sub(amm.market_position_per_lp.quote_asset_amount)
                .ok_or_else(math_error!())?
        } else {
            amm.market_position_per_lp
                .quote_asset_amount
                .checked_sub(position.last_net_quote_asset_amount_per_lp)
                .ok_or_else(math_error!())?
        }
    } else {
        amm.market_position_per_lp
            .quote_asset_amount
            .checked_add(position.last_net_quote_asset_amount_per_lp)
            .ok_or_else(math_error!())?
    };

    let quote_asset_amount = amm_net_quote_asset_amount_per_lp
        .checked_mul(n_shares)
        .ok_or_else(math_error!())?
        .checked_div(total_lp_shares)
        .ok_or_else(math_error!())?;

    Ok((base_asset_amount, quote_asset_amount))
}

pub fn settle_lp_position(
    position: &mut MarketPosition,
    market: &mut Market,
) -> ClearingHouseResult<()> {
    let amm = &mut market.amm;

    let n_shares = position.lp_shares;
    let n_shares_i128 = cast_to_i128(n_shares)?;

    // give them fees
    let mut unsettled_pnl = amm
        .market_position_per_lp
        .unsettled_pnl
        .checked_sub(position.last_unsettled_pnl_per_lp)
        .ok_or_else(math_error!())?
        .checked_mul(n_shares_i128)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION_I128)
        .ok_or_else(math_error!())?;

    let (base_asset_amount, quote_asset_amount) = calculate_settled_lp_base_quote(amm, position)?;

    // stepsize it
    let (standardized_base_asset_amount, remainder_base_asset_amount) =
        standardize_base_asset_amount_with_remainder_i128(
            base_asset_amount,
            amm.base_asset_amount_step_size,
        )?;

    let _min_qaa = amm.minimum_quote_asset_trade_size; // todo: uses reserve precision -- see note:
    let min_baa = cast_to_i128(amm.base_asset_amount_step_size)?;

    position.last_net_base_asset_amount_per_lp =
        market.amm.market_position_per_lp.base_asset_amount;
    position.last_net_quote_asset_amount_per_lp =
        market.amm.market_position_per_lp.quote_asset_amount;
    position.last_unsettled_pnl_per_lp = market.amm.market_position_per_lp.unsettled_pnl;

    // note: since pnl may go into the qaa of a position its not really fair to ensure qaa >= min_qaa 
    let (remainder_base_asset_amount, remainder_quote_asset_amount) = if standardized_base_asset_amount >= min_baa {
        // compute quote amount in remainder
        let remainder_ratio = remainder_base_asset_amount
            .unsigned_abs()
            .checked_mul(AMM_RESERVE_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(base_asset_amount.unsigned_abs())
            .ok_or_else(math_error!())?;
        
        msg!("remainder ratio: {}", remainder_ratio);

        let remainder_quote_asset_amount = quote_asset_amount
            .checked_mul(remainder_ratio)
            .ok_or_else(math_error!())?
            .checked_div(AMM_RESERVE_PRECISION)
            .ok_or_else(math_error!())?;

        (remainder_base_asset_amount, remainder_quote_asset_amount)
    } else { 
        (base_asset_amount, quote_asset_amount)
    };

    let standardized_quote_asset_amount = quote_asset_amount
        .checked_sub(remainder_quote_asset_amount)
        .ok_or_else(math_error!())?;
    
    let standardized_base_asset_amount = base_asset_amount 
        .checked_sub(remainder_base_asset_amount)
        .ok_or_else(math_error!())?;
    
    msg!("std qaa, full qaa, remainder qaa: {} {} {}", standardized_quote_asset_amount, quote_asset_amount, remainder_quote_asset_amount);

    let remainder_quote_asset_amount_per_lp = remainder_quote_asset_amount
        .checked_mul(AMM_RESERVE_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(n_shares)
        .ok_or_else(math_error!())?;

    let remainder_base_asset_amount_per_lp = remainder_base_asset_amount
        .checked_mul(AMM_RESERVE_PRECISION_I128)
        .ok_or_else(math_error!())?
        .checked_div(n_shares_i128)
        .ok_or_else(math_error!())?;

    // put the remainder back into the last_ for future burns
    position.last_net_base_asset_amount_per_lp = position
        .last_net_base_asset_amount_per_lp
        .checked_sub(remainder_base_asset_amount_per_lp)
        .ok_or_else(math_error!())?;

    position.last_net_quote_asset_amount_per_lp = position
        .last_net_quote_asset_amount_per_lp
        .checked_sub(remainder_quote_asset_amount_per_lp)
        .ok_or_else(math_error!())?;

    // put the standardized into the position
    let position_delta = PositionDelta {
        base_asset_amount: standardized_base_asset_amount, 
        quote_asset_amount: standardized_quote_asset_amount,
    };

    let upnl = update_position_and_market(position, market, &position_delta)?;
    unsettled_pnl = unsettled_pnl.checked_add(upnl).ok_or_else(math_error!())?;
    update_unsettled_pnl(position, market, unsettled_pnl)?;

    market.amm.net_unsettled_lp_base_asset_amount = market
        .amm
        .net_unsettled_lp_base_asset_amount
        .checked_sub(standardized_base_asset_amount)
        .ok_or_else(math_error!())?;

    Ok(())
}

pub fn burn_lp_shares(
    position: &mut MarketPosition,
    market: &mut Market,
    shares_to_burn: u128,
) -> ClearingHouseResult<()> {
    settle_lp_position(position, market)?;

    // clean up dust 
    let (base_asset_amount, quote_asset_amount) = calculate_settled_lp_base_quote(&market.amm, position)?;

    // update stats
    market.amm.net_unsettled_lp_base_asset_amount = market
        .amm
        .net_unsettled_lp_base_asset_amount
        .checked_sub(base_asset_amount)
        .ok_or_else(math_error!())?;

    // liquidate dust position
    let unsettled_pnl = -cast_to_i128(quote_asset_amount)?.checked_add(1).ok_or_else(math_error!())?;
    update_unsettled_pnl(position, market, unsettled_pnl)?;

    // update last_ metrics
    position.last_net_base_asset_amount_per_lp =
        market.amm.market_position_per_lp.base_asset_amount;
    position.last_net_quote_asset_amount_per_lp =
        market.amm.market_position_per_lp.quote_asset_amount;
    position.last_unsettled_pnl_per_lp = market.amm.market_position_per_lp.unsettled_pnl;

    // burn shares
    position.lp_shares = position
        .lp_shares
        .checked_sub(shares_to_burn)
        .ok_or_else(math_error!())?;

    market.amm.user_lp_shares = market
        .amm
        .user_lp_shares
        .checked_sub(shares_to_burn)
        .ok_or_else(math_error!())?;

    // update market state
    let new_sqrt_k = market
        .amm
        .sqrt_k
        .checked_sub(shares_to_burn)
        .ok_or_else(math_error!())?;
    let new_sqrt_k_u192 = U192::from(new_sqrt_k);

    let update_k_result = get_update_k_result(market, new_sqrt_k_u192, false)?;
    update_k(market, &update_k_result)?;

    Ok(())
}
