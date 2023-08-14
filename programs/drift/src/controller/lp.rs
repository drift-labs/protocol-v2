use anchor_lang::prelude::{msg, Pubkey};

use crate::bn::U192;
use crate::controller;
use crate::controller::position::PositionDelta;
use crate::controller::position::{update_position_and_market, update_quote_asset_amount};
use crate::emit;
use crate::error::{DriftResult, ErrorCode};
use crate::get_struct_values;
use crate::math::casting::Cast;
use crate::math::cp_curve::{get_update_k_result, update_k};
use crate::math::lp::calculate_settle_lp_metrics;
use crate::math::position::calculate_base_asset_value_with_oracle_price;
use crate::math::safe_math::SafeMath;

use crate::state::events::{LPAction, LPRecord};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::PerpMarket;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::state::State;
use crate::state::user::PerpPosition;
use crate::state::user::User;
use crate::validate;
use anchor_lang::prelude::Account;

#[cfg(test)]
mod tests;

pub fn apply_lp_rebase_to_perp_market(
    perp_market: &mut PerpMarket,
    expo_diff: i8,
) -> DriftResult<()> {
    // target_base_asset_amount_per_lp is the only one that it doesnt get applied
    // thus changing the base of lp and without changing target_base_asset_amount_per_lp
    // causes an implied change

    if expo_diff == 0 {
        return Ok(());
    }

    perp_market.amm.per_lp_base = perp_market.amm.per_lp_base.safe_add(expo_diff)?;
    let rebase_divisor: i128 = 10_i128.pow(expo_diff.abs().cast()?);

    if expo_diff > 0 {
        perp_market.amm.base_asset_amount_per_lp = perp_market
            .amm
            .base_asset_amount_per_lp
            .safe_mul(rebase_divisor)?;

        perp_market.amm.quote_asset_amount_per_lp = perp_market
            .amm
            .quote_asset_amount_per_lp
            .safe_mul(rebase_divisor)?;

        perp_market.amm.total_fee_earned_per_lp = perp_market
            .amm
            .total_fee_earned_per_lp
            .safe_mul(rebase_divisor.cast()?)?;
    } else {
        perp_market.amm.base_asset_amount_per_lp = perp_market
            .amm
            .base_asset_amount_per_lp
            .safe_div(rebase_divisor)?;

        perp_market.amm.quote_asset_amount_per_lp = perp_market
            .amm
            .quote_asset_amount_per_lp
            .safe_div(rebase_divisor)?;

        perp_market.amm.total_fee_earned_per_lp = perp_market
            .amm
            .total_fee_earned_per_lp
            .safe_div(rebase_divisor.cast()?)?;
    }

    msg!(
        "rebasing perp market_index={} per_lp_base expo_diff={}",
        perp_market.market_index,
        expo_diff,
    );

    crate::validation::perp_market::validate_perp_market(perp_market)?;

    Ok(())
}

pub fn apply_lp_rebase_to_perp_position(
    perp_market: &PerpMarket,
    perp_position: &mut PerpPosition,
) -> DriftResult<()> {
    let expo_diff = perp_market
        .amm
        .per_lp_base
        .safe_sub(perp_position.per_lp_base)?;

    if expo_diff > 0 {
        let rebase_divisor: i64 = 10_i64.pow(expo_diff.cast()?);

        perp_position.last_base_asset_amount_per_lp = perp_position
            .last_base_asset_amount_per_lp
            .safe_mul(rebase_divisor)?;
        perp_position.last_quote_asset_amount_per_lp = perp_position
            .last_quote_asset_amount_per_lp
            .safe_mul(rebase_divisor)?;

        msg!(
            "rebasing perp position for market_index={} per_lp_base by expo_diff={}",
            perp_market.market_index,
            expo_diff,
        );
        perp_position.per_lp_base = perp_position.per_lp_base.safe_add(expo_diff)?;
    } else if expo_diff < 0 {
        let rebase_divisor: i64 = 10_i64.pow(expo_diff.abs().cast()?);

        perp_position.last_base_asset_amount_per_lp = perp_position
            .last_base_asset_amount_per_lp
            .safe_div(rebase_divisor)?;
        perp_position.last_quote_asset_amount_per_lp = perp_position
            .last_quote_asset_amount_per_lp
            .safe_div(rebase_divisor)?;

        msg!(
            "rebasing perp position for market_index={} per_lp_base by expo_diff={}",
            perp_market.market_index,
            expo_diff,
        );
        perp_position.per_lp_base = perp_position.per_lp_base.safe_add(expo_diff)?;
    }

    Ok(())
}

pub fn mint_lp_shares(
    position: &mut PerpPosition,
    market: &mut PerpMarket,
    n_shares: u64,
) -> DriftResult<()> {
    let amm = market.amm;

    let (sqrt_k,) = get_struct_values!(amm, sqrt_k);

    if position.lp_shares > 0 {
        settle_lp_position(position, market)?;
    } else {
        position.last_base_asset_amount_per_lp = amm.base_asset_amount_per_lp.cast()?;
        position.last_quote_asset_amount_per_lp = amm.quote_asset_amount_per_lp.cast()?;
    }

    // add share balance
    position.lp_shares = position.lp_shares.safe_add(n_shares)?;

    // update market state
    let new_sqrt_k = sqrt_k.safe_add(n_shares.cast()?)?;
    let new_sqrt_k_u192 = U192::from(new_sqrt_k);

    let update_k_result = get_update_k_result(market, new_sqrt_k_u192, true)?;
    update_k(market, &update_k_result)?;

    market.amm.user_lp_shares = market.amm.user_lp_shares.safe_add(n_shares.cast()?)?;

    crate::validation::perp_market::validate_perp_market(market)?;
    crate::validation::position::validate_perp_position_with_perp_market(position, market)?;

    Ok(())
}

pub fn settle_lp_position(
    position: &mut PerpPosition,
    market: &mut PerpMarket,
) -> DriftResult<(PositionDelta, i64)> {
    if position.base_asset_amount > 0 {
        validate!(
            position.last_cumulative_funding_rate.cast::<i128>()?
                == market.amm.cumulative_funding_rate_long,
            ErrorCode::InvalidPerpPositionDetected
        )?;
    } else if position.base_asset_amount < 0 {
        validate!(
            position.last_cumulative_funding_rate.cast::<i128>()?
                == market.amm.cumulative_funding_rate_short,
            ErrorCode::InvalidPerpPositionDetected
        )?;
    }

    apply_lp_rebase_to_perp_position(market, position)?;

    let mut lp_metrics: crate::math::lp::LPMetrics =
        calculate_settle_lp_metrics(&market.amm, position)?;

    crate::dlog!(lp_metrics.base_asset_amount, lp_metrics.quote_asset_amount);

    let new_remainder_base_asset_amount = position
        .remainder_base_asset_amount
        .cast::<i64>()?
        .safe_add(lp_metrics.remainder_base_asset_amount.cast()?)?;

    if new_remainder_base_asset_amount.unsigned_abs() >= market.amm.order_step_size {
        let (standardized_remainder_base_asset_amount, remainder_base_asset_amount) =
            crate::math::orders::standardize_base_asset_amount_with_remainder_i128(
                new_remainder_base_asset_amount.cast()?,
                market.amm.order_step_size.cast()?,
            )?;

        lp_metrics.base_asset_amount = lp_metrics
            .base_asset_amount
            .safe_add(standardized_remainder_base_asset_amount)?;

        position.remainder_base_asset_amount = remainder_base_asset_amount.cast()?;
    } else {
        position.remainder_base_asset_amount = new_remainder_base_asset_amount.cast()?;
    }

    crate::dlog!(lp_metrics.base_asset_amount, lp_metrics.quote_asset_amount);

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
        .safe_add(lp_metrics.base_asset_amount)?;

    crate::dlog!(market.amm.base_asset_amount_with_unsettled_lp);

    position.last_base_asset_amount_per_lp = market.amm.base_asset_amount_per_lp.cast()?;
    position.last_quote_asset_amount_per_lp = market.amm.quote_asset_amount_per_lp.cast()?;

    crate::validation::perp_market::validate_perp_market(market)?;
    crate::validation::position::validate_perp_position_with_perp_market(position, market)?;

    Ok((position_delta, pnl))
}

pub fn settle_lp(
    user: &mut User,
    user_key: &Pubkey,
    market: &mut PerpMarket,
    now: i64,
) -> DriftResult {
    if let Ok(position) = user.get_perp_position_mut(market.market_index) {
        if position.lp_shares > 0 {
            let (position_delta, pnl) = settle_lp_position(position, market)?;

            if position_delta.base_asset_amount != 0 || position_delta.quote_asset_amount != 0 {
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
) -> DriftResult {
    crate::controller::funding::settle_funding_payment(user, user_key, market, now)?;
    settle_lp(user, user_key, market, now)
}

pub fn burn_lp_shares(
    position: &mut PerpPosition,
    market: &mut PerpMarket,
    shares_to_burn: u64,
    oracle_price: i64,
) -> DriftResult<(PositionDelta, i64)> {
    // settle
    let (position_delta, pnl) = settle_lp_position(position, market)?;

    // clean up
    let unsettled_remainder = market
        .amm
        .base_asset_amount_with_unsettled_lp
        .safe_add(position.remainder_base_asset_amount.cast()?)?;
    if shares_to_burn as u128 == market.amm.user_lp_shares && unsettled_remainder != 0 {
        crate::validate!(
            unsettled_remainder.unsigned_abs() <= market.amm.order_step_size as u128,
            ErrorCode::UnableToBurnLPTokens,
            "unsettled baa on final burn too big rel to stepsize {}: {} (remainder:{})",
            market.amm.order_step_size,
            market.amm.base_asset_amount_with_unsettled_lp,
            position.remainder_base_asset_amount
        )?;

        // sub bc lps take the opposite side of the user
        position.remainder_base_asset_amount = position
            .remainder_base_asset_amount
            .safe_sub(unsettled_remainder.cast()?)?;
    }

    // update stats
    if position.remainder_base_asset_amount != 0 {
        let base_asset_amount = position.remainder_base_asset_amount as i128;

        // user closes the dust
        market.amm.base_asset_amount_with_amm = market
            .amm
            .base_asset_amount_with_amm
            .safe_sub(base_asset_amount)?;

        market.amm.base_asset_amount_with_unsettled_lp = market
            .amm
            .base_asset_amount_with_unsettled_lp
            .safe_add(base_asset_amount)?;

        position.remainder_base_asset_amount = 0;

        let dust_base_asset_value = calculate_base_asset_value_with_oracle_price(base_asset_amount, oracle_price)?
                .safe_add(1) // round up
                ?;

        update_quote_asset_amount(position, market, -dust_base_asset_value.cast()?)?;
    }

    // update last_ metrics
    position.last_base_asset_amount_per_lp = market.amm.base_asset_amount_per_lp.cast()?;
    position.last_quote_asset_amount_per_lp = market.amm.quote_asset_amount_per_lp.cast()?;

    // burn shares
    position.lp_shares = position.lp_shares.safe_sub(shares_to_burn)?;

    market.amm.user_lp_shares = market.amm.user_lp_shares.safe_sub(shares_to_burn.cast()?)?;

    // update market state
    let new_sqrt_k = market.amm.sqrt_k.safe_sub(shares_to_burn.cast()?)?;
    let new_sqrt_k_u192 = U192::from(new_sqrt_k);

    let update_k_result = get_update_k_result(market, new_sqrt_k_u192, false)?;
    update_k(market, &update_k_result)?;

    crate::validation::perp_market::validate_perp_market(market)?;
    crate::validation::position::validate_perp_position_with_perp_market(position, market)?;

    Ok((position_delta, pnl))
}

pub fn remove_perp_lp_shares(
    perp_market_map: PerpMarketMap,
    oracle_map: &mut OracleMap,
    state: &Account<State>,
    user: &mut std::cell::RefMut<User>,
    user_key: Pubkey,
    shares_to_burn: u64,
    market_index: u16,
    now: i64,
) -> DriftResult<()> {
    // standardize n shares to burn
    let shares_to_burn: u64 = {
        let market = perp_market_map.get_ref(&market_index)?;
        crate::math::orders::standardize_base_asset_amount(
            shares_to_burn.cast()?,
            market.amm.order_step_size,
        )?
        .cast()?
    };

    if shares_to_burn == 0 {
        return Ok(());
    }

    let mut market = perp_market_map.get_ref_mut(&market_index)?;

    let time_since_last_add_liquidity = now.safe_sub(user.last_add_perp_lp_shares_ts)?;

    validate!(
        time_since_last_add_liquidity >= state.lp_cooldown_time.cast()?,
        ErrorCode::TryingToRemoveLiquidityTooFast
    )?;

    controller::funding::settle_funding_payment(user, &user_key, &mut market, now)?;

    let position = user.get_perp_position_mut(market_index)?;

    validate!(
        position.lp_shares >= shares_to_burn,
        ErrorCode::InsufficientLPTokens
    )?;

    let oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;
    let (position_delta, pnl) =
        burn_lp_shares(position, &mut market, shares_to_burn, oracle_price)?;

    emit!(LPRecord {
        ts: now,
        action: LPAction::RemoveLiquidity,
        user: user_key,
        n_shares: shares_to_burn,
        market_index,
        delta_base_asset_amount: position_delta.base_asset_amount,
        delta_quote_asset_amount: position_delta.quote_asset_amount,
        pnl,
    });

    Ok(())
}
