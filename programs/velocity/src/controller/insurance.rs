use crate::msg;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use std::iter::Peekable;
use std::slice::Iter;

use crate::controller::spot_balance::{
    update_revenue_pool_balances, update_spot_balances, update_spot_market_cumulative_interest,
};
use crate::controller::token::send_from_program_vault;
use crate::error::ErrorCode;
use crate::error::VelocityResult;
use crate::math::casting::Cast;
use crate::math::constants::{
    MAX_APR_PER_REVENUE_SETTLE_TO_INSURANCE_FUND_VAULT, ONE_YEAR, PERCENTAGE_PRECISION,
    QUOTE_SPOT_MARKET_INDEX, SHARE_OF_REVENUE_ALLOCATED_TO_INSURANCE_FUND_VAULT_DENOMINATOR,
    SHARE_OF_REVENUE_ALLOCATED_TO_INSURANCE_FUND_VAULT_NUMERATOR,
};
use crate::math::helpers::get_proportion_u128;
use crate::math::helpers::on_the_hour_update;
use crate::math::insurance::{
    calculate_if_shares_lost, calculate_rebase_info, if_shares_to_vault_amount,
    vault_amount_to_if_shares,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::math::spot_withdraw::validate_spot_market_vault_amount;
use crate::state::events::{InsuranceFundRecord, InsuranceFundStakeRecord, StakeAction};
use crate::state::insurance_fund_stake::InsuranceFundStake;
use crate::state::perp_market::PerpMarket;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::state::State;
use crate::state::user::UserStats;
use crate::vlp::amm::math::amm::calculate_net_user_pnl;
use crate::{emit, validate};

#[cfg(test)]
mod tests;

pub fn update_user_stats_if_stake_amount(
    if_stake_amount_delta: i64,
    insurance_vault_amount: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    spot_market: &mut SpotMarket,
) -> VelocityResult {
    if spot_market.market_index != QUOTE_SPOT_MARKET_INDEX {
        return Ok(());
    }

    let if_stake_amount = if if_stake_amount_delta >= 0 {
        if_shares_to_vault_amount(
            insurance_fund_stake.checked_if_shares(spot_market)?,
            spot_market.insurance_fund.total_shares,
            insurance_vault_amount.safe_add(if_stake_amount_delta.unsigned_abs())?,
        )?
    } else {
        if_shares_to_vault_amount(
            insurance_fund_stake.checked_if_shares(spot_market)?,
            spot_market.insurance_fund.total_shares,
            insurance_vault_amount.safe_sub(if_stake_amount_delta.unsigned_abs())?,
        )?
    };

    user_stats.if_staked_quote_asset_amount = if_stake_amount;

    Ok(())
}

pub fn add_insurance_fund_stake(
    amount: u64,
    insurance_vault_amount: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    spot_market: &mut SpotMarket,
    now: i64,
    admin_deposit: bool,
) -> VelocityResult {
    validate!(
        !(insurance_vault_amount == 0 && spot_market.insurance_fund.total_shares != 0),
        ErrorCode::InvalidIFForNewStakes,
        "Insurance Fund balance should be non-zero for new stakers to enter"
    )?;

    // No-staker bootstrap guard: if the vault was funded while no shares exist
    // (fees settled or tokens sent before any staker), seed `total_shares` 1:1
    // with the vault so the first staker mints `amount` shares at price ~1
    // instead of `amount * 0 / vault == 0` (which would forfeit their deposit).
    // The seeded shares are protocol-owned, permanent, non-withdrawable ballast.
    if spot_market.insurance_fund.total_shares == 0 && insurance_vault_amount > 0 {
        spot_market.insurance_fund.total_shares = insurance_vault_amount.cast()?;
    }

    apply_rebase_to_insurance_fund(insurance_vault_amount, spot_market)?;
    apply_rebase_to_insurance_fund_stake(insurance_fund_stake, spot_market)?;

    let if_shares_before = insurance_fund_stake.checked_if_shares(spot_market)?;
    let total_if_shares_before = spot_market.insurance_fund.total_shares;
    let user_if_shares_before = spot_market.insurance_fund.user_shares;

    let n_shares = vault_amount_to_if_shares(
        amount,
        spot_market.insurance_fund.total_shares,
        insurance_vault_amount,
    )?;

    // reset cost basis if no shares
    insurance_fund_stake.cost_basis = if if_shares_before == 0 {
        amount.cast()?
    } else {
        insurance_fund_stake.cost_basis.safe_add(amount.cast()?)?
    };

    insurance_fund_stake.increase_if_shares(n_shares, spot_market)?;

    spot_market.insurance_fund.total_shares =
        spot_market.insurance_fund.total_shares.safe_add(n_shares)?;

    spot_market.insurance_fund.user_shares =
        spot_market.insurance_fund.user_shares.safe_add(n_shares)?;

    update_user_stats_if_stake_amount(
        amount.cast()?,
        insurance_vault_amount,
        insurance_fund_stake,
        user_stats,
        spot_market,
    )?;

    let if_shares_after = insurance_fund_stake.checked_if_shares(spot_market)?;

    emit!(InsuranceFundStakeRecord {
        ts: now,
        user_authority: user_stats.authority,
        action: if admin_deposit {
            StakeAction::AdminDeposit
        } else {
            StakeAction::Stake
        },
        amount,
        market_index: spot_market.market_index,
        insurance_vault_amount_before: insurance_vault_amount,
        if_shares_before,
        user_if_shares_before,
        total_if_shares_before,
        if_shares_after,
        total_if_shares_after: spot_market.insurance_fund.total_shares,
        user_if_shares_after: spot_market.insurance_fund.user_shares,
    });

    Ok(())
}

pub fn apply_rebase_to_insurance_fund(
    insurance_fund_vault_balance: u64,
    spot_market: &mut SpotMarket,
) -> VelocityResult {
    if insurance_fund_vault_balance != 0
        && insurance_fund_vault_balance.cast::<u128>()? < spot_market.insurance_fund.total_shares
    {
        let (expo_diff, rebase_divisor) = calculate_rebase_info(
            spot_market.insurance_fund.total_shares,
            insurance_fund_vault_balance,
        )?;

        spot_market.insurance_fund.total_shares = spot_market
            .insurance_fund
            .total_shares
            .safe_div(rebase_divisor)?;
        spot_market.insurance_fund.user_shares = spot_market
            .insurance_fund
            .user_shares
            .safe_div(rebase_divisor)?;
        spot_market.insurance_fund.shares_base = spot_market
            .insurance_fund
            .shares_base
            .safe_add(expo_diff.cast::<u128>()?)?;

        msg!("rebasing insurance fund: expo_diff={}", expo_diff);
    }

    if insurance_fund_vault_balance != 0 && spot_market.insurance_fund.total_shares == 0 {
        spot_market.insurance_fund.total_shares = insurance_fund_vault_balance.cast::<u128>()?;
    }

    Ok(())
}

pub fn apply_rebase_to_insurance_fund_stake(
    insurance_fund_stake: &mut InsuranceFundStake,
    spot_market: &mut SpotMarket,
) -> VelocityResult {
    if spot_market.insurance_fund.shares_base != insurance_fund_stake.if_base {
        validate!(
            spot_market.insurance_fund.shares_base > insurance_fund_stake.if_base,
            ErrorCode::InvalidIFRebase,
            "Rebase expo out of bounds"
        )?;

        let expo_diff = (spot_market.insurance_fund.shares_base - insurance_fund_stake.if_base)
            .cast::<u32>()?;

        let rebase_divisor = 10_u128.pow(expo_diff);

        msg!(
            "rebasing insurance fund stake: base: {} -> {} ",
            insurance_fund_stake.if_base,
            spot_market.insurance_fund.shares_base,
        );

        insurance_fund_stake.if_base = spot_market.insurance_fund.shares_base;

        let old_if_shares = insurance_fund_stake.unchecked_if_shares();
        let new_if_shares = old_if_shares.safe_div(rebase_divisor)?;

        msg!(
            "rebasing insurance fund stake: shares -> {} ",
            new_if_shares
        );

        insurance_fund_stake.update_if_shares(new_if_shares, spot_market)?;

        insurance_fund_stake.last_withdraw_request_shares = insurance_fund_stake
            .last_withdraw_request_shares
            .safe_div(rebase_divisor)?;
    }

    Ok(())
}

pub fn request_remove_insurance_fund_stake(
    n_shares: u128,
    insurance_vault_amount: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    spot_market: &mut SpotMarket,
    now: i64,
) -> VelocityResult {
    msg!("n_shares {}", n_shares);
    insurance_fund_stake.last_withdraw_request_shares = n_shares;

    apply_rebase_to_insurance_fund(insurance_vault_amount, spot_market)?;
    apply_rebase_to_insurance_fund_stake(insurance_fund_stake, spot_market)?;

    let if_shares_before = insurance_fund_stake.checked_if_shares(spot_market)?;
    let total_if_shares_before = spot_market.insurance_fund.total_shares;
    let user_if_shares_before = spot_market.insurance_fund.user_shares;

    validate!(
        insurance_fund_stake.last_withdraw_request_shares
            <= insurance_fund_stake.checked_if_shares(spot_market)?,
        ErrorCode::InvalidInsuranceUnstakeSize,
        "last_withdraw_request_shares exceeds if_shares {} > {}",
        insurance_fund_stake.last_withdraw_request_shares,
        insurance_fund_stake.checked_if_shares(spot_market)?
    )?;

    validate!(
        insurance_fund_stake.if_base == spot_market.insurance_fund.shares_base,
        ErrorCode::InvalidIFRebase,
        "if stake base != spot market base"
    )?;

    insurance_fund_stake.last_withdraw_request_value = if_shares_to_vault_amount(
        insurance_fund_stake.last_withdraw_request_shares,
        spot_market.insurance_fund.total_shares,
        insurance_vault_amount,
    )?
    .min(insurance_vault_amount.saturating_sub(1));

    validate!(
        insurance_fund_stake.last_withdraw_request_value == 0
            || insurance_fund_stake.last_withdraw_request_value < insurance_vault_amount,
        ErrorCode::InvalidIFUnstakeSize,
        "Requested withdraw value is not below Insurance Fund balance"
    )?;

    let if_shares_after = insurance_fund_stake.checked_if_shares(spot_market)?;

    update_user_stats_if_stake_amount(
        0,
        insurance_vault_amount,
        insurance_fund_stake,
        user_stats,
        spot_market,
    )?;

    emit!(InsuranceFundStakeRecord {
        ts: now,
        user_authority: user_stats.authority,
        action: StakeAction::UnstakeRequest,
        amount: insurance_fund_stake.last_withdraw_request_value,
        market_index: spot_market.market_index,
        insurance_vault_amount_before: insurance_vault_amount,
        if_shares_before,
        user_if_shares_before,
        total_if_shares_before,
        if_shares_after,
        total_if_shares_after: spot_market.insurance_fund.total_shares,
        user_if_shares_after: spot_market.insurance_fund.user_shares,
    });

    insurance_fund_stake.last_withdraw_request_ts = now;

    Ok(())
}

pub fn cancel_request_remove_insurance_fund_stake(
    insurance_vault_amount: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    spot_market: &mut SpotMarket,
    now: i64,
) -> VelocityResult {
    apply_rebase_to_insurance_fund(insurance_vault_amount, spot_market)?;
    apply_rebase_to_insurance_fund_stake(insurance_fund_stake, spot_market)?;

    let if_shares_before = insurance_fund_stake.checked_if_shares(spot_market)?;
    let total_if_shares_before = spot_market.insurance_fund.total_shares;
    let user_if_shares_before = spot_market.insurance_fund.user_shares;

    validate!(
        insurance_fund_stake.if_base == spot_market.insurance_fund.shares_base,
        ErrorCode::InvalidIFRebase,
        "if stake base != spot market base"
    )?;

    validate!(
        insurance_fund_stake.last_withdraw_request_shares != 0,
        ErrorCode::InvalidIFUnstakeCancel,
        "No withdraw request in progress"
    )?;

    let if_shares_lost =
        calculate_if_shares_lost(insurance_fund_stake, spot_market, insurance_vault_amount)?;

    insurance_fund_stake.decrease_if_shares(if_shares_lost, spot_market)?;

    spot_market.insurance_fund.total_shares = spot_market
        .insurance_fund
        .total_shares
        .safe_sub(if_shares_lost)?;

    spot_market.insurance_fund.user_shares = spot_market
        .insurance_fund
        .user_shares
        .safe_sub(if_shares_lost)?;

    let if_shares_after = insurance_fund_stake.checked_if_shares(spot_market)?;

    update_user_stats_if_stake_amount(
        0,
        insurance_vault_amount,
        insurance_fund_stake,
        user_stats,
        spot_market,
    )?;

    emit!(InsuranceFundStakeRecord {
        ts: now,
        user_authority: user_stats.authority,
        action: StakeAction::UnstakeCancelRequest,
        amount: 0,
        market_index: spot_market.market_index,
        insurance_vault_amount_before: insurance_vault_amount,
        if_shares_before,
        user_if_shares_before,
        total_if_shares_before,
        if_shares_after,
        total_if_shares_after: spot_market.insurance_fund.total_shares,
        user_if_shares_after: spot_market.insurance_fund.user_shares,
    });

    insurance_fund_stake.last_withdraw_request_shares = 0;
    insurance_fund_stake.last_withdraw_request_value = 0;
    insurance_fund_stake.last_withdraw_request_ts = now;

    Ok(())
}

pub fn remove_insurance_fund_stake(
    insurance_vault_amount: u64,
    insurance_fund_stake: &mut InsuranceFundStake,
    user_stats: &mut UserStats,
    spot_market: &mut SpotMarket,
    now: i64,
) -> VelocityResult<u64> {
    let time_since_withdraw_request =
        now.safe_sub(insurance_fund_stake.last_withdraw_request_ts)?;

    validate!(
        time_since_withdraw_request >= spot_market.insurance_fund.unstaking_period,
        ErrorCode::TryingToRemoveLiquidityTooFast
    )?;

    apply_rebase_to_insurance_fund(insurance_vault_amount, spot_market)?;
    apply_rebase_to_insurance_fund_stake(insurance_fund_stake, spot_market)?;

    let if_shares_before = insurance_fund_stake.checked_if_shares(spot_market)?;
    let total_if_shares_before = spot_market.insurance_fund.total_shares;
    let user_if_shares_before = spot_market.insurance_fund.user_shares;

    let n_shares = insurance_fund_stake.last_withdraw_request_shares;

    validate!(
        n_shares > 0,
        ErrorCode::InvalidIFUnstake,
        "Must submit withdraw request and wait the escrow period"
    )?;

    validate!(
        if_shares_before >= n_shares,
        ErrorCode::InsufficientIFShares
    )?;

    let amount = if_shares_to_vault_amount(
        n_shares,
        spot_market.insurance_fund.total_shares,
        insurance_vault_amount,
    )?;

    let _if_shares_lost =
        calculate_if_shares_lost(insurance_fund_stake, spot_market, insurance_vault_amount)?;

    let withdraw_amount = amount.min(insurance_fund_stake.last_withdraw_request_value);

    insurance_fund_stake.decrease_if_shares(n_shares, spot_market)?;

    insurance_fund_stake.cost_basis = insurance_fund_stake
        .cost_basis
        .safe_sub(withdraw_amount.cast()?)?;

    spot_market.insurance_fund.total_shares =
        spot_market.insurance_fund.total_shares.safe_sub(n_shares)?;

    spot_market.insurance_fund.user_shares =
        spot_market.insurance_fund.user_shares.safe_sub(n_shares)?;

    // reset insurance_fund_stake withdraw request info
    insurance_fund_stake.last_withdraw_request_shares = 0;
    insurance_fund_stake.last_withdraw_request_value = 0;
    insurance_fund_stake.last_withdraw_request_ts = now;

    let if_shares_after = insurance_fund_stake.checked_if_shares(spot_market)?;

    update_user_stats_if_stake_amount(
        -(withdraw_amount.cast()?),
        insurance_vault_amount,
        insurance_fund_stake,
        user_stats,
        spot_market,
    )?;

    emit!(InsuranceFundStakeRecord {
        ts: now,
        user_authority: user_stats.authority,
        action: StakeAction::Unstake,
        amount: withdraw_amount,
        market_index: spot_market.market_index,
        insurance_vault_amount_before: insurance_vault_amount,
        if_shares_before,
        user_if_shares_before,
        total_if_shares_before,
        if_shares_after,
        total_if_shares_after: spot_market.insurance_fund.total_shares,
        user_if_shares_after: spot_market.insurance_fund.user_shares,
    });

    Ok(withdraw_amount)
}

pub fn attempt_settle_revenue_to_insurance_fund<'info>(
    spot_market_vault: &InterfaceAccount<'info, TokenAccount>,
    insurance_fund_vault: &InterfaceAccount<'info, TokenAccount>,
    spot_market: &mut SpotMarket,
    now: i64,
    token_program: &Interface<'info, TokenInterface>,
    velocity_signer: &AccountInfo<'info>,
    state: &State,
    mint: &Option<InterfaceAccount<'info, Mint>>,
    remaining_accounts: Option<&mut Peekable<Iter<'info, AccountInfo<'info>>>>,
) -> Result<()> {
    let valid_revenue_settle_time = if spot_market.insurance_fund.revenue_settle_period > 0 {
        let time_until_next_update = on_the_hour_update(
            now,
            spot_market.insurance_fund.last_revenue_settle_ts,
            spot_market.insurance_fund.revenue_settle_period,
        )?;

        time_until_next_update == 0
    } else {
        false
    };

    let _token_amount = if valid_revenue_settle_time {
        // uses proportion of revenue pool allocated to insurance fund
        let spot_market_vault_amount = spot_market_vault.amount;
        let insurance_fund_vault_amount = insurance_fund_vault.amount;

        let token_amount = settle_revenue_to_insurance_fund(
            spot_market_vault_amount,
            insurance_fund_vault_amount,
            spot_market,
            now,
            false,
        )?;

        if token_amount > 0 {
            msg!(
                "Spot market_index={} sending {} to insurance_fund_vault",
                spot_market.market_index,
                token_amount
            );

            send_from_program_vault(
                token_program,
                spot_market_vault,
                insurance_fund_vault,
                velocity_signer,
                state.signer_nonce,
                token_amount.cast()?,
                mint,
                remaining_accounts,
            )?;
        }

        spot_market.insurance_fund.last_revenue_settle_ts = now;

        token_amount
    } else {
        0
    };

    Ok(())
}

pub fn settle_revenue_to_insurance_fund(
    spot_market_vault_amount: u64,
    insurance_vault_amount: u64,
    spot_market: &mut SpotMarket,
    now: i64,
    check_invariants: bool,
) -> VelocityResult<u64> {
    update_spot_market_cumulative_interest(spot_market, None, now)?;

    if spot_market.insurance_fund.revenue_settle_period == 0 {
        // revenue pool not configured to settle, ending early
        return Ok(0);
    }

    let depositors_claim =
        validate_spot_market_vault_amount(spot_market, spot_market_vault_amount)?;

    let mut token_amount = get_token_amount(
        spot_market.revenue_pool.scaled_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;

    if depositors_claim < token_amount.cast()? {
        // only allow half of withdraw available when utilization is high
        token_amount = depositors_claim.max(0).cast::<u128>()?.safe_div(2)?;
    }

    if spot_market.insurance_fund.user_shares > 0 {
        // only allow MAX_APR_PER_REVENUE_SETTLE_TO_INSURANCE_FUND_VAULT or 1/10th of revenue pool to be settled
        let capped_apr_amount = insurance_vault_amount
            .cast::<u128>()?
            .safe_mul(MAX_APR_PER_REVENUE_SETTLE_TO_INSURANCE_FUND_VAULT)?
            .safe_div(PERCENTAGE_PRECISION)?
            .safe_div(
                ONE_YEAR
                    .safe_div(spot_market.insurance_fund.revenue_settle_period.cast()?)?
                    .max(1),
            )?;
        let capped_token_pct_amount = token_amount.safe_div(10)?;
        token_amount = capped_token_pct_amount.min(capped_apr_amount);
    }

    let insurance_fund_token_amount = get_proportion_u128(
        token_amount,
        SHARE_OF_REVENUE_ALLOCATED_TO_INSURANCE_FUND_VAULT_NUMERATOR,
        SHARE_OF_REVENUE_ALLOCATED_TO_INSURANCE_FUND_VAULT_DENOMINATOR,
    )?
    .cast::<u64>()?;

    if check_invariants {
        validate!(
            insurance_fund_token_amount != 0,
            ErrorCode::NoRevenueToSettleToIF,
            "no amount to settle to insurance fund"
        )?;
    }

    spot_market.insurance_fund.last_revenue_settle_ts = now;

    // The insurance fund is staker-owned: once stakers exist, the entire settled
    // amount accrues to them as share-price appreciation (no protocol shares
    // minted per-settle).
    //
    // Bootstrap (no-staker backstop): while `total_shares == 0`, the fund still
    // collects fees as a backstop, but there are no shares to back the vault.
    // Left unhandled, the first staker would mint `amount * 0 / vault == 0`
    // shares and lose their deposit. So when there are no shares, seed
    // `total_shares` 1:1 with the post-settle vault balance. These are
    // protocol-owned (`total_shares > user_shares == 0`), permanent, and NOT
    // withdrawable (the protocol-share withdraw/transfer ixs are removed) — pure
    // backstop ballast at share price ~1. Fires only during the no-staker phase.
    let total_if_shares_before = spot_market.insurance_fund.total_shares;
    if total_if_shares_before == 0 {
        spot_market.insurance_fund.total_shares = insurance_vault_amount
            .cast::<u128>()?
            .safe_add(insurance_fund_token_amount.cast()?)?;
    }

    update_revenue_pool_balances(
        insurance_fund_token_amount.cast::<u128>()?,
        &SpotBalanceType::Borrow,
        spot_market,
    )?;

    emit!(InsuranceFundRecord {
        ts: now,
        spot_market_index: spot_market.market_index,
        perp_market_index: 0, // todo: make option?
        amount: insurance_fund_token_amount.cast()?,

        user_if_factor: spot_market.insurance_fund.if_fee_factor,
        total_if_factor: spot_market.insurance_fund.if_fee_factor,
        vault_amount_before: spot_market_vault_amount,
        insurance_vault_amount_before: insurance_vault_amount,
        total_if_shares_before,
        total_if_shares_after: spot_market.insurance_fund.total_shares,
    });

    insurance_fund_token_amount.cast()
}

pub fn resolve_perp_pnl_deficit(
    vault_amount: u64,
    insurance_vault_amount: u64,
    spot_market: &mut SpotMarket,
    market: &mut PerpMarket,
    now: i64,
) -> VelocityResult<u64> {
    validate!(
        market.amm.is_underwater(),
        ErrorCode::NoAmmPerpPnlDeficit,
        "market.amm.total_fee_minus_distributions={} must be negative",
        market.amm.total_fee_minus_distributions
    )?;

    let pnl_pool_token_amount = get_token_amount(
        market.pnl_pool.scaled_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;

    let net_user_pnl = calculate_net_user_pnl(
        &market.amm,
        market
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        market.quote_asset_amount,
        market.net_unsettled_funding_pnl,
    )?;

    validate!(
        pnl_pool_token_amount.cast::<i128>()? < net_user_pnl,
        ErrorCode::SufficientPerpPnlPool,
        "pnl_pool_token_amount >= net_user_pnl ({} >= {})",
        pnl_pool_token_amount,
        net_user_pnl
    )?;

    update_spot_market_cumulative_interest(spot_market, None, now)?;

    let total_if_shares_before = spot_market.insurance_fund.total_shares;

    let excess_user_pnl_imbalance = if market.unrealized_pnl_max_imbalance > 0 {
        let net_unsettled_pnl = calculate_net_user_pnl(
            &market.amm,
            market.market_stats.historical_oracle_data.last_oracle_price,
            market.quote_asset_amount,
            market.net_unsettled_funding_pnl,
        )?;

        net_unsettled_pnl.safe_sub(market.unrealized_pnl_max_imbalance.cast()?)?
    } else {
        0
    };

    validate!(
        excess_user_pnl_imbalance > 0,
        ErrorCode::PerpPnlDeficitBelowThreshold,
        "No excess_user_pnl_imbalance({}) to settle",
        excess_user_pnl_imbalance
    )?;

    let max_revenue_withdraw_per_period = market
        .insurance_claim
        .max_revenue_withdraw_per_period
        .cast::<i128>()?
        .safe_sub(
            market
                .insurance_claim
                .revenue_withdraw_since_last_settle
                .cast()?,
        )?
        .cast::<i128>()?;
    validate!(
        max_revenue_withdraw_per_period > 0,
        ErrorCode::MaxRevenueWithdrawPerPeriodReached,
        "max_revenue_withdraw_per_period={} as already been reached",
        max_revenue_withdraw_per_period
    )?;

    let max_insurance_withdraw = market
        .insurance_claim
        .quote_max_insurance
        .safe_sub(market.insurance_claim.quote_settled_insurance)?
        .cast::<i128>()?;

    validate!(
        max_insurance_withdraw > 0,
        ErrorCode::MaxIFWithdrawReached,
        "max_insurance_withdraw={}/{} as already been reached",
        market.insurance_claim.quote_settled_insurance,
        market.insurance_claim.quote_max_insurance,
    )?;

    let insurance_withdraw = excess_user_pnl_imbalance
        .min(max_revenue_withdraw_per_period)
        .min(max_insurance_withdraw)
        .min(insurance_vault_amount.saturating_sub(1).cast()?);

    validate!(
        insurance_withdraw > 0,
        ErrorCode::NoIFWithdrawAvailable,
        "No available funds for insurance_withdraw({}) for user_pnl_imbalance={}",
        insurance_withdraw,
        excess_user_pnl_imbalance
    )?;

    <crate::vlp::amm::AMM as crate::vlp::amm::quoter::AmmContract>::record_credit(
        &mut market.amm,
        insurance_withdraw.cast::<u64>()?,
    )?;

    market.insurance_claim.revenue_withdraw_since_last_settle = market
        .insurance_claim
        .revenue_withdraw_since_last_settle
        .safe_add(insurance_withdraw.cast()?)?;

    market.insurance_claim.quote_settled_insurance = market
        .insurance_claim
        .quote_settled_insurance
        .safe_add(insurance_withdraw.cast()?)?;

    validate!(
        market.insurance_claim.quote_settled_insurance
            <= market.insurance_claim.quote_max_insurance,
        ErrorCode::MaxIFWithdrawReached,
        "quote_settled_insurance breached its max {}/{}",
        market.insurance_claim.quote_settled_insurance,
        market.insurance_claim.quote_max_insurance,
    )?;

    market.insurance_claim.last_revenue_withdraw_ts = now;

    update_spot_balances(
        insurance_withdraw.cast()?,
        &SpotBalanceType::Deposit,
        spot_market,
        &mut market.pnl_pool,
        false,
    )?;

    emit!(InsuranceFundRecord {
        ts: now,
        spot_market_index: spot_market.market_index,
        perp_market_index: market.market_index,
        amount: -insurance_withdraw.cast()?,
        user_if_factor: spot_market.insurance_fund.if_fee_factor,
        total_if_factor: spot_market.insurance_fund.if_fee_factor,
        vault_amount_before: vault_amount,
        insurance_vault_amount_before: insurance_vault_amount,
        total_if_shares_before,
        total_if_shares_after: spot_market.insurance_fund.total_shares,
    });

    insurance_withdraw.cast()
}
