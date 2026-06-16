//! Market-level pool accounting: pnl pool ↔ user settles plus the streaming
//! fee sweep (pnl pool → revenue pool / protocol fee pool / AMM fee pool).
//!
//! The pnl pool is where trade-fee value materializes (fees debit the payer's
//! position; tokens arrive as fills settle), so the sweep sources every fee
//! carveout from the pnl pool's surplus over live user claims. The AMM's
//! ledger and token pool are never used as a conduit for non-AMM money — the
//! only AMM-touching step is the tokenization of its own already-booked fee
//! provision.
//!
//! Re-exported from `crate::vlp::amm::controller::*` so `use crate::vlp::amm::controller::*`
//! still resolves these symbols.

use std::cmp::min;

use anchor_lang::prelude::*;

use crate::controller::spot_balance::{
    transfer_spot_balance_to_revenue_pool, transfer_spot_balances, update_spot_balances,
};
use crate::error::{ErrorCode, VelocityResult};
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::math::spot_withdraw::{
    get_max_withdraw_for_market_with_token_amount, validate_spot_balances,
};
use crate::msg;
use crate::state::events::PerpMarketFeeSweepRecord;
use crate::state::paused_operations::PerpOperation;
use crate::state::perp_market::PerpMarket;
use crate::state::spot_market::{SpotBalance, SpotBalanceType, SpotMarket};
use crate::state::user::User;
use crate::validate;

/// Materialize accrued pending fees out of the pnl pool — the streaming
/// sweep. The pnl pool is where fee value lands (fees debit the payer's
/// position; tokens arrive as fills settle), so the sweep drains only the
/// pool's surplus over live user claims. Waterfall order (seniority under
/// scarcity):
///   1. `pending_protocol_fee` -> `protocol_fee_pool` (withdrawable)
///   2. `pending_if_fee`       -> quote `SpotMarket.revenue_pool` (insurance)
///   3. `pending_amm_provision`-> `amm.fee_pool` (tokenizing the provision the
///      AMM already booked at fill — NO ledger change here)
/// The protocol drain is EXEMPT from the `fee_pool_buffer_target` retention
/// margin (it reserves only `max(net_user_pnl, 0)`) and runs first: it sweeps
/// every settle, so each drain is small, and unlike the other two its value
/// is not recoverable in bankruptcy anyway. The IF and provision drains then
/// leave the buffer behind on top of user claims — the buffer throttles the
/// outflows whose value the bankruptcy waterfall can still reach.
/// The AMM's ledger and token pool are never touched by steps 1-2: no non-AMM
/// money transits the AMM. Un-drained remainders simply wait for the next
/// sweep. This is the ONLY fee routing out of a perp market. Runs inline on
/// every `update_pool_balances` (pnl settles, after the user's settle) and on
/// demand via the `sweep_perp_market_fees` keeper instruction.
///
/// `force` bypasses the `SettleRevPool` operation pause. It exists for the
/// final sweep on market delisting: that is the last chance to route the
/// protocol carveout to `protocol_fee_pool` before the remaining pnl pool is
/// drained to the revenue pool, so a standing pause must not strand it. The
/// streaming/keeper callers pass `false` and continue to respect the pause.
///
/// Returns `(if_swept, protocol_swept, amm_provision_tokenized)`.
pub fn sweep_market_fees(
    market: &mut PerpMarket,
    spot_market: &mut SpotMarket,
    net_user_pnl: i128,
    now: i64,
    force: bool,
) -> VelocityResult<(u128, u128, u128)> {
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

    if (!force && market.is_operation_paused(PerpOperation::SettleRevPool))
        || (market.fee_ledger.pending_protocol_fee == 0
            && market.fee_ledger.pending_if_fee == 0
            && market.fee_ledger.pending_amm_provision == 0)
    {
        return Ok((0, 0, 0));
    }

    let pnl_pool_tokens = get_token_amount(
        market.pnl_pool.balance(),
        spot_market,
        market.pnl_pool.balance_type(),
    )?;

    // live user claims stay fully backed by every drain; the buffer is a
    // retention margin on top that only the IF and AMM-provision drains
    // respect — the protocol drain is exempt and goes first (its per-settle
    // cadence keeps each drain small, and unlike the other two its value is
    // not recoverable later anyway)
    let reserved_claims: u128 = net_user_pnl.max(0).cast::<u128>()?;
    let mut available_unbuffered: u128 = pnl_pool_tokens.saturating_sub(reserved_claims);

    // 1. protocol's withdrawable cut (buffer-exempt: only user claims reserved)
    let protocol_drain = market
        .fee_ledger
        .pending_protocol_fee
        .min(available_unbuffered);
    if protocol_drain > 0 {
        transfer_spot_balances(
            protocol_drain.cast()?,
            spot_market,
            &mut market.pnl_pool,
            &mut market.protocol_fee_pool,
        )?;
        market.fee_ledger.consume_pending_protocol(protocol_drain)?;
        available_unbuffered = available_unbuffered.safe_sub(protocol_drain)?;
    }

    // the remaining drains also leave the retention buffer behind
    let mut available: u128 =
        available_unbuffered.saturating_sub(market.fee_pool_buffer_target.cast()?);

    // 2. insurance cut to the revenue pool (buffered)
    let if_drain = market.fee_ledger.pending_if_fee.min(available);
    if if_drain > 0 {
        transfer_spot_balance_to_revenue_pool(if_drain, spot_market, &mut market.pnl_pool)?;
        market.fee_ledger.consume_pending_if(if_drain)?;
        available = available.safe_sub(if_drain)?;
    }

    // 3. tokenize the AMM's fee provision (buffered; already booked into
    //    `total_fee_minus_distributions` at fill — token transfer only)
    let provision_drain = market.fee_ledger.pending_amm_provision.min(available);
    if provision_drain > 0 {
        transfer_spot_balances(
            provision_drain.cast()?,
            spot_market,
            &mut market.pnl_pool,
            &mut market.amm.fee_pool,
        )?;
        market
            .fee_ledger
            .consume_pending_amm_provision(provision_drain)?;
    }

    if if_drain > 0 || protocol_drain > 0 || provision_drain > 0 {
        emit!(PerpMarketFeeSweepRecord {
            ts: now,
            market_index: market.market_index,
            if_swept: if_drain.cast()?,
            protocol_swept: protocol_drain.cast()?,
            amm_provision_tokenized: provision_drain.cast()?,
        });
    }

    Ok((if_drain, protocol_drain, provision_drain))
}

pub fn update_pool_balances(
    market: &mut PerpMarket,
    spot_market: &mut SpotMarket,
    user_quote_token_amount: i128,
    user_unsettled_pnl: i128,
    net_user_pnl: i128,
    now: i64,
) -> VelocityResult<i128> {
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

    // sweep AFTER the user's settle: both draw the pnl pool now, and the
    // sweep must not starve the settle that triggered it. The settle just
    // moved `pnl_to_settle_with_user` out of (or into) aggregate user claims.
    let net_user_pnl_after = net_user_pnl.safe_sub(pnl_to_settle_with_user)?;
    sweep_market_fees(market, spot_market, net_user_pnl_after, now, false)?;

    let _depositors_claim = validate_spot_balances(spot_market)?;

    Ok(pnl_to_settle_with_user)
}

pub fn update_pnl_pool_and_user_balance(
    market: &mut PerpMarket,
    quote_spot_market: &mut SpotMarket,
    user: &mut User,
    unrealized_pnl_with_fee: i128,
) -> VelocityResult<i128> {
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
