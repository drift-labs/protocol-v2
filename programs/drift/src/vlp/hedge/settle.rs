//! Perp → LP-pool quote settlement keeper handler.
//!
//! Moves quote owed between a perp market's fee/pnl pools and the hedge pool's
//! quote constituent, bounded by the LP pool's settle cap, and emits an
//! `LPSettleRecord` per settled market.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{TokenAccount, TokenInterface};

use crate::auth::check_hot;
use crate::controller;
use crate::controller::orders::validate_market_within_price_band;
use crate::error::ErrorCode;
use crate::get_then_update_id;
use crate::instructions::optional_accounts::{load_maps, AccountMaps};
use crate::math;
use crate::math::casting::Cast;
use crate::math::constants::QUOTE_SPOT_MARKET_INDEX;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::signer::get_signer_seeds;
use crate::state::events::LPSettleRecord;
use crate::state::paused_operations::{PerpLpOperation, PerpOperation};
use crate::state::perp_market_map::MarketSet;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::state::{HotRole, State};
use crate::state::zero_copy::{AccountZeroCopyMut, ZeroCopyLoader};
use crate::validate;
use crate::vlp::amm_cache::CacheInfo;
use crate::vlp::hedge::math::perp_lp_pool_settlement;
use crate::vlp::hedge::state::{
    Constituent, LPPool, CONSTITUENT_PDA_SEED, SETTLE_AMM_ORACLE_MAX_DELAY,
};

pub fn handle_settle_perp_to_lp_pool<'c: 'info, 'info>(
    ctx: Context<'info, SettleAmmPnlToLp<'info>>,
) -> Result<()> {
    use perp_lp_pool_settlement::*;

    let slot = Clock::get()?.slot;
    let state = ctx.accounts.state.load()?;
    let now = Clock::get()?.unix_timestamp;

    if !state.allow_settle_lp_pool() {
        msg!("settle lp pool disabled");
        return Err(ErrorCode::SettleLpPoolDisabled.into());
    }

    let mut amm_cache: AccountZeroCopyMut<'_, CacheInfo, _> =
        ctx.accounts.amm_cache.load_zc_mut()?;
    let quote_market = &mut ctx.accounts.quote_market.load_mut()?;
    let mut quote_constituent = ctx.accounts.constituent.load_mut()?;
    let lp_pool_key = ctx.accounts.lp_pool.key();
    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut *quote_market,
        None,
        now,
    )?;

    let tvl_before = quote_market
        .get_tvl()?
        .safe_add(quote_constituent.vault_token_balance as u128)?;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map: _,
        oracle_map: _,
    } = load_maps(
        remaining_accounts_iter,
        &MarketSet::new(),
        &MarketSet::new(),
        slot,
        None,
    )?;

    for (_, perp_market_loader) in perp_market_map.0.iter() {
        let mut perp_market = perp_market_loader.load_mut()?;
        if lp_pool.lp_pool_id != perp_market.lp_pool_id {
            msg!(
                "Perp market {} does not have the same lp pool id as the lp pool being settled to: {} != {}",
                perp_market.market_index,
                perp_market.lp_pool_id,
                lp_pool.lp_pool_id
            );
            return Err(ErrorCode::InvalidLpPoolId.into());
        }

        if perp_market.lp_status == 0
            || PerpLpOperation::is_operation_paused(
                perp_market.lp_paused_operations,
                PerpLpOperation::SettleQuoteOwed,
            )
        {
            continue;
        }

        let cached_info = amm_cache.get_for_market_index_mut(perp_market.market_index)?;

        // Early validation checks
        if slot.saturating_sub(cached_info.oracle_slot) > SETTLE_AMM_ORACLE_MAX_DELAY {
            msg!(
                "Skipping settling perp market {} to dlp because oracle slot is not up to date",
                perp_market.market_index
            );
            continue;
        }

        validate_market_within_price_band(&perp_market, &state, cached_info.oracle_price)?;

        if perp_market.is_operation_paused(PerpOperation::SettlePnl) {
            msg!(
                "Cannot settle pnl under current market = {} status",
                perp_market.market_index
            );
            continue;
        }

        if cached_info.slot != slot {
            msg!("Skipping settling perp market {} to lp pool because amm cache was not updated in the same slot",
                perp_market.market_index);
            return Err(ErrorCode::AMMCacheStale.into());
        }

        quote_constituent.sync_token_balance(ctx.accounts.constituent_quote_token_account.amount);

        // Create settlement context
        let settlement_ctx = SettlementContext {
            quote_owed_from_lp: cached_info.quote_owed_from_lp_pool,
            quote_constituent_token_balance: quote_constituent.vault_token_balance,
            fee_pool_balance: perp_market.amm.fee_pool_token_amount(quote_market)?,
            pnl_pool_balance: get_token_amount(
                perp_market.pnl_pool.scaled_balance,
                quote_market,
                &SpotBalanceType::Deposit,
            )?,
            quote_market,
            max_settle_quote_amount: lp_pool.max_settle_quote_amount,
        };

        // Calculate settlement
        let settlement_result = calculate_settlement_amount(&settlement_ctx)?;
        validate_settlement_amount(
            &settlement_ctx,
            &settlement_result,
            &perp_market,
            quote_market,
        )?;

        if settlement_result.direction == SettlementDirection::None {
            continue;
        }

        // Execute token transfer
        match settlement_result.direction {
            SettlementDirection::FromLpPool => {
                execute_token_transfer(
                    &ctx.accounts.token_program,
                    &ctx.accounts.constituent_quote_token_account,
                    &ctx.accounts.quote_token_vault,
                    &ctx.accounts
                        .constituent_quote_token_account
                        .to_account_info(),
                    &Constituent::get_vault_signer_seeds(
                        &quote_constituent.lp_pool,
                        &quote_constituent.spot_market_index,
                        &quote_constituent.vault_bump,
                    ),
                    settlement_result.amount_transferred,
                    Some(remaining_accounts_iter),
                )?;
            }
            SettlementDirection::ToLpPool => {
                execute_token_transfer(
                    &ctx.accounts.token_program,
                    &ctx.accounts.quote_token_vault,
                    &ctx.accounts.constituent_quote_token_account,
                    &ctx.accounts.drift_signer,
                    &get_signer_seeds(&state.signer_nonce),
                    settlement_result.amount_transferred,
                    Some(remaining_accounts_iter),
                )?;
            }
            SettlementDirection::None => unreachable!(),
        }

        // Update market pools
        update_perp_market_pools_and_quote_market_balance(
            &mut perp_market,
            &settlement_result,
            quote_market,
        )?;

        // Emit settle event
        let record_id = get_then_update_id!(lp_pool, settle_id);
        emit!(LPSettleRecord {
            record_id,
            last_ts: cached_info.last_settle_ts,
            last_slot: cached_info.last_settle_slot,
            slot,
            ts: now,
            perp_market_index: perp_market.market_index,
            settle_to_lp_amount: match settlement_result.direction {
                SettlementDirection::FromLpPool => settlement_result
                    .amount_transferred
                    .cast::<i64>()?
                    .saturating_mul(-1),
                SettlementDirection::ToLpPool =>
                    settlement_result.amount_transferred.cast::<i64>()?,
                SettlementDirection::None => unreachable!(),
            },
            perp_amm_pnl_delta: cached_info
                .last_net_pnl_pool_token_amount
                .safe_sub(cached_info.last_settle_amm_pnl)?
                .cast::<i64>()?,
            perp_amm_ex_fee_delta: cached_info
                .last_exchange_fees
                .safe_sub(cached_info.last_settle_amm_ex_fees)?
                .cast::<i64>()?,
            lp_aum: lp_pool.last_aum,
            lp_price: lp_pool.get_price(lp_pool.token_supply)?,
            lp_pool: lp_pool_key,
        });

        // Calculate new quote owed amount
        let new_quote_owed = match settlement_result.direction {
            SettlementDirection::FromLpPool => cached_info
                .quote_owed_from_lp_pool
                .safe_sub(settlement_result.amount_transferred as i64)?,
            SettlementDirection::ToLpPool => cached_info
                .quote_owed_from_lp_pool
                .safe_add(settlement_result.amount_transferred as i64)?,
            SettlementDirection::None => cached_info.quote_owed_from_lp_pool,
        };

        // Update cache info
        update_cache_info(cached_info, &settlement_result, new_quote_owed, slot, now)?;

        // Update LP pool stats
        match settlement_result.direction {
            SettlementDirection::FromLpPool => {
                lp_pool.cumulative_quote_sent_to_perp_markets = lp_pool
                    .cumulative_quote_sent_to_perp_markets
                    .saturating_add(settlement_result.amount_transferred as u128);
            }
            SettlementDirection::ToLpPool => {
                lp_pool.cumulative_quote_received_from_perp_markets = lp_pool
                    .cumulative_quote_received_from_perp_markets
                    .saturating_add(settlement_result.amount_transferred as u128);
            }
            SettlementDirection::None => {}
        }

        // Sync constituent token balance
        let constituent_token_account = &mut ctx.accounts.constituent_quote_token_account;
        constituent_token_account.reload()?;
        quote_constituent.sync_token_balance(constituent_token_account.amount);
    }

    // Final validation
    ctx.accounts.quote_token_vault.reload()?;
    math::spot_withdraw::validate_spot_market_vault_amount(
        quote_market,
        ctx.accounts.quote_token_vault.amount,
    )?;

    let tvl_after = quote_market
        .get_tvl()?
        .safe_add(quote_constituent.vault_token_balance as u128)?;

    validate!(
        tvl_before.safe_sub(tvl_after)? <= 10,
        ErrorCode::LpPoolSettleInvariantBreached,
        "LP pool settlement would decrease TVL: {} -> {}",
        tvl_before,
        tvl_after
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct SettleAmmPnlToLp<'info> {
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub lp_pool: AccountLoader<'info, LPPool>,
    #[account(
        mut,
        constraint = check_hot(&keeper.key(), &state, HotRole::LpSettle)?,
    )]
    pub keeper: Signer<'info>,
    /// CHECK: checked in AmmCacheZeroCopy checks
    #[account(mut)]
    pub amm_cache: AccountInfo<'info>,
    #[account(
        mut,
        owner = crate::ID,
        seeds = [b"spot_market", QUOTE_SPOT_MARKET_INDEX.to_le_bytes().as_ref()],
        bump,
    )]
    pub quote_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        owner = crate::ID,
        seeds = [CONSTITUENT_PDA_SEED.as_bytes(), lp_pool.key().as_ref(), QUOTE_SPOT_MARKET_INDEX.to_le_bytes().as_ref()],
        bump = constituent.load()?.bump,
        constraint = constituent.load()?.mint.eq(&quote_market.load()?.mint)
    )]
    pub constituent: AccountLoader<'info, Constituent>,
    #[account(
        mut,
        address = constituent.load()?.vault,
    )]
    pub constituent_quote_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = quote_market.load()?.vault,
        token::authority = drift_signer,
    )]
    pub quote_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: program signer
    pub drift_signer: AccountInfo<'info>,
}
