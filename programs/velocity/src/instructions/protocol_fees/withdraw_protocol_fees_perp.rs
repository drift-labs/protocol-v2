//! Withdraw a perp market's accrued protocol fees (quote/USDC-denominated)
//! from the quote spot market's vault to the protocol fee recipient's ATA.

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
        perp_market::PerpMarket,
        spot_market::{SpotBalanceType, SpotMarket},
        state::{HotRole, State},
    },
    validate,
};

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct WithdrawProtocolFeesPerp<'info> {
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = check_hot(&authority.key(), &state, HotRole::FeeWithdraw)?)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"perp_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    #[account(
        mut,
        seeds = [b"spot_market", perp_market.load()?.quote_spot_market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub quote_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), perp_market.load()?.quote_spot_market_index.to_le_bytes().as_ref()],
        has_one = mint,
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: locked to the cold-admin-set treasury; only used as the ATA wallet
    #[account(
        constraint = recipient.key() != Pubkey::default(),
        address = state.load()?.protocol_fee_recipient_perp @ ErrorCode::InvalidProtocolFeeRecipient
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

pub fn handle_withdraw_protocol_fees_perp<'c: 'info, 'info>(
    ctx: Context<'info, WithdrawProtocolFeesPerp<'info>>,
    _market_index: u16,
    amount: u64,
) -> Result<()> {
    let state = ctx.accounts.state.load()?;
    let now = Clock::get()?.unix_timestamp;
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    let spot_market = &mut load_mut!(ctx.accounts.quote_spot_market)?;
    // remaining accounts carry only transfer-hook extras now — the mint is a
    // named context account (the ATA init derives from it)
    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mint = Some(ctx.accounts.mint.clone());

    // the quote spot market identity is enforced by the seeds constraint;
    // this guards the pool's own market-index bookkeeping (data invariant,
    // not account identity — so it stays in the handler)
    validate!(
        perp_market.protocol_fee_pool.market_index == spot_market.market_index,
        ErrorCode::DefaultError,
        "protocol_fee_pool market mismatch: pool.market={} spot={}",
        perp_market.protocol_fee_pool.market_index,
        spot_market.market_index
    )?;

    controller::spot_balance::update_spot_market_cumulative_interest(spot_market, None, now)?;

    let available = get_token_amount(
        perp_market.protocol_fee_pool.scaled_balance,
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

    // decrement the perp market's quote-denominated claim against the quote
    // spot market (tokens are leaving the protocol)
    controller::spot_balance::update_spot_balances(
        withdraw_amount.cast()?,
        &SpotBalanceType::Borrow,
        spot_market,
        &mut perp_market.protocol_fee_pool,
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
        market_index: perp_market.market_index,
        is_perp: true,
        spot_market_index: spot_market.market_index,
        amount: withdraw_amount,
        recipient_token_account: ctx.accounts.recipient_token_account.key(),
    });

    Ok(())
}
