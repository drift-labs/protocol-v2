use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use drift::cpi::accounts::InitializeInsuranceFundStake as DriftInitializeInsuranceFundStake;
use drift::program::Velocity;
use drift::state::spot_market::SpotMarket;

use crate::constraints::{is_manager_for_vault, is_user_stats_for_vault};
use crate::drift_cpi::InitializeInsuranceFundStakeCPI;
use crate::{declare_vault_seeds, Vault};

pub fn initialize_insurance_fund_stake<'info>(
    ctx: Context<'info, InitializeInsuranceFundStake<'info>>,
    market_index: u16,
) -> Result<()> {
    ctx.drift_initialize_insurance_fund_stake(market_index)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct InitializeInsuranceFundStake<'info> {
    #[account(
        mut,
        constraint = is_manager_for_vault(&vault, &manager)?,
    )]
    pub vault: AccountLoader<'info, Vault>,
    pub manager: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    #[account(
        mut,
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump,
        seeds::program = drift_program.key(),
    )]
    pub drift_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        constraint = drift_spot_market.load()?.mint.eq(&drift_spot_market_mint.key())
    )]
    pub drift_spot_market_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        seeds = [b"vault_token_account".as_ref(), vault.key().as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
        payer = payer,
        token::mint = drift_spot_market_mint,
        token::authority = vault
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked in drift cpi
    #[account(
        mut,
        seeds = [b"insurance_fund_stake", vault.key().as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
        seeds::program = drift_program.key(),
    )]
    pub insurance_fund_stake: AccountInfo<'info>,
    #[account(
        mut,
        constraint = is_user_stats_for_vault(&vault, &drift_user_stats.key())?
    )]
    /// CHECK: checked in drift cpi
    pub drift_user_stats: AccountInfo<'info>,
    /// CHECK: checked in drift cpi
    pub drift_state: AccountInfo<'info>,
    pub drift_program: Program<'info, Velocity>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> InitializeInsuranceFundStakeCPI
    for Context<'info, InitializeInsuranceFundStake<'info>>
{
    fn drift_initialize_insurance_fund_stake(&self, market_index: u16) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = DriftInitializeInsuranceFundStake {
            spot_market: self.accounts.drift_spot_market.to_account_info().clone(),
            insurance_fund_stake: self.accounts.insurance_fund_stake.to_account_info().clone(),
            user_stats: self.accounts.drift_user_stats.clone(),
            state: self.accounts.drift_state.clone(),
            authority: self.accounts.vault.to_account_info().clone(), // sign?
            payer: self.accounts.payer.to_account_info().clone(),
            rent: self.accounts.rent.to_account_info().clone(),
            system_program: self.accounts.system_program.to_account_info().clone(),
        };

        let drift_program = self.accounts.drift_program.key();
        let cpi_context = CpiContext::new_with_signer(drift_program, cpi_accounts, seeds)
            .with_remaining_accounts(self.remaining_accounts.into());
        drift::cpi::initialize_insurance_fund_stake(cpi_context, market_index)?;

        Ok(())
    }
}
