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
use anchor_lang::prelude::msg;
use crate::math::lp::calculate_settled_lp_base_quote;
use crate::math::lp::compute_settle_lp_metrics;

pub fn settle_lp_position(
    position: &mut MarketPosition,
    market: &mut Market,
) -> ClearingHouseResult<()> {
    let n_shares = position.lp_shares;
    let n_shares_i128 = cast_to_i128(n_shares)?;

    let lp_metrics = compute_settle_lp_metrics(position, market)?;

    position.last_net_base_asset_amount_per_lp =
        market.amm.market_position_per_lp.base_asset_amount;
    position.last_net_quote_asset_amount_per_lp =
        market.amm.market_position_per_lp.quote_asset_amount;
    position.last_unsettled_pnl_per_lp = market.amm.market_position_per_lp.unsettled_pnl;

    let remainder_quote_asset_amount_per_lp = lp_metrics.remainder_quote_asset_amount
        .checked_mul(AMM_RESERVE_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(n_shares)
        .ok_or_else(math_error!())?;

    let remainder_base_asset_amount_per_lp = lp_metrics.remainder_base_asset_amount
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

    let position_delta = PositionDelta {
        base_asset_amount: lp_metrics.base_asset_amount, 
        quote_asset_amount: lp_metrics.quote_asset_amount
    };
    let upnl = update_position_and_market(position, market, &position_delta)?;
    let unsettled_pnl = lp_metrics.unsettled_pnl.checked_add(upnl).ok_or_else(math_error!())?;
    update_unsettled_pnl(position, market, unsettled_pnl)?;

    // 
    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
        .checked_add(lp_metrics.base_asset_amount)
        .ok_or_else(math_error!())?;

    market.amm.net_unsettled_lp_base_asset_amount = market
        .amm
        .net_unsettled_lp_base_asset_amount
        .checked_sub(lp_metrics.base_asset_amount)
        .ok_or_else(math_error!())?;

    Ok(())
}

//         // margin 
//     // let (new_quote_asset_amount, new_quote_entry_amount, new_base_asset_amount, pnl) =
//     // calculate_position_new_quote_base_pnl(position, delta)?;
//     Ok(())
// }

pub fn burn_lp_shares(
    position: &mut MarketPosition,
    market: &mut Market,
    shares_to_burn: u128,
) -> ClearingHouseResult<()> {
    settle_lp_position(position, market)?;

    // clean up dust
    let (base_asset_amount, quote_asset_amount) =
        calculate_settled_lp_base_quote(&market.amm, position)?;

    // update stats
    market.amm.net_unsettled_lp_base_asset_amount = market
        .amm
        .net_unsettled_lp_base_asset_amount
        .checked_sub(base_asset_amount)
        .ok_or_else(math_error!())?;

    // liquidate dust position
    let unsettled_pnl = -cast_to_i128(quote_asset_amount)?
        .checked_add(1)
        .ok_or_else(math_error!())?;
    update_unsettled_pnl(position, market, unsettled_pnl)?;

    // update last_ metrics
    position.last_net_base_asset_amount_per_lp =
        market.amm.market_position_per_lp.base_asset_amount;
    position.last_net_quote_asset_amount_per_lp =
        market.amm.market_position_per_lp.quote_asset_amount;

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
