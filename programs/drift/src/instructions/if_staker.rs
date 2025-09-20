use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::token_interface::{TokenAccount, TokenInterface};

use crate::error::ErrorCode;
use crate::ids::if_rebalance_wallet;
use crate::instructions::constraints::*;
use crate::instructions::optional_accounts::{load_maps, AccountMaps};
use crate::optional_accounts::get_token_mint;
use crate::state::insurance_fund_stake::{InsuranceFundStake, ProtocolIfSharesTransferConfig};
use crate::state::paused_operations::InsuranceFundOperation;
use crate::state::perp_market::MarketStatus;
use crate::state::spot_market::SpotMarket;
use crate::state::state::State;
use crate::state::traits::Size;
use crate::state::user::UserStats;
use crate::validate;
use crate::{controller, math};
use crate::{
    controller::insurance::transfer_protocol_insurance_fund_stake,
    state::{
        if_rebalance_config::IfRebalanceConfig, perp_market_map::MarketSet,
        spot_market_map::get_writable_spot_market_set_from_many,
    },
};
use crate::{load_mut, QUOTE_SPOT_MARKET_INDEX};
use anchor_lang::solana_program::sysvar::instructions;

use super::optional_accounts::get_token_interface;
use crate::math::safe_math::SafeMath;

pub fn handle_initialize_insurance_fund_stake(
    ctx: Context<InitializeInsuranceFundStake>,
    market_index: u16,
) -> Result<()> {
    let mut if_stake = ctx
        .accounts
        .insurance_fund_stake
        .load_init()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    *if_stake = InsuranceFundStake::new(*ctx.accounts.authority.key, market_index, now);

    let spot_market = ctx.accounts.spot_market.load()?;

    validate!(
        !spot_market.is_insurance_fund_operation_paused(InsuranceFundOperation::Init),
        ErrorCode::InsuranceFundOperationPaused,
        "if staking init disabled",
    )?;

    Ok(())
}

pub fn handle_add_insurance_fund_stake<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, AddInsuranceFundStake<'info>>,
    market_index: u16,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Err(ErrorCode::InsufficientDeposit.into());
    }

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mint = get_token_mint(remaining_accounts_iter)?;

    validate!(
        !spot_market.is_insurance_fund_operation_paused(InsuranceFundOperation::Add),
        ErrorCode::InsuranceFundOperationPaused,
        "if staking add disabled",
    )?;

    validate!(
        insurance_fund_stake.market_index == market_index,
        ErrorCode::IncorrectSpotMarketAccountPassed,
        "insurance_fund_stake does not match market_index"
    )?;

    validate!(
        spot_market.status != MarketStatus::Initialized,
        ErrorCode::InvalidSpotMarketState,
        "spot market = {} not active for insurance_fund_stake",
        spot_market.market_index
    )?;

    validate!(
        insurance_fund_stake.last_withdraw_request_shares == 0
            && insurance_fund_stake.last_withdraw_request_value == 0,
        ErrorCode::IFWithdrawRequestInProgress,
        "withdraw request in progress"
    )?;

    {
        if spot_market.has_transfer_hook() {
            controller::insurance::attempt_settle_revenue_to_insurance_fund(
                &ctx.accounts.spot_market_vault,
                &ctx.accounts.insurance_fund_vault,
                spot_market,
                now,
                &ctx.accounts.token_program,
                &ctx.accounts.drift_signer,
                state,
                &mint,
                Some(&mut remaining_accounts_iter.clone()),
            )?;
        } else {
            controller::insurance::attempt_settle_revenue_to_insurance_fund(
                &ctx.accounts.spot_market_vault,
                &ctx.accounts.insurance_fund_vault,
                spot_market,
                now,
                &ctx.accounts.token_program,
                &ctx.accounts.drift_signer,
                state,
                &mint,
                None,
            )?;
        };

        // reload the vault balances so they're up-to-date
        ctx.accounts.spot_market_vault.reload()?;
        ctx.accounts.insurance_fund_vault.reload()?;
        math::spot_withdraw::validate_spot_market_vault_amount(
            spot_market,
            ctx.accounts.spot_market_vault.amount,
        )?;
    }

    controller::insurance::add_insurance_fund_stake(
        amount,
        ctx.accounts.insurance_fund_vault.amount,
        insurance_fund_stake,
        user_stats,
        spot_market,
        clock.unix_timestamp,
    )?;

    controller::token::receive(
        &ctx.accounts.token_program,
        &ctx.accounts.user_token_account,
        &ctx.accounts.insurance_fund_vault,
        &ctx.accounts.authority,
        amount,
        &mint,
        if spot_market.has_transfer_hook() {
            Some(remaining_accounts_iter)
        } else {
            None
        },
    )?;

    Ok(())
}

pub fn handle_request_remove_insurance_fund_stake(
    ctx: Context<RequestRemoveInsuranceFundStake>,
    market_index: u16,
    amount: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        !spot_market.is_insurance_fund_operation_paused(InsuranceFundOperation::RequestRemove),
        ErrorCode::InsuranceFundOperationPaused,
        "if staking request remove disabled",
    )?;

    validate!(
        insurance_fund_stake.market_index == market_index,
        ErrorCode::IncorrectSpotMarketAccountPassed,
        "insurance_fund_stake does not match market_index"
    )?;

    validate!(
        insurance_fund_stake.last_withdraw_request_shares == 0,
        ErrorCode::IFWithdrawRequestInProgress,
        "Withdraw request is already in progress"
    )?;

    let n_shares = math::insurance::vault_amount_to_if_shares(
        amount,
        spot_market.insurance_fund.total_shares,
        ctx.accounts.insurance_fund_vault.amount,
    )?;

    validate!(
        n_shares > 0,
        ErrorCode::IFWithdrawRequestTooSmall,
        "Requested lp_shares = 0"
    )?;

    let user_if_shares = insurance_fund_stake.checked_if_shares(spot_market)?;
    validate!(user_if_shares >= n_shares, ErrorCode::InsufficientIFShares)?;

    controller::insurance::request_remove_insurance_fund_stake(
        n_shares,
        ctx.accounts.insurance_fund_vault.amount,
        insurance_fund_stake,
        user_stats,
        spot_market,
        clock.unix_timestamp,
    )?;

    Ok(())
}

pub fn handle_cancel_request_remove_insurance_fund_stake(
    ctx: Context<RequestRemoveInsuranceFundStake>,
    market_index: u16,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        insurance_fund_stake.market_index == market_index,
        ErrorCode::IncorrectSpotMarketAccountPassed,
        "insurance_fund_stake does not match market_index"
    )?;

    validate!(
        insurance_fund_stake.last_withdraw_request_shares != 0,
        ErrorCode::NoIFWithdrawRequestInProgress,
        "No withdraw request in progress"
    )?;

    controller::insurance::cancel_request_remove_insurance_fund_stake(
        ctx.accounts.insurance_fund_vault.amount,
        insurance_fund_stake,
        user_stats,
        spot_market,
        now,
    )?;

    Ok(())
}

#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_remove_insurance_fund_stake<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, RemoveInsuranceFundStake<'info>>,
    market_index: u16,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mint = get_token_mint(remaining_accounts_iter)?;

    validate!(
        !spot_market.is_insurance_fund_operation_paused(InsuranceFundOperation::Remove),
        ErrorCode::InsuranceFundOperationPaused,
        "if staking remove disabled",
    )?;

    validate!(
        insurance_fund_stake.market_index == market_index,
        ErrorCode::IncorrectSpotMarketAccountPassed,
        "insurance_fund_stake does not match market_index"
    )?;

    // check if spot market is healthy
    validate!(
        spot_market.is_healthy_utilization()?,
        ErrorCode::SpotMarketInsufficientDeposits,
        "spot market utilization above health threshold"
    )?;

    let amount = controller::insurance::remove_insurance_fund_stake(
        ctx.accounts.insurance_fund_vault.amount,
        insurance_fund_stake,
        user_stats,
        spot_market,
        now,
    )?;

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.insurance_fund_vault,
        &ctx.accounts.user_token_account,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        amount,
        &mint,
        if spot_market.has_transfer_hook() {
            Some(remaining_accounts_iter)
        } else {
            None
        },
    )?;

    ctx.accounts.insurance_fund_vault.reload()?;
    validate!(
        ctx.accounts.insurance_fund_vault.amount > 0,
        ErrorCode::InvalidIFDetected,
        "insurance_fund_vault.amount must remain > 0"
    )?;

    // validate relevant spot market balances before unstake
    math::spot_withdraw::validate_spot_balances(spot_market)?;

    Ok(())
}

pub fn handle_transfer_protocol_if_shares(
    ctx: Context<TransferProtocolIfShares>,
    market_index: u16,
    shares: u128,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    validate!(
        market_index == QUOTE_SPOT_MARKET_INDEX,
        ErrorCode::DefaultError,
        "must be if for quote spot market"
    )?;

    let mut transfer_config = ctx.accounts.transfer_config.load_mut()?;

    transfer_config.validate_signer(ctx.accounts.signer.key)?;

    transfer_config.update_epoch(now)?;
    transfer_config.validate_transfer(shares)?;
    transfer_config.current_epoch_transfer += shares;

    let mut if_stake = ctx.accounts.insurance_fund_stake.load_mut()?;
    let mut user_stats = ctx.accounts.user_stats.load_mut()?;
    let mut spot_market = ctx.accounts.spot_market.load_mut()?;

    transfer_protocol_insurance_fund_stake(
        ctx.accounts.insurance_fund_vault.amount,
        shares,
        &mut if_stake,
        &mut user_stats,
        &mut spot_market,
        Clock::get()?.unix_timestamp,
        ctx.accounts.state.signer,
    )?;

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_begin_insurance_fund_swap<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, InsuranceFundSwap<'info>>,
    in_market_index: u16,
    out_market_index: u16,
    amount_in: u64,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        spot_market_map, ..
    } = load_maps(
        remaining_accounts_iter,
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![in_market_index, out_market_index]),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let _token_interface = get_token_interface(remaining_accounts_iter)?;
    let mint = get_token_mint(remaining_accounts_iter)?;
    let _out_mint = get_token_mint(remaining_accounts_iter)?;

    let mut in_spot_market = spot_market_map.get_ref_mut(&in_market_index)?;

    if let Some(mint) = &mint {
        validate!(
            mint.key() == in_spot_market.mint,
            ErrorCode::InvalidSwap,
            "in_spot_market.mint mismatch"
        )?;
    }

    validate!(
        in_spot_market.flash_loan_initial_token_amount == 0
            && in_spot_market.flash_loan_amount == 0,
        ErrorCode::InvalidSwap,
        "begin_swap ended in invalid state"
    )?;

    let mut out_spot_market = spot_market_map.get_ref_mut(&out_market_index)?;

    let in_spot_has_transfer_hook = in_spot_market.has_transfer_hook();
    let out_spot_has_transfer_hook = out_spot_market.has_transfer_hook();

    validate!(
        !(in_spot_has_transfer_hook && out_spot_has_transfer_hook),
        ErrorCode::InvalidSwap,
        "both in and out spot markets cannot both have transfer hooks"
    )?;

    validate!(
        out_spot_market.flash_loan_initial_token_amount == 0
            && out_spot_market.flash_loan_amount == 0,
        ErrorCode::InvalidSwap,
        "begin_swap ended in invalid state"
    )?;

    validate!(
        in_market_index != out_market_index,
        ErrorCode::InvalidSwap,
        "in and out market the same"
    )?;

    validate!(
        amount_in != 0,
        ErrorCode::InvalidSwap,
        "amount_out cannot be zero"
    )?;

    let mut if_rebalance_config = ctx.accounts.if_rebalance_config.load_mut()?;
    controller::insurance::handle_if_begin_swap(
        &mut if_rebalance_config,
        ctx.accounts.in_insurance_fund_vault.amount,
        ctx.accounts.out_insurance_fund_vault.amount,
        &mut in_spot_market,
        &mut out_spot_market,
        amount_in,
        now,
    )?;

    let in_vault = &ctx.accounts.in_insurance_fund_vault;
    let in_token_account = &ctx.accounts.in_token_account;

    in_spot_market.flash_loan_amount = amount_in;
    in_spot_market.flash_loan_initial_token_amount = in_token_account.amount;

    let out_token_account = &ctx.accounts.out_token_account;

    out_spot_market.flash_loan_initial_token_amount = out_token_account.amount;

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program,
        in_vault,
        &ctx.accounts.in_token_account,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        amount_in,
        &mint,
        if in_spot_market.has_transfer_hook() {
            Some(remaining_accounts_iter)
        } else {
            None
        },
    )?;

    let ixs = ctx.accounts.instructions.as_ref();
    let current_index = instructions::load_current_index_checked(ixs)? as usize;

    let current_ix = instructions::load_instruction_at_checked(current_index, ixs)?;
    validate!(
        current_ix.program_id == *ctx.program_id,
        ErrorCode::InvalidSwap,
        "SwapBegin must be a top-level instruction (cant be cpi)"
    )?;

    // The only other drift program allowed is SwapEnd
    let mut index = current_index + 1;
    let mut found_end = false;
    loop {
        let ix = match instructions::load_instruction_at_checked(index, ixs) {
            Ok(ix) => ix,
            Err(ProgramError::InvalidArgument) => break,
            Err(e) => return Err(e.into()),
        };

        // Check that the drift program key is not used
        if ix.program_id == crate::id() {
            // must be the last ix -- this could possibly be relaxed
            validate!(
                !found_end,
                ErrorCode::InvalidSwap,
                "the transaction must not contain a Drift instruction after FlashLoanEnd"
            )?;
            found_end = true;

            // must be the SwapEnd instruction
            let discriminator = crate::instruction::EndInsuranceFundSwap::discriminator();
            validate!(
                ix.data[0..8] == discriminator,
                ErrorCode::InvalidSwap,
                "last drift ix must be end of swap"
            )?;

            validate!(
                ctx.accounts.authority.key() == ix.accounts[1].pubkey,
                ErrorCode::InvalidSwap,
                "the authority passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.out_insurance_fund_vault.key() == ix.accounts[2].pubkey,
                ErrorCode::InvalidSwap,
                "the out_insurance_fund_vault passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.in_insurance_fund_vault.key() == ix.accounts[3].pubkey,
                ErrorCode::InvalidSwap,
                "the in_insurance_fund_vault passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.out_token_account.key() == ix.accounts[4].pubkey,
                ErrorCode::InvalidSwap,
                "the out_token_account passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.in_token_account.key() == ix.accounts[5].pubkey,
                ErrorCode::InvalidSwap,
                "the in_token_account passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.if_rebalance_config.key() == ix.accounts[6].pubkey,
                ErrorCode::InvalidSwap,
                "the if_rebalance_config passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.remaining_accounts.len() == ix.accounts.len() - 10,
                ErrorCode::InvalidSwap,
                "begin and end ix must have the same number of accounts"
            )?;

            for i in 10..ix.accounts.len() {
                validate!(
                    *ctx.remaining_accounts[i - 10].key == ix.accounts[i].pubkey,
                    ErrorCode::InvalidSwap,
                    "begin and end ix must have the same accounts. {}th account mismatch. begin: {}, end: {}",
                    i,
                    ctx.remaining_accounts[i - 10].key,
                    ix.accounts[i].pubkey
                )?;
            }
        } else {
            if found_end {
                for meta in ix.accounts.iter() {
                    validate!(
                        meta.is_writable == false,
                        ErrorCode::InvalidSwap,
                        "instructions after swap end must not have writable accounts"
                    )?;
                }
            } else {
                for meta in ix.accounts.iter() {
                    validate!(
                        meta.pubkey != crate::id(),
                        ErrorCode::InvalidSwap,
                        "instructions between begin and end must not be drift instructions"
                    )?;
                }
            }
        }

        index += 1;
    }

    validate!(
        found_end,
        ErrorCode::InvalidSwap,
        "found no SwapEnd instruction in transaction"
    )?;

    Ok(())
}

pub fn handle_end_insurance_fund_swap<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, InsuranceFundSwap<'info>>,
    in_market_index: u16,
    out_market_index: u16,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        spot_market_map,
        mut oracle_map,
        ..
    } = load_maps(
        remaining_accounts,
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![in_market_index, out_market_index]),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;
    let out_token_program = get_token_interface(remaining_accounts)?;

    let in_mint = get_token_mint(remaining_accounts)?;
    let out_mint = get_token_mint(remaining_accounts)?;

    let mut in_spot_market = spot_market_map.get_ref_mut(&in_market_index)?;

    if let Some(in_mint) = &in_mint {
        validate!(
            in_mint.key() == in_spot_market.mint,
            ErrorCode::InvalidSwap,
            "in_spot_market.mint mismatch"
        )?;
    }

    validate!(
        in_spot_market.flash_loan_amount != 0,
        ErrorCode::InvalidSwap,
        "the in_spot_market must have a flash loan amount set"
    )?;

    let mut out_spot_market = spot_market_map.get_ref_mut(&out_market_index)?;

    if let Some(out_mint) = &out_mint {
        validate!(
            out_mint.key() == out_spot_market.mint,
            ErrorCode::InvalidSwap,
            "out_spot_market.mint mismatch"
        )?;
    }

    let in_vault = &mut ctx.accounts.in_insurance_fund_vault;
    let in_token_account = &mut ctx.accounts.in_token_account;

    let mut amount_in = in_spot_market.flash_loan_amount;
    if in_token_account.amount > in_spot_market.flash_loan_initial_token_amount {
        let residual = in_token_account
            .amount
            .safe_sub(in_spot_market.flash_loan_initial_token_amount)?;

        controller::token::receive(
            &ctx.accounts.token_program,
            in_token_account,
            in_vault,
            &ctx.accounts.authority,
            residual,
            &in_mint,
            if in_spot_market.has_transfer_hook() {
                Some(remaining_accounts)
            } else {
                None
            },
        )?;
        in_token_account.reload()?;
        in_vault.reload()?;

        amount_in = amount_in.safe_sub(residual)?;
    }

    in_spot_market.flash_loan_initial_token_amount = 0;
    in_spot_market.flash_loan_amount = 0;

    let out_vault = &mut ctx.accounts.out_insurance_fund_vault;
    let out_token_account = &mut ctx.accounts.out_token_account;

    let mut amount_out = 0_u64;
    if out_token_account.amount > out_spot_market.flash_loan_initial_token_amount {
        amount_out = out_token_account
            .amount
            .safe_sub(out_spot_market.flash_loan_initial_token_amount)?;

        if let Some(token_interface) = out_token_program {
            controller::token::receive(
                &token_interface,
                out_token_account,
                out_vault,
                &ctx.accounts.authority,
                amount_out,
                &out_mint,
                if out_spot_market.has_transfer_hook() {
                    Some(remaining_accounts)
                } else {
                    None
                },
            )?;
        } else {
            controller::token::receive(
                &ctx.accounts.token_program,
                out_token_account,
                out_vault,
                &ctx.accounts.authority,
                amount_out,
                &out_mint,
                if out_spot_market.has_transfer_hook() {
                    Some(remaining_accounts)
                } else {
                    None
                },
            )?;
        }

        out_vault.reload()?;
    }

    validate!(
        amount_out != 0,
        ErrorCode::InvalidSwap,
        "amount_out must be greater than 0"
    )?;

    out_spot_market.flash_loan_initial_token_amount = 0;
    out_spot_market.flash_loan_amount = 0;

    validate!(
        out_spot_market.flash_loan_initial_token_amount == 0
            && out_spot_market.flash_loan_amount == 0,
        ErrorCode::InvalidSwap,
        "end_swap ended in invalid state"
    )?;

    validate!(
        in_spot_market.flash_loan_initial_token_amount == 0
            && in_spot_market.flash_loan_amount == 0,
        ErrorCode::InvalidSwap,
        "end_swap ended in invalid state"
    )?;

    let out_oracle_price = oracle_map
        .get_price_data(&out_spot_market.oracle_id())?
        .price;

    let mut if_rebalance_config = ctx.accounts.if_rebalance_config.load_mut()?;
    controller::insurance::handle_if_end_swap(
        &mut if_rebalance_config,
        ctx.accounts.in_insurance_fund_vault.amount,
        ctx.accounts.out_insurance_fund_vault.amount,
        &mut in_spot_market,
        &mut out_spot_market,
        amount_in,
        amount_out,
        out_oracle_price.unsigned_abs(),
        now,
    )?;

    Ok(())
}

pub fn handle_transfer_protocol_if_shares_to_revenue_pool<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, TransferProtocolIfSharesToRevenuePool<'info>>,
    market_index: u16,
    amount: u64,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        spot_market_map, ..
    } = load_maps(
        remaining_accounts,
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![market_index]),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let mint = get_token_mint(remaining_accounts)?;

    let mut spot_market = spot_market_map.get_ref_mut(&market_index)?;

    let insurance_fund_amount_before = ctx.accounts.insurance_fund_vault.amount;

    let mut if_rebalance_config = ctx.accounts.if_rebalance_config.load_mut()?;
    controller::insurance::transfer_protocol_if_shares_to_revenue_pool(
        &mut if_rebalance_config,
        &mut spot_market,
        insurance_fund_amount_before,
        amount,
        now,
    )?;

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program.clone(),
        &ctx.accounts.insurance_fund_vault.clone(),
        &ctx.accounts.spot_market_vault.clone(),
        &ctx.accounts.drift_signer.clone(),
        state.signer_nonce,
        amount,
        &mint,
        if spot_market.has_transfer_hook() {
            Some(remaining_accounts)
        } else {
            None
        },
    )?;

    ctx.accounts.spot_market_vault.reload()?;

    math::spot_withdraw::validate_spot_market_vault_amount(
        &spot_market,
        ctx.accounts.spot_market_vault.amount,
    )?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(
    market_index: u16,
)]
pub struct InitializeInsuranceFundStake<'info> {
    #[account(
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        init,
        seeds = [b"insurance_fund_stake", authority.key.as_ref(), market_index.to_le_bytes().as_ref()],
        space = InsuranceFundStake::SIZE,
        bump,
        payer = payer
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct AddInsuranceFundStake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    #[account(
        mut,
        token::mint = insurance_fund_vault.mint,
        token::authority = authority
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct RequestRemoveInsuranceFundStake<'info> {
    #[account(
        mut,
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct RemoveInsuranceFundStake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    #[account(
        mut,
        token::mint = insurance_fund_vault.mint,
        token::authority = authority
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct TransferProtocolIfShares<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub transfer_config: AccountLoader<'info, ProtocolIfSharesTransferConfig>,
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"insurance_fund_stake", authority.key.as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
        has_one = authority,
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
#[instruction(in_market_index: u16, out_market_index: u16, )]
pub struct InsuranceFundSwap<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = authority.key() == if_rebalance_wallet::id() || authority.key() == state.admin
    )]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), out_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub out_insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), in_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub in_insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &out_insurance_fund_vault.mint.eq(&out_token_account.mint),
        token::authority = authority
    )]
    pub out_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &in_insurance_fund_vault.mint.eq(&in_token_account.mint),
        token::authority = authority
    )]
    pub in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub if_rebalance_config: AccountLoader<'info, IfRebalanceConfig>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    /// Instructions Sysvar for instruction introspection
    /// CHECK: fixed instructions sysvar account
    #[account(address = instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct TransferProtocolIfSharesToRevenuePool<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = authority.key() == if_rebalance_wallet::id() || authority.key() == state.admin
    )]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = if_rebalance_config.load()?.out_market_index == market_index,
    )]
    pub if_rebalance_config: AccountLoader<'info, IfRebalanceConfig>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
}
