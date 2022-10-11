use anchor_lang::prelude::{msg, Pubkey};

use crate::bn::U192;
use crate::controller::position::PositionDelta;
use crate::controller::position::{update_position_and_market, update_quote_asset_amount};
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::get_struct_values;
use crate::math::casting::Cast;
use crate::math::cp_curve::{get_update_k_result, update_k};
use crate::math::lp::calculate_settle_lp_metrics;
use crate::math::position::calculate_base_asset_value_with_oracle_price;
use crate::math_error;
use crate::state::events::{LPAction, LPRecord};
use crate::state::perp_market::PerpMarket;
use crate::state::user::PerpPosition;
use crate::state::user::User;

#[cfg(test)]
mod tests;

pub fn mint_lp_shares(
    position: &mut PerpPosition,
    market: &mut PerpMarket,
    n_shares: u64,
) -> ClearingHouseResult<()> {
    let amm = market.amm;

    let (sqrt_k,) = get_struct_values!(amm, sqrt_k);

    if position.lp_shares > 0 {
        settle_lp_position(position, market)?;
    } else {
        position.last_net_base_asset_amount_per_lp = amm.base_asset_amount_per_lp.cast()?;
        position.last_net_quote_asset_amount_per_lp = amm.quote_asset_amount_per_lp.cast()?;
    }

    // add share balance
    position.lp_shares = position
        .lp_shares
        .checked_add(n_shares)
        .ok_or_else(math_error!())?;

    // update market state
    let new_sqrt_k = sqrt_k
        .checked_add(n_shares.cast()?)
        .ok_or_else(math_error!())?;
    let new_sqrt_k_u192 = U192::from(new_sqrt_k);

    let update_k_result = get_update_k_result(market, new_sqrt_k_u192, true)?;
    update_k(market, &update_k_result)?;

    market.amm.user_lp_shares = market
        .amm
        .user_lp_shares
        .checked_add(n_shares.cast()?)
        .ok_or_else(math_error!())?;

    crate::controller::validate::validate_market_account(market)?;
    crate::controller::validate::validate_position_account(position, market)?;

    Ok(())
}

pub fn settle_lp_position(
    position: &mut PerpPosition,
    market: &mut PerpMarket,
) -> ClearingHouseResult<(PositionDelta, i64)> {
    let mut lp_metrics = calculate_settle_lp_metrics(&market.amm, position)?;

    position.remainder_base_asset_amount = position
        .remainder_base_asset_amount
        .checked_add(lp_metrics.remainder_base_asset_amount)
        .ok_or_else(math_error!())?;

    if position.remainder_base_asset_amount.unsigned_abs() >= market.amm.order_step_size.cast()? {
        let (standardized_remainder_base_asset_amount, remainder_base_asset_amount) =
            crate::math::orders::standardize_base_asset_amount_with_remainder_i128(
                position.remainder_base_asset_amount.cast()?,
                market.amm.order_step_size.cast()?,
            )?;

        lp_metrics.base_asset_amount = lp_metrics
            .base_asset_amount
            .checked_add(standardized_remainder_base_asset_amount)
            .ok_or_else(math_error!())?;

        position.remainder_base_asset_amount = remainder_base_asset_amount.cast()?;
    }

    let position_delta = PositionDelta {
        base_asset_amount: lp_metrics.base_asset_amount.cast()?,
        quote_asset_amount: lp_metrics.quote_asset_amount.cast()?,
    };

    let pnl = update_position_and_market(position, market, &position_delta)?;

    // todo: name for this is confusing, but adding is correct as is
    // definition: net position of users in the market that has the LP as a counterparty (which have NOT settled)
    market.amm.base_asset_amount_with_unsettled_lp = market
        .amm
        .base_asset_amount_with_unsettled_lp
        .checked_add(lp_metrics.base_asset_amount)
        .ok_or_else(math_error!())?;

    position.last_net_base_asset_amount_per_lp = market.amm.base_asset_amount_per_lp.cast()?;
    position.last_net_quote_asset_amount_per_lp = market.amm.quote_asset_amount_per_lp.cast()?;

    crate::controller::validate::validate_market_account(market)?;
    crate::controller::validate::validate_position_account(position, market)?;

    Ok((position_delta, pnl))
}

pub fn settle_lp(
    user: &mut User,
    user_key: &Pubkey,
    market: &mut PerpMarket,
    now: i64,
) -> ClearingHouseResult {
    if let Ok(position) = user.get_perp_position_mut(market.market_index) {
        if position.lp_shares > 0 {
            let (position_delta, pnl) = settle_lp_position(position, market)?;

            crate::emit!(LPRecord {
                ts: now,
                action: LPAction::SettleLiquidity,
                user: *user_key,
                market_index: market.market_index,
                delta_base_asset_amount: position_delta.base_asset_amount,
                delta_quote_asset_amount: position_delta.quote_asset_amount,
                pnl,
                n_shares: 0
            });
        }
    }

    Ok(())
}

// note: must settle funding before settling the lp bc
// settling the lp can take on a new position which requires funding
// to be up-to-date
pub fn settle_funding_payment_then_lp(
    user: &mut User,
    user_key: &Pubkey,
    market: &mut PerpMarket,
    now: i64,
) -> ClearingHouseResult {
    crate::controller::funding::settle_funding_payment(user, user_key, market, now)?;
    settle_lp(user, user_key, market, now)
}

pub fn burn_lp_shares(
    position: &mut PerpPosition,
    market: &mut PerpMarket,
    shares_to_burn: u64,
    oracle_price: i128,
) -> ClearingHouseResult<(PositionDelta, i64)> {
    // settle
    let (position_delta, pnl) = settle_lp_position(position, market)?;

    // clean up
    let unsettled_remainder = market
        .amm
        .base_asset_amount_with_unsettled_lp
        .cast::<i64>()?
        .checked_add(position.remainder_base_asset_amount.cast()?)
        .ok_or_else(math_error!())?;

    if shares_to_burn == market.amm.user_lp_shares.cast()? && unsettled_remainder != 0 {
        crate::validate!(
            unsettled_remainder.unsigned_abs() <= market.amm.order_step_size,
            ErrorCode::DefaultError,
            "unsettled baa on final burn too big rel to stepsize {}: {}",
            market.amm.order_step_size,
            market.amm.base_asset_amount_with_unsettled_lp,
        )?;

        // sub bc lps take the opposite side of the user
        position.remainder_base_asset_amount = position
            .remainder_base_asset_amount
            .checked_sub(unsettled_remainder.cast()?)
            .ok_or_else(math_error!())?;
    }

    // update stats
    if position.remainder_base_asset_amount != 0 {
        let base_asset_amount = position.remainder_base_asset_amount.cast::<i128>()?;

        // user closes the dust
        market.amm.base_asset_amount_with_amm = market
            .amm
            .base_asset_amount_with_amm
            .checked_sub(base_asset_amount.cast()?)
            .ok_or_else(math_error!())?;

        market.amm.base_asset_amount_with_unsettled_lp = market
            .amm
            .base_asset_amount_with_unsettled_lp
            .checked_add(base_asset_amount.cast()?)
            .ok_or_else(math_error!())?;

        position.remainder_base_asset_amount = 0;

        let dust_base_asset_value =
            calculate_base_asset_value_with_oracle_price(base_asset_amount.cast()?, oracle_price)?
                .checked_add(1) // round up
                .ok_or_else(math_error!())?;

        update_quote_asset_amount(position, market, -dust_base_asset_value.cast()?)?;
    }

    // update last_ metrics
    position.last_net_base_asset_amount_per_lp = market.amm.base_asset_amount_per_lp.cast()?;
    position.last_net_quote_asset_amount_per_lp = market.amm.quote_asset_amount_per_lp.cast()?;

    // burn shares
    position.lp_shares = position
        .lp_shares
        .checked_sub(shares_to_burn)
        .ok_or_else(math_error!())?;

    market.amm.user_lp_shares = market
        .amm
        .user_lp_shares
        .checked_sub(shares_to_burn.cast()?)
        .ok_or_else(math_error!())?;

    // update market state
    let new_sqrt_k = market
        .amm
        .sqrt_k
        .checked_sub(shares_to_burn.cast()?)
        .ok_or_else(math_error!())?;
    let new_sqrt_k_u192 = U192::from(new_sqrt_k);

    let update_k_result = get_update_k_result(market, new_sqrt_k_u192, false)?;
    update_k(market, &update_k_result)?;

    crate::controller::validate::validate_market_account(market)?;
    crate::controller::validate::validate_position_account(position, market)?;

    Ok((position_delta, pnl))
}
