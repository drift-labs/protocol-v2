use anchor_lang::prelude::*;
use velocity::cpi::accounts::UpdateUser;
use velocity::program::Velocity;
use velocity::state::user::User;

use crate::constraints::{is_manager_for_vault, is_user_for_vault};
use crate::declare_vault_seeds;
use crate::velocity_cpi::UpdatePoolIdCPI;
use crate::Vault;

pub fn update_pool_id<'info>(ctx: Context<'info, UpdatePoolId<'info>>, pool_id: u8) -> Result<()> {
    ctx.velocity_update_pool_id(pool_id)?;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdatePoolId<'info> {
    #[account(
        mut,
        constraint = is_manager_for_vault(&vault, &manager)?,
    )]
    pub vault: AccountLoader<'info, Vault>,
    pub manager: Signer<'info>,
    #[account(
        mut,
        constraint = is_user_for_vault(&vault, &velocity_user.key())?
    )]
    /// CHECK: checked in velocity cpi
    pub velocity_user: AccountLoader<'info, User>,
    pub velocity_program: Program<'info, Velocity>,
}

impl<'info> UpdatePoolIdCPI for Context<'info, UpdatePoolId<'info>> {
    fn velocity_update_pool_id(&self, pool_id: u8) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = UpdateUser {
            user: self.accounts.velocity_user.to_account_info().clone(),
            authority: self.accounts.vault.to_account_info().clone(),
        };

        let velocity_program = self.accounts.velocity_program.key();
        let cpi_context = CpiContext::new_with_signer(velocity_program, cpi_accounts, seeds)
            .with_remaining_accounts(self.remaining_accounts.into());
        velocity::cpi::update_user_pool_id(cpi_context, 0, pool_id)?;

        Ok(())
    }
}
