//! Withdraw a spot market's accrued protocol fees (lending + spot-liquidation
//! carveouts) from its own vault to the protocol fee recipient's ATA.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    auth::check_hot,
    controller,
    error::ErrorCode,
    load_mut,
    math::{
        casting::Cast, safe_math::SafeMath, spot_balance::get_token_amount,
        spot_withdraw::validate_spot_market_vault_amount,
    },
    state::{
        events::ProtocolFeeWithdrawRecord,
        spot_market::{SpotBalanceType, SpotMarket},
        state::{HotRole, State},
    },
    validate,
};

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct WithdrawProtocolFeesSpot<'info> {
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = check_hot(&authority.key(), &state, HotRole::FeeWithdraw)?)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        has_one = mint,
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: locked to the cold-admin-set treasury; only used as the ATA wallet
    #[account(
        constraint = recipient.key() != Pubkey::default(),
        address = state.load()?.protocol_fee_recipient_spot @ ErrorCode::InvalidProtocolFeeRecipient
    )]
    pub recipient: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub recipient_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(
        address = state.load()?.signer
    )]
    /// CHECK: forced velocity_signer
    pub velocity_signer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn handle_withdraw_protocol_fees_spot<'c: 'info, 'info>(
    ctx: Context<'info, WithdrawProtocolFeesSpot<'info>>,
    _market_index: u16,
    amount: u64,
) -> Result<()> {
    let state = ctx.accounts.state.load()?;
    let now = Clock::get()?.unix_timestamp;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    // remaining accounts carry only transfer-hook extras now — the mint is a
    // named context account (the ATA init derives from it)
    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mint = Some(ctx.accounts.mint.clone());

    controller::spot_balance::update_spot_market_cumulative_interest(spot_market, None, now)?;

    let available = get_token_amount(
        spot_market.protocol_fee_pool.scaled_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;
    let withdraw_amount = amount.min(available.cast()?);
    validate!(
        withdraw_amount > 0,
        ErrorCode::InsufficientProtocolFees,
        "no protocol fees available (requested={}, available={})",
        amount,
        available
    )?;

    // decrement the protocol-fee claim first (tokens are leaving the protocol)
    controller::spot_balance::update_protocol_fee_pool_balances(
        withdraw_amount.cast()?,
        &SpotBalanceType::Borrow,
        spot_market,
        true,
    )?;

    // the vault must still fully cover depositors after removing the fee — so a
    // protocol-fee withdrawal can never eat into depositor backing
    let vault_after = ctx
        .accounts
        .spot_market_vault
        .amount
        .safe_sub(withdraw_amount)?;
    validate_spot_market_vault_amount(spot_market, vault_after)?;

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.recipient_token_account,
        &ctx.accounts.velocity_signer,
        state.signer_nonce,
        withdraw_amount,
        &mint,
        if spot_market.has_transfer_hook() {
            Some(remaining_accounts_iter)
        } else {
            None
        },
    )?;

    emit!(ProtocolFeeWithdrawRecord {
        ts: now,
        market_index: spot_market.market_index,
        is_perp: false,
        spot_market_index: spot_market.market_index,
        amount: withdraw_amount,
        recipient_token_account: ctx.accounts.recipient_token_account.key(),
    });

    Ok(())
}
