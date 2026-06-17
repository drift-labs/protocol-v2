use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use drift::cpi::accounts::AddInsuranceFundStake as DriftAddInsuranceFundStake;
use drift::program::Velocity;
use drift::state::insurance_fund_stake::InsuranceFundStake;
use drift::state::spot_market::SpotMarket;

use crate::constraints::{is_if_stake_for_vault, is_manager_for_vault, is_user_stats_for_vault};
use crate::drift_cpi::AddInsuranceFundStakeCPI;
use crate::token_cpi::TokenTransferCPI;
use crate::{declare_vault_seeds, Vault};

pub fn add_insurance_fund_stake<'info>(
    ctx: Context<'info, AddInsuranceFundStake<'info>>,
    market_index: u16,
    amount: u64,
) -> Result<()> {
    ctx.token_transfer(amount)?;
    ctx.drift_add_insurance_fund_stake(market_index, amount)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct AddInsuranceFundStake<'info> {
    #[account(
        mut,
        constraint = is_manager_for_vault(&vault, &manager)?,
    )]
    pub vault: AccountLoader<'info, Vault>,
    #[account(mut)]
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
        seeds = [b"spot_market_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
        seeds::program = drift_program.key(),
    )]
    pub drift_spot_market_vault: Box<Account<'info, TokenAccount>>,
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
        token::mint = drift_spot_market_vault.mint,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = drift_spot_market_vault.mint,
        token::authority = manager,
    )]
    pub manager_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"vault_token_account".as_ref(), vault.key().as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
        token::authority = vault,
    )]
    pub vault_if_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = is_user_stats_for_vault(&vault, &drift_user_stats.key())?
    )]
    /// CHECK: checked in drift cpi
    pub drift_user_stats: AccountInfo<'info>,
    /// CHECK: checked in drift cpi
    pub drift_state: AccountInfo<'info>,
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    pub drift_program: Program<'info, Velocity>,
    pub token_program: Program<'info, Token>,
}

impl<'info> TokenTransferCPI for Context<'info, AddInsuranceFundStake<'info>> {
    fn token_transfer(&self, amount: u64) -> Result<()> {
        let cpi_accounts = Transfer {
            from: self
                .accounts
                .manager_token_account
                .to_account_info()
                .clone(),
            to: self
                .accounts
                .vault_if_token_account
                .to_account_info()
                .clone(),
            authority: self.accounts.manager.to_account_info().clone(),
        };
        let token_program = self.accounts.token_program.key();
        let cpi_context = CpiContext::new(token_program, cpi_accounts);

        token::transfer(cpi_context, amount)?;

        Ok(())
    }
}

impl<'info> AddInsuranceFundStakeCPI for Context<'info, AddInsuranceFundStake<'info>> {
    fn drift_add_insurance_fund_stake(&self, market_index: u16, amount: u64) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = DriftAddInsuranceFundStake {
            state: self.accounts.drift_state.clone(),
            spot_market: self.accounts.drift_spot_market.to_account_info().clone(),
            insurance_fund_stake: self.accounts.insurance_fund_stake.to_account_info().clone(),
            user_stats: self.accounts.drift_user_stats.clone(),
            authority: self.accounts.vault.to_account_info().clone(),
            spot_market_vault: self
                .accounts
                .drift_spot_market_vault
                .to_account_info()
                .clone(),
            insurance_fund_vault: self.accounts.insurance_fund_vault.to_account_info().clone(),
            user_token_account: self
                .accounts
                .vault_if_token_account
                .to_account_info()
                .clone(),
            token_program: self.accounts.token_program.to_account_info().clone(),
            velocity_signer: self.accounts.drift_signer.clone(),
        };

        let drift_program = self.accounts.drift_program.key();
        let cpi_context = CpiContext::new_with_signer(drift_program, cpi_accounts, seeds)
            .with_remaining_accounts(self.remaining_accounts.into());
        drift::cpi::add_insurance_fund_stake(cpi_context, market_index, amount)?;

        Ok(())
    }
}
