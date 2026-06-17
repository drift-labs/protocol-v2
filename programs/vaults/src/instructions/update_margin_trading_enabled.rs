use anchor_lang::prelude::*;
use drift::cpi::accounts::UpdateUser;
use drift::program::Velocity;
use drift::state::user::User;

use crate::constraints::{is_manager_for_vault, is_user_for_vault};
use crate::drift_cpi::UpdateUserMarginTradingEnabledCPI;
use crate::error::ErrorCode;
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

    ctx.drift_update_user_margin_trading_enabled(enabled)?;

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
        constraint = is_user_for_vault(&vault, &drift_user.key())?
    )]
    /// CHECK: checked in drift cpi
    pub drift_user: AccountLoader<'info, User>,
    pub drift_program: Program<'info, Velocity>,
}

impl<'info> UpdateUserMarginTradingEnabledCPI
    for Context<'info, UpdateMarginTradingEnabled<'info>>
{
    fn drift_update_user_margin_trading_enabled(&self, enabled: bool) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = UpdateUser {
            user: self.accounts.drift_user.to_account_info().clone(),
            authority: self.accounts.vault.to_account_info().clone(),
        };

        let drift_program = self.accounts.drift_program.key();
        let cpi_context = CpiContext::new_with_signer(drift_program, cpi_accounts, seeds)
            .with_remaining_accounts(self.remaining_accounts.into());
        drift::cpi::update_user_margin_trading_enabled(cpi_context, 0, enabled)?;

        Ok(())
    }
}
