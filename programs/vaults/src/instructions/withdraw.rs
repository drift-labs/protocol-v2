use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};
use anchor_spl::token::{Token, TokenAccount};
use velocity::cpi::accounts::{UpdateUser, Withdraw as VelocityWithdraw};
use velocity::instructions::optional_accounts::AccountMaps;
use velocity::program::Velocity;
use velocity::state::user::{User, UserStats};

use crate::constraints::{
    is_authority_for_vault_depositor, is_user_for_vault, is_user_stats_for_vault,
};
use crate::state::{
    FeeUpdateProvider, FeeUpdateStatus, Vault, VaultDepositor, VaultProtocolProvider,
};
use crate::token_cpi::TokenTransferCPI;
use crate::velocity_cpi::{UpdateUserDelegateCPI, UpdateUserReduceOnlyCPI, WithdrawCPI};
use crate::{
    declare_vault_seeds, implement_update_user_delegate_cpi, implement_update_user_reduce_only_cpi,
    implement_withdraw, AccountMapProvider,
};

pub fn withdraw<'info>(ctx: Context<'info, Withdraw<'info>>) -> Result<()> {
    let clock = &Clock::get()?;
    let mut vault = ctx.accounts.vault.load_mut()?;
    let mut vault_depositor = ctx.accounts.vault_depositor.load_mut()?;

    // backwards compatible: if last rem acct does not deserialize into [`VaultProtocol`] then it's a legacy vault.
    let mut vp = ctx.vault_protocol();
    vault.validate_vault_protocol(&vp)?;
    let mut vp = vp.as_mut().map(|vp| vp.load_mut()).transpose()?;

    let user = ctx.accounts.velocity_user.load()?;
    let spot_market_index = vault.spot_market_index;

    let has_fee_update = FeeUpdateStatus::has_pending_fee_update(vault.fee_update_status);
    let mut fee_update = ctx.fee_update(vp.is_some(), has_fee_update);
    vault.validate_fee_update(&fee_update)?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = ctx.load_maps(
        clock.slot,
        Some(spot_market_index),
        vp.is_some(),
        has_fee_update,
    )?;

    let vault_equity =
        vault.calculate_equity(&user, &perp_market_map, &spot_market_map, &mut oracle_map)?;

    let spot_market = spot_market_map.get_ref(&spot_market_index)?;
    let oracle = oracle_map.get_price_data(&spot_market.oracle_id())?;

    let (user_withdraw_amount, finishing_liquidation) = vault_depositor.withdraw(
        vault_equity,
        &mut vault,
        &mut vp,
        &mut fee_update,
        clock.unix_timestamp,
        oracle.price,
    )?;

    msg!("user_withdraw_amount: {}", user_withdraw_amount);

    drop(spot_market);
    drop(vault);
    drop(user);
    drop(vp);

    ctx.velocity_withdraw(user_withdraw_amount)?;

    ctx.token_transfer(user_withdraw_amount)?;

    if finishing_liquidation {
        let mut vault = ctx.accounts.vault.load_mut()?;
        let vault_delegate = vault.delegate;
        vault.reset_liquidation_delegate();
        drop(vault);

        ctx.velocity_update_user_delegate(vault_delegate)?;
        ctx.velocity_update_user_reduce_only(false)?;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    #[account(
        mut,
        seeds = [b"vault_depositor", vault.key().as_ref(), authority.key().as_ref()],
        bump,
        constraint = is_authority_for_vault_depositor(&vault_depositor, &authority)?,
    )]
    pub vault_depositor: AccountLoader<'info, VaultDepositor>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault_token_account".as_ref(), vault.key().as_ref()],
        bump,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = is_user_stats_for_vault(&vault, &velocity_user_stats.key())?
    )]
    /// CHECK: checked in velocity cpi
    pub velocity_user_stats: AccountLoader<'info, UserStats>,
    #[account(
        mut,
        constraint = is_user_for_vault(&vault, &velocity_user.key())?
    )]
    /// CHECK: checked in velocity cpi
    pub velocity_user: AccountLoader<'info, User>,
    /// CHECK: checked in velocity cpi
    pub velocity_state: AccountInfo<'info>,
    #[account(
        mut,
        token::mint = vault_token_account.mint
    )]
    pub velocity_spot_market_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked in velocity cpi
    pub velocity_signer: AccountInfo<'info>,
    #[account(
        mut,
        token::authority = authority,
        token::mint = vault_token_account.mint
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub velocity_program: Program<'info, Velocity>,
    pub token_program: Program<'info, Token>,
}

impl<'info> WithdrawCPI for Context<'info, Withdraw<'info>> {
    fn velocity_withdraw(&self, amount: u64) -> Result<()> {
        implement_withdraw!(self, amount);
        Ok(())
    }
}

impl<'info> TokenTransferCPI for Context<'info, Withdraw<'info>> {
    fn token_transfer(&self, amount: u64) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = Transfer {
            from: self.accounts.vault_token_account.to_account_info().clone(),
            to: self.accounts.user_token_account.to_account_info().clone(),
            authority: self.accounts.vault.to_account_info().clone(),
        };
        let token_program = self.accounts.token_program.key();
        let cpi_context = CpiContext::new_with_signer(token_program, cpi_accounts, seeds);

        token::transfer(cpi_context, amount)?;

        Ok(())
    }
}

impl<'info> UpdateUserDelegateCPI for Context<'info, Withdraw<'info>> {
    fn velocity_update_user_delegate(&self, delegate: Pubkey) -> Result<()> {
        implement_update_user_delegate_cpi!(self, delegate);
        Ok(())
    }
}

impl<'info> UpdateUserReduceOnlyCPI for Context<'info, Withdraw<'info>> {
    fn velocity_update_user_reduce_only(&self, reduce_only: bool) -> Result<()> {
        implement_update_user_reduce_only_cpi!(self, reduce_only);
        Ok(())
    }
}
