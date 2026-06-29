use anchor_lang::prelude::*;
use velocity::cpi::accounts::UpdateUser;
use velocity::program::Velocity;
use velocity::state::user::User;

use crate::constraints::{is_manager_for_vault, is_user_for_vault};
use crate::error::ErrorCode;
use crate::velocity_cpi::UpdateUserMarginTradingEnabledCPI;
use crate::Vault;
use crate::{declare_vault_seeds, validate};

pub fn update_margin_trading_enabled<'info>(
    ctx: Context<'info, UpdateMarginTradingEnabled<'info>>,
    enabled: bool,
) -> Result<()> {
    validate!(
        !ctx.accounts.vault.load()?.in_liquidation(),
        ErrorCode::OngoingLiquidation
    )?;

    ctx.velocity_update_user_margin_trading_enabled(enabled)?;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateMarginTradingEnabled<'info> {
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

impl<'info> UpdateUserMarginTradingEnabledCPI
    for Context<'info, UpdateMarginTradingEnabled<'info>>
{
    fn velocity_update_user_margin_trading_enabled(&self, enabled: bool) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = UpdateUser {
            user: self.accounts.velocity_user.to_account_info().clone(),
            authority: self.accounts.vault.to_account_info().clone(),
        };

        let velocity_program = self.accounts.velocity_program.key();
        let cpi_context = CpiContext::new_with_signer(velocity_program, cpi_accounts, seeds)
            .with_remaining_accounts(self.remaining_accounts.into());
        velocity::cpi::update_user_margin_trading_enabled(cpi_context, 0, enabled)?;

        Ok(())
    }
}
