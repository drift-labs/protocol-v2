use crate::math::safe_math::SafeMath;
use crate::state::state::State;
use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::spot_market::SpotMarket;
use solana_program::msg;
// use anchor_spl::stake;
use crate::instructions::constraints::*;
use crate::load_mut;
use crate::validate;
use anchor_spl::token::{Token, TokenAccount};
// use solana_program::stake;
//::instruction::{create_account, delegate_stake, deactivate_stake, withdraw};

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_spot_market_create_stake(ctx: Context<AdminCreateSpotMarketStake>) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        spot_market.mint == crate::ids::wsol_mint::id(),
        ErrorCode::DefaultError,
        "market not wrapped SOL"
    )?;

    // todo: create a stake account for a program owned token account

    // let authorized = &mut load_mut!(ctx.accounts.authorized)?;
    // let lockup = &mut load_mut!(ctx.accounts.lockup)?;

    // let ix = stake::instruction::initialize(
    //     &ctx.accounts.stake_pubkey.key(),
    //     &authorized,
    //     &lockup
    // );
    // anchor_lang::solana_program::program::invoke(
    //     &ix,
    //     &[
    //         ctx.accounts.stake_pubkey.to_account_info(),
    //         ctx.accounts.authorized.to_account_info(),
    //         ctx.accounts.lockup.to_account_info(),
    //     ],
    // );

    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_spot_market_delegate_stake(ctx: Context<AdminUpdateSpotMarketStake>) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        spot_market.mint == crate::ids::wsol_mint::id(),
        ErrorCode::DefaultError,
        "market not wrapped SOL"
    )?;

    // todo: update delegate on stake account

    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_spot_market_add_to_stake(
    ctx: Context<AdminUpdateSpotMarketStake>,
    amount: u64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        spot_market.mint == crate::ids::wsol_mint::id(),
        ErrorCode::DefaultError,
        "market not wrapped SOL"
    )?;

    // todo: add to stake program

    spot_market.staked_token_amount = spot_market.staked_token_amount.safe_add(amount)?;

    // validate invariants
    ctx.accounts.spot_market_vault.reload()?;
    ctx.accounts.insurance_fund_vault.reload()?;
    crate::math::spot_withdraw::validate_spot_market_vault_and_stake_amount(
        spot_market,
        ctx.accounts.spot_market_vault.amount,
        None, // todo: pass amount in stake account
    )?;

    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_spot_market_deactivate_stake(
    ctx: Context<UpdateSpotMarketStake>,
    amount: u64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        spot_market.mint == crate::ids::wsol_mint::id(),
        ErrorCode::DefaultError,
        "market not wrapped SOL"
    )?;

    // todo: deactivate amount in stake program

    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_spot_market_withdraw_stake(
    ctx: Context<UpdateSpotMarketStake>,
    amount: u64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        spot_market.mint == crate::ids::wsol_mint::id(),
        ErrorCode::DefaultError,
        "market not wrapped SOL"
    )?;

    // todo: attempt to withdraw amount from stake to program owned token account

    // saturating since rewards accumulate
    spot_market.staked_token_amount = spot_market.staked_token_amount.saturating_sub(amount);

    Ok(())
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct AdminCreateSpotMarketStake<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
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
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct AdminUpdateSpotMarketStake<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
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
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct UpdateSpotMarketStake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
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
    pub token_program: Program<'info, Token>,
}
