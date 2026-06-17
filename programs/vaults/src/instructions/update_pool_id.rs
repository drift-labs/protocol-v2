use anchor_lang::prelude::*;
use drift::cpi::accounts::UpdateUser;
use drift::program::Velocity;
use drift::state::user::User;

use crate::constraints::{is_manager_for_vault, is_user_for_vault};
use crate::declare_vault_seeds;
use crate::drift_cpi::UpdatePoolIdCPI;
use crate::Vault;

pub fn update_pool_id<'info>(ctx: Context<'info, UpdatePoolId<'info>>, pool_id: u8) -> Result<()> {
    ctx.drift_update_pool_id(pool_id)?;

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
        constraint = is_user_for_vault(&vault, &drift_user.key())?
    )]
    /// CHECK: checked in drift cpi
    pub drift_user: AccountLoader<'info, User>,
    pub drift_program: Program<'info, Velocity>,
}

impl<'info> UpdatePoolIdCPI for Context<'info, UpdatePoolId<'info>> {
    fn drift_update_pool_id(&self, pool_id: u8) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = UpdateUser {
            user: self.accounts.drift_user.to_account_info().clone(),
            authority: self.accounts.vault.to_account_info().clone(),
        };

        let drift_program = self.accounts.drift_program.key();
        let cpi_context = CpiContext::new_with_signer(drift_program, cpi_accounts, seeds)
            .with_remaining_accounts(self.remaining_accounts.into());
        drift::cpi::update_user_pool_id(cpi_context, 0, pool_id)?;

        Ok(())
    }
}
