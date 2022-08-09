use crate::controller::position::update_unsettled_pnl;
use crate::error::ClearingHouseResult;
use crate::math::lp::get_lp_metrics;
use crate::math::lp::LPMetrics;
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

pub fn settle_lp_position(
    position: &mut MarketPosition,
    market: &mut Market,
) -> ClearingHouseResult<()> {
    let amm = &mut market.amm;
    let metrics: LPMetrics = get_lp_metrics(position, amm)?;

    // step_amount, remainder = standardize baa
    // position_delta.baa = step_amount
    // // markets position
    // market.position.baa += remainder
    // // users position
    // market.net_baa -= remainder (market gets the ceil)

    let mut unsettled_upnl = metrics.unsettled_pnl;

    // track new market position
    let (standardized_base_asset_amount, remainder) =
        standardize_base_asset_amount_with_remainder_i128(
            metrics.base_asset_amount,
            market.amm.base_asset_amount_step_size,
        )?;

    let (position_delta, upnl) = if standardized_base_asset_amount != 0 {
        (
            PositionDelta {
                base_asset_amount: standardized_base_asset_amount,
                quote_asset_amount: metrics.quote_asset_amount,
            },
            0,
        )
    } else {
        (
            PositionDelta {
                base_asset_amount: 0,
                quote_asset_amount: 0,
            },
            -cast_to_i128(metrics.quote_asset_amount)?,
        )
    };
    unsettled_upnl = unsettled_upnl.checked_add(upnl).ok_or_else(math_error!())?;

    let upnl = update_position_and_market(position, market, &position_delta)?;
    unsettled_upnl = unsettled_upnl.checked_add(upnl).ok_or_else(math_error!())?;

    update_unsettled_pnl(position, market, unsettled_upnl)?;

    market.amm.net_unsettled_lp_base_asset_amount = market
        .amm
        .net_unsettled_lp_base_asset_amount
        .checked_sub(metrics.base_asset_amount)
        .ok_or_else(math_error!())?;

    // market gets the remainder position
    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
        .checked_sub(remainder)
        .ok_or_else(math_error!())?;

    market.amm.market_position.base_asset_amount = market
        .amm
        .market_position
        .base_asset_amount
        .checked_add(remainder)
        .ok_or_else(math_error!())?;

    // update last_ metrics
    position.last_unsettled_pnl_per_lp = market.amm.market_position_per_lp.unsettled_pnl;
    position.last_net_base_asset_amount_per_lp =
        market.amm.market_position_per_lp.base_asset_amount;
    position.last_net_quote_asset_amount_per_lp =
        market.amm.market_position_per_lp.quote_asset_amount;

    Ok(())
}

pub fn burn_lp_shares(
    position: &mut MarketPosition,
    market: &mut Market,
    shares_to_burn: u128,
) -> ClearingHouseResult<()> {
    settle_lp_position(position, market)?;

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
