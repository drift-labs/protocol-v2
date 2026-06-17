use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;
use drift::cpi::accounts::RequestRemoveInsuranceFundStake as DriftRequestRemoveInsuranceFundStake;
use drift::program::Velocity;
use drift::state::insurance_fund_stake::InsuranceFundStake;
use drift::state::spot_market::SpotMarket;

use crate::constraints::{is_if_stake_for_vault, is_manager_for_vault, is_user_stats_for_vault};
use crate::drift_cpi::RequestRemoveInsuranceFundStakeCPI;
use crate::{declare_vault_seeds, Vault};

pub fn request_remove_insurance_fund_stake<'info>(
    ctx: Context<'info, RequestRemoveInsuranceFundStake<'info>>,
    market_index: u16,
    amount: u64,
) -> Result<()> {
    ctx.drift_request_remove_insurance_fund_stake(market_index, amount)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct RequestRemoveInsuranceFundStake<'info> {
    #[account(
        mut,
        constraint = is_manager_for_vault(&vault, &manager)?,
    )]
    pub vault: AccountLoader<'info, Vault>,
    pub manager: Signer<'info>,
    #[account(
        mut,
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump,
        seeds::program = drift_program.key(),
    )]
    pub drift_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"insurance_fund_stake", vault.key().as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
        seeds::program = drift_program.key(),
        constraint = is_if_stake_for_vault(&insurance_fund_stake, &vault)?,
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
        seeds::program = drift_program.key(),
    )]
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = is_user_stats_for_vault(&vault, &drift_user_stats.key())?
    )]
    /// CHECK: checked in drift cpi
    pub drift_user_stats: AccountInfo<'info>,
    pub drift_program: Program<'info, Velocity>,
}

impl<'info> RequestRemoveInsuranceFundStakeCPI
    for Context<'info, RequestRemoveInsuranceFundStake<'info>>
{
    fn drift_request_remove_insurance_fund_stake(
        &self,
        market_index: u16,
        amount: u64,
    ) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = DriftRequestRemoveInsuranceFundStake {
            spot_market: self.accounts.drift_spot_market.to_account_info().clone(),
            insurance_fund_stake: self.accounts.insurance_fund_stake.to_account_info().clone(),
            user_stats: self.accounts.drift_user_stats.clone(),
            authority: self.accounts.vault.to_account_info().clone(),
            insurance_fund_vault: self.accounts.insurance_fund_vault.to_account_info().clone(),
        };

        let drift_program = self.accounts.drift_program.key();
        let cpi_context = CpiContext::new_with_signer(drift_program, cpi_accounts, seeds)
            .with_remaining_accounts(self.remaining_accounts.into());
        drift::cpi::request_remove_insurance_fund_stake(cpi_context, market_index, amount)?;

        Ok(())
    }
}
