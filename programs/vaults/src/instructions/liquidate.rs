use anchor_lang::prelude::*;
use drift::cpi::accounts::UpdateUser;
use drift::instructions::optional_accounts::AccountMaps;
use drift::program::Velocity;
use drift::state::user::User;

use crate::constants::admin;
use crate::constraints::{
    is_admin, is_authority_key_for_vault_depositor, is_user_for_vault, is_user_stats_for_vault,
};
use crate::drift_cpi::{UpdateUserDelegateCPI, UpdateUserReduceOnlyCPI};
use crate::state::{Vault, VaultDepositor};
use crate::{declare_vault_seeds, implement_update_user_delegate_cpi};
use crate::{implement_update_user_reduce_only_cpi, AccountMapProvider, VaultProtocolProvider};

pub fn liquidate<'info>(ctx: Context<'info, Liquidate<'info>>) -> Result<()> {
    let clock = &Clock::get()?;
    let now = Clock::get()?.unix_timestamp;

    let mut user = ctx.accounts.drift_user.load_mut()?;
    let mut vault = ctx.accounts.vault.load_mut()?;
    let vault_depositor = ctx.accounts.vault_depositor.load()?;

    // backwards compatible: if last rem acct does not deserialize into [`VaultProtocol`] then it's a legacy vault.
    let mut vp = ctx.vault_protocol();
    vault.validate_vault_protocol(&vp)?;
    let vp = vp.as_mut().map(|vp| vp.load_mut()).transpose()?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = ctx.load_maps(
        clock.slot,
        Some(vault.spot_market_index),
        vp.is_some(),
        false,
    )?;

    // 1. Check the vault depositor has waited the redeem period
    vault_depositor
        .last_withdraw_request
        .check_redeem_period_finished(&vault, now)?;
    // 2. Check that the depositor is unable to withdraw
    let vault_equity =
        vault.calculate_equity(&user, &perp_market_map, &spot_market_map, &mut oracle_map)?;
    vault_depositor.check_cant_withdraw(
        &vault,
        vault_equity,
        &mut user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
    )?;
    // 3. Check that the vault is not already in liquidation
    vault.check_available_for_liquidation(now)?;

    vault.set_liquidation_delegate(admin::ID, now);

    drop(user);
    drop(vault);
    drop(vp);

    ctx.drift_update_user_delegate(admin::ID)?;
    ctx.drift_update_user_reduce_only(true)?;

    Ok(())
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    #[account(
        mut,
        seeds = [b"vault_depositor", vault.key().as_ref(), authority.key().as_ref()],
        bump,
    )]
    pub vault_depositor: AccountLoader<'info, VaultDepositor>,
    #[account(
        constraint = is_authority_key_for_vault_depositor(&vault_depositor, &authority.key())?,
    )]
    /// CHECK: checked in constraints
    pub authority: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = is_admin(&admin)?,
    )]
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = is_user_stats_for_vault(&vault, &drift_user_stats.key())?
    )]
    /// CHECK: checked in drift cpi
    pub drift_user_stats: AccountInfo<'info>,
    #[account(
        mut,
        constraint = is_user_for_vault(&vault, &drift_user.key())?
    )]
    /// CHECK: checked in drift cpi
    pub drift_user: AccountLoader<'info, User>,
    pub drift_program: Program<'info, Velocity>,
}

impl<'info> UpdateUserDelegateCPI for Context<'info, Liquidate<'info>> {
    fn drift_update_user_delegate(&self, delegate: Pubkey) -> Result<()> {
        implement_update_user_delegate_cpi!(self, delegate);
        Ok(())
    }
}

impl<'info> UpdateUserReduceOnlyCPI for Context<'info, Liquidate<'info>> {
    fn drift_update_user_reduce_only(&self, reduce_only: bool) -> Result<()> {
        implement_update_user_reduce_only_cpi!(self, reduce_only);
        Ok(())
    }
}
