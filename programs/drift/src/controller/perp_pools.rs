//! Market-level pool accounting: revenue pool ↔ AMM fee pool, pnl pool ↔ user.
//!
//! Functions here move balances between the AMM's fee pool, the market's pnl
//! pool, the protocol revenue pool (on the quote spot market), and users.
//! Reads include AMM accounting fields (`fee_pool`, `total_fee_minus_distributions`,
//! `total_fee_withdrawn`) but the operations themselves are pool plumbing, not
//! AMM pricing — no reserves, spreads, or curve state touched.
//!
//! Re-exported from `crate::amm::controller::*` so `use crate::amm::controller::*`
//! still resolves these symbols.

use std::cmp::{min, Ordering};

use anchor_lang::prelude::*;

use crate::amm::math::repeg::get_total_fee_lower_bound;
use crate::controller::spot_balance::{transfer_spot_balances, update_spot_balances};
use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::FEE_POOL_TO_REVENUE_POOL_THRESHOLD;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::math::spot_withdraw::{
    get_max_withdraw_for_market_with_token_amount, validate_spot_balances,
};
use crate::msg;
use crate::state::paused_operations::PerpOperation;
use crate::state::perp_market::PerpMarket;
use crate::state::spot_market::{SpotBalance, SpotBalanceType, SpotMarket};
use crate::state::user::User;
use crate::validate;

pub(crate) fn calculate_revenue_pool_transfer(
    market: &PerpMarket,
    spot_market: &SpotMarket,
    amm_fee_pool_token_amount_after: u128,
    terminal_state_surplus: i128,
) -> DriftResult<i128> {
    // Calculates the revenue pool transfer amount for a given market state (positive = send to revenue pool, negative = pull from revenue pool)
    // If the AMM budget is above `FEE_POOL_TO_REVENUE_POOL_THRESHOLD` (in surplus), settle fees collected to the revenue pool depending on the health of the AMM state
    // Otherwise, spull from the revenue pool (up to a constraint amount)

    if market.is_operation_paused(PerpOperation::SettleRevPool) {
        return Ok(0);
    }

    let amm_budget_surplus =
        terminal_state_surplus.saturating_sub(FEE_POOL_TO_REVENUE_POOL_THRESHOLD.cast()?);

    if amm_budget_surplus > 0 {
        let fee_pool_threshold = amm_fee_pool_token_amount_after
            .saturating_sub(
                FEE_POOL_TO_REVENUE_POOL_THRESHOLD
                    .safe_add(market.total_social_loss)?
                    .cast()?,
            )
            .cast()?;

        let total_liq_fees_for_revenue_pool = market
            .total_liquidation_fee
            .min(
                market
                    .insurance_claim
                    .quote_settled_insurance
                    .safe_add(market.insurance_claim.quote_max_insurance)?
                    .cast()?,
            )
            .cast::<i128>()?;

        let raw_cap = market
            .insurance_claim
            .revenue_withdraw_since_last_settle
            .safe_add(
                market
                    .insurance_claim
                    .max_revenue_withdraw_per_period
                    .cast()?,
            )?;
        let max_revenue_to_settle = market.amm.cap_to_recent_revenue(raw_cap);

        let total_fee_for_if = get_total_fee_lower_bound(market)?.cast::<i128>()?;

        let revenue_pool_transfer = market.amm.proposed_revenue_outflow(
            total_fee_for_if,
            total_liq_fees_for_revenue_pool,
            fee_pool_threshold,
            max_revenue_to_settle.cast()?,
        )?;

        validate!(
            revenue_pool_transfer >= 0,
            ErrorCode::InsufficientPerpPnlPool,
            "revenue_pool_transfer negative ({})",
            revenue_pool_transfer
        )?;

        Ok(revenue_pool_transfer)
    } else if amm_budget_surplus < 0 {
        let max_revenue_withdraw_allowed = market
            .insurance_claim
            .max_revenue_withdraw_per_period
            .cast::<i64>()?
            .saturating_sub(market.insurance_claim.revenue_withdraw_since_last_settle)
            .cast::<u128>()?
            .min(
                get_token_amount(
                    spot_market.revenue_pool.scaled_balance,
                    spot_market,
                    &SpotBalanceType::Deposit,
                )?
                .cast()?,
            )
            .min(
                market
                    .insurance_claim
                    .max_revenue_withdraw_per_period
                    .cast()?,
            );

        if max_revenue_withdraw_allowed > 0 {
            let revenue_pool_transfer = -(amm_budget_surplus
                .abs()
                .min(max_revenue_withdraw_allowed.cast()?));
            Ok(revenue_pool_transfer)
        } else {
            Ok(0)
        }
    } else {
        Ok(0)
    }
}

pub fn update_pool_balances(
    market: &mut PerpMarket,
    spot_market: &mut SpotMarket,
    user_quote_token_amount: i128,
    user_unsettled_pnl: i128,
    now: i64,
) -> DriftResult<i128> {
    {
        let amm_fee_pool_token_amount = market.amm.fee_pool_token_amount(spot_market)?;
        let terminal_state_surplus = market.amm.terminal_state_surplus()?;

        // market can perform withdraw from revenue pool
        if spot_market.insurance_fund.last_revenue_settle_ts
            > market.insurance_claim.last_revenue_withdraw_ts
        {
            validate!(now >= market.insurance_claim.last_revenue_withdraw_ts && now >= spot_market.insurance_fund.last_revenue_settle_ts,
                ErrorCode::BlockchainClockInconsistency,
                "issue with clock unix timestamp {} < market.insurance_claim.last_revenue_withdraw_ts={}/spot_market.last_revenue_settle_ts={}",
                now,
                market.insurance_claim.last_revenue_withdraw_ts,
                spot_market.insurance_fund.last_revenue_settle_ts,
            )?;
            market.insurance_claim.revenue_withdraw_since_last_settle = 0;
        }

        let revenue_pool_transfer = calculate_revenue_pool_transfer(
            market,
            spot_market,
            amm_fee_pool_token_amount,
            terminal_state_surplus,
        )?;

        match revenue_pool_transfer.cmp(&0) {
            Ordering::Greater => {
                <crate::amm::AMM as crate::amm::quoter::AmmContract>::transfer_revenue_to_pool(
                    &mut market.amm,
                    revenue_pool_transfer.unsigned_abs(),
                    spot_market,
                )?;

                market.insurance_claim.revenue_withdraw_since_last_settle = market
                    .insurance_claim
                    .revenue_withdraw_since_last_settle
                    .safe_sub(revenue_pool_transfer.cast()?)?;
                market.insurance_claim.last_revenue_withdraw_ts = now;
            }
            Ordering::Less => (),
            Ordering::Equal => (),
        }
    }

    // market pnl pool pays (what it can to) user_unsettled_pnl and pnl_to_settle_to_amm
    let pnl_pool_token_amount = get_token_amount(
        market.pnl_pool.balance(),
        spot_market,
        market.pnl_pool.balance_type(),
    )?;

    let pnl_to_settle_with_user = if user_unsettled_pnl > 0 {
        min(user_unsettled_pnl, pnl_pool_token_amount.cast::<i128>()?)
    } else {
        // dont settle negative pnl to spot borrows when utilization is high (> 80%)
        let max_withdraw_amount = -get_max_withdraw_for_market_with_token_amount(
            spot_market,
            user_quote_token_amount,
            false,
        )?
        .cast::<i128>()?;

        max_withdraw_amount.max(user_unsettled_pnl)
    };

    let pnl_to_settle_with_market = -(pnl_to_settle_with_user);

    update_spot_balances(
        pnl_to_settle_with_market.unsigned_abs(),
        if pnl_to_settle_with_market >= 0 {
            &SpotBalanceType::Deposit
        } else {
            &SpotBalanceType::Borrow
        },
        spot_market,
        &mut market.pnl_pool,
        false,
    )?;

    let _depositors_claim = validate_spot_balances(spot_market)?;

    Ok(pnl_to_settle_with_user)
}

pub fn update_pnl_pool_and_user_balance(
    market: &mut PerpMarket,
    quote_spot_market: &mut SpotMarket,
    user: &mut User,
    unrealized_pnl_with_fee: i128,
) -> DriftResult<i128> {
    let pnl_to_settle_with_user = if unrealized_pnl_with_fee > 0 {
        unrealized_pnl_with_fee.min(
            get_token_amount(
                market.pnl_pool.scaled_balance,
                quote_spot_market,
                market.pnl_pool.balance_type(),
            )?
            .cast()?,
        )
    } else {
        unrealized_pnl_with_fee
    };

    validate!(
        unrealized_pnl_with_fee == pnl_to_settle_with_user,
        ErrorCode::InsufficientPerpPnlPool,
        "pnl_pool_amount doesnt have enough ({} < {})",
        pnl_to_settle_with_user,
        unrealized_pnl_with_fee
    )?;

    if unrealized_pnl_with_fee == 0 {
        msg!(
            "User has no unsettled pnl for market {}",
            market.market_index
        );
        return Ok(0);
    } else if pnl_to_settle_with_user == 0 {
        msg!(
            "Pnl Pool cannot currently settle with user for market {}",
            market.market_index
        );
        return Ok(0);
    }

    let is_isolated_position = user.get_perp_position(market.market_index)?.is_isolated();
    if is_isolated_position {
        let perp_position = user.force_get_isolated_perp_position_mut(market.market_index)?;
        let perp_position_token_amount =
            perp_position.get_isolated_token_amount(quote_spot_market)?;

        if pnl_to_settle_with_user < 0 {
            validate!(
                perp_position_token_amount >= pnl_to_settle_with_user.unsigned_abs(),
                ErrorCode::InsufficientCollateral,
                "user has insufficient deposit for market {}",
                market.market_index
            )?;
        }

        transfer_spot_balances(
            pnl_to_settle_with_user,
            quote_spot_market,
            &mut market.pnl_pool,
            perp_position,
        )?;
    } else {
        let user_spot_position = user.get_quote_spot_position_mut();

        transfer_spot_balances(
            pnl_to_settle_with_user,
            quote_spot_market,
            &mut market.pnl_pool,
            user_spot_position,
        )?;
    }

    Ok(pnl_to_settle_with_user)
}
