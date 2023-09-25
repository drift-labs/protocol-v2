use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::controller::insurance::transfer_protocol_insurance_fund_stake;
use crate::error::ErrorCode;
use crate::instructions::constraints::*;
use crate::state::insurance_fund_stake::{InsuranceFundStake, ProtocolIfSharesTransferConfig};
use crate::state::spot_market::SpotMarket;
use crate::state::state::State;
use crate::state::traits::Size;
use crate::state::user::UserStats;
use crate::validate;
use crate::{controller, math};
use crate::{load_mut, QUOTE_SPOT_MARKET_INDEX};

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

    Ok(())
}

pub fn handle_add_insurance_fund_stake(
    ctx: Context<AddInsuranceFundStake>,
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

    validate!(
        insurance_fund_stake.market_index == market_index,
        ErrorCode::IncorrectSpotMarketAccountPassed,
        "insurance_fund_stake does not match market_index"
    )?;

    validate!(
        insurance_fund_stake.last_withdraw_request_shares == 0
            && insurance_fund_stake.last_withdraw_request_value == 0,
        ErrorCode::IFWithdrawRequestInProgress,
        "withdraw request in progress"
    )?;

    {
        controller::insurance::attempt_settle_revenue_to_insurance_fund(
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.insurance_fund_vault,
            spot_market,
            now,
            &ctx.accounts.token_program,
            &ctx.accounts.drift_signer,
            state,
        )?;

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
pub fn handle_remove_insurance_fund_stake(
    ctx: Context<RemoveInsuranceFundStake>,
    market_index: u16,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    let state = &ctx.accounts.state;

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
    let mut transfer_config = ctx.accounts.transfer_config.load_mut()?;
    validate!(
        transfer_config.whitelisted_signer == ctx.accounts.signer.key(),
        ErrorCode::DefaultError,
        "invalid signer"
    )?;

    validate!(
        market_index == QUOTE_SPOT_MARKET_INDEX,
        ErrorCode::DefaultError,
        "must be if for quote spot market"
    )?;

    let now = Clock::get()?.unix_timestamp;
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
        ctx.accounts.state.admin,
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
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,

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
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct RequestRemoveInsuranceFundStake<'info> {
    #[account(
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
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct RemoveInsuranceFundStake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
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
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
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
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct TransferProtocolIfShares<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub transfer_config: AccountLoader<'info, ProtocolIfSharesTransferConfig>,
    pub state: Box<Account<'info, State>>,
    #[account(
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
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
}
