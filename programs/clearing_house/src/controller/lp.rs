use crate::controller::position::update_unsettled_pnl;
use crate::error::ClearingHouseResult;
use crate::math::lp::get_lp_metrics;
use crate::math::lp::{get_proportion_i128, get_proportion_u128, update_lp_position};
use crate::math_error;
use crate::state::market::Market;
use crate::MarketPosition;

use crate::bn::U192;
use crate::controller::position::update_position_and_market;
use crate::controller::position::PositionDelta;
use crate::math::amm::{get_update_k_result, update_k};

use anchor_lang::prelude::msg;

pub fn settle_lp_position(
    position: &mut MarketPosition,
    market: &mut Market,
) -> ClearingHouseResult<()> {
    let amm = &mut market.amm;
    let metrics = get_lp_metrics(position, amm)?;

    // update lp market position
    let upnl = update_lp_position(position, &metrics)?;
    update_unsettled_pnl(position, market, upnl)?;

    // update last_ metrics
    position.last_cumulative_fee_per_lp = market.amm.cumulative_fee_per_lp;
    position.last_cumulative_funding_payment_per_lp = market.amm.cumulative_funding_payment_per_lp;
    position.last_cumulative_net_base_asset_amount_per_lp =
        market.amm.cumulative_net_base_asset_amount_per_lp;

    Ok(())
}

pub fn burn_lp_shares(
    position: &mut MarketPosition,
    market: &mut Market,
    shares_to_burn: u128,
) -> ClearingHouseResult<()> {
    settle_lp_position(position, market)?;

    // give them a portion of the market position
    if position.lp_base_asset_amount != 0 {
        let base_amount_acquired = get_proportion_i128(
            position.lp_base_asset_amount,
            shares_to_burn,
            position.lp_shares,
        )?;
        let quote_amount = get_proportion_u128(
            position.lp_quote_asset_amount,
            shares_to_burn,
            position.lp_shares,
        )?;

        // update lp position
        position.lp_base_asset_amount = position
            .lp_base_asset_amount
            .checked_sub(base_amount_acquired)
            .ok_or_else(math_error!())?;
        position.lp_quote_asset_amount = position
            .lp_quote_asset_amount
            .checked_sub(quote_amount)
            .ok_or_else(math_error!())?;

        // track new market position
        let position_delta = PositionDelta {
            base_asset_amount: base_amount_acquired,
            quote_asset_amount: quote_amount,
        };
        let upnl = update_position_and_market(position, market, &position_delta, true)?;

        position.unsettled_pnl = position
            .unsettled_pnl
            .checked_add(upnl)
            .ok_or_else(math_error!())?;
    }

    // burn shares
    position.lp_shares = position
        .lp_shares
        .checked_sub(shares_to_burn)
        .ok_or_else(math_error!())?;
    
    market.amm.user_lp_shares = market.amm.user_lp_shares 
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
