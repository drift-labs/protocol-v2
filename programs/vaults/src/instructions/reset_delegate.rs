use anchor_lang::prelude::*;
use velocity::cpi::accounts::UpdateUser;
use velocity::program::Velocity;
use velocity::state::user::User;

use crate::constraints::is_user_for_vault;
use crate::error::ErrorCode;
use crate::state::Vault;
use crate::validate;
use crate::velocity_cpi::{UpdateUserDelegateCPI, UpdateUserReduceOnlyCPI};
use crate::{
    declare_vault_seeds, implement_update_user_delegate_cpi, implement_update_user_reduce_only_cpi,
};

pub fn reset_delegate<'info>(ctx: Context<'info, ResetDelegate<'info>>) -> Result<()> {
    let mut vault = ctx.accounts.vault.load_mut()?;

    validate!(
        vault.in_liquidation(),
        ErrorCode::Default,
        "vault not in liquidation"
    )?;

    let now = Clock::get()?.unix_timestamp;
    vault.check_can_exit_liquidation(now)?;
    vault.reset_liquidation_delegate();

    let delegate = vault.delegate;

    drop(vault);

    ctx.velocity_update_user_delegate(delegate)?;
    ctx.velocity_update_user_reduce_only(false)?;

    Ok(())
}

#[derive(Accounts)]
pub struct ResetDelegate<'info> {
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    #[account(
        mut,
        constraint = is_user_for_vault(&vault, &velocity_user.key())?
    )]
    /// CHECK: checked in velocity cpi
    pub velocity_user: AccountLoader<'info, User>,
    pub velocity_program: Program<'info, Velocity>,
}

impl<'info> UpdateUserDelegateCPI for Context<'info, ResetDelegate<'info>> {
    fn velocity_update_user_delegate(&self, delegate: Pubkey) -> Result<()> {
        implement_update_user_delegate_cpi!(self, delegate);
        Ok(())
    }
}

impl<'info> UpdateUserReduceOnlyCPI for Context<'info, ResetDelegate<'info>> {
    fn velocity_update_user_reduce_only(&self, reduce_only: bool) -> Result<()> {
        implement_update_user_reduce_only_cpi!(self, reduce_only);
        Ok(())
    }
}
