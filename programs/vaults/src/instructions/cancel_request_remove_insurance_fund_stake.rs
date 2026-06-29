use anchor_lang::prelude::*;
use velocity::cpi::accounts::RequestRemoveInsuranceFundStake as VelocityRequestRemoveInsuranceFundStake;

use crate::instructions::RequestRemoveInsuranceFundStake;
use crate::velocity_cpi::CancelRequestRemoveInsuranceFundStakeCPI;
use crate::{declare_vault_seeds, Vault};

pub fn cancel_request_remove_insurance_fund_stake<'info>(
    ctx: Context<'info, RequestRemoveInsuranceFundStake<'info>>,
    market_index: u16,
) -> Result<()> {
    ctx.velocity_cancel_request_remove_insurance_fund_stake(market_index)?;
    Ok(())
}

impl<'info> CancelRequestRemoveInsuranceFundStakeCPI
    for Context<'info, RequestRemoveInsuranceFundStake<'info>>
{
    fn velocity_cancel_request_remove_insurance_fund_stake(&self, market_index: u16) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = VelocityRequestRemoveInsuranceFundStake {
            spot_market: self.accounts.velocity_spot_market.to_account_info().clone(),
            insurance_fund_stake: self.accounts.insurance_fund_stake.to_account_info().clone(),
            user_stats: self.accounts.velocity_user_stats.clone(),
            authority: self.accounts.vault.to_account_info().clone(),
            insurance_fund_vault: self.accounts.insurance_fund_vault.to_account_info().clone(),
        };

        let velocity_program = self.accounts.velocity_program.key();
        let cpi_context = CpiContext::new_with_signer(velocity_program, cpi_accounts, seeds)
            .with_remaining_accounts(self.remaining_accounts.into());
        velocity::cpi::cancel_request_remove_insurance_fund_stake(cpi_context, market_index)?;

        Ok(())
    }
}
