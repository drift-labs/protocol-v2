use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use velocity::cpi::accounts::RemoveInsuranceFundStake as VelocityRemoveInsuranceFundStake;
use velocity::math::safe_math::SafeMath;
use velocity::program::Velocity;
use velocity::state::insurance_fund_stake::InsuranceFundStake;
use velocity::state::spot_market::SpotMarket;

use crate::constraints::{is_if_stake_for_vault, is_manager_for_vault, is_user_stats_for_vault};
use crate::token_cpi::TokenTransferCPI;
use crate::velocity_cpi::RemoveInsuranceFundStakeCPI;
use crate::{declare_vault_seeds, Vault};

pub fn remove_insurance_fund_stake<'info>(
    ctx: Context<'info, RemoveInsuranceFundStake<'info>>,
    market_index: u16,
) -> Result<()> {
    let token_balance_before = ctx.accounts.vault_if_token_account.amount;
    ctx.velocity_remove_insurance_fund_stake(market_index)?;
    ctx.accounts.vault_if_token_account.reload()?;
    let token_balance_after = ctx.accounts.vault_if_token_account.amount;
    msg!(
        "token_balance_before: {} token_balance_after: {}",
        token_balance_before,
        token_balance_after
    );

    ctx.token_transfer(token_balance_after.safe_sub(token_balance_before)?)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct RemoveInsuranceFundStake<'info> {
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
        seeds::program = velocity_program.key(),
    )]
    pub velocity_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"insurance_fund_stake", vault.key().as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
        seeds::program = velocity_program.key(),
        constraint = is_if_stake_for_vault(&insurance_fund_stake, &vault)?,
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
        seeds::program = velocity_program.key(),
        token::mint = velocity_spot_market.load()?.mint,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = insurance_fund_vault.mint,
        token::authority = manager
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
        constraint = is_user_stats_for_vault(&vault, &velocity_user_stats.key())?
    )]
    /// CHECK: checked in velocity cpi
    pub velocity_user_stats: AccountInfo<'info>,
    /// CHECK: checked in velocity cpi
    pub velocity_state: AccountInfo<'info>,
    /// CHECK: forced velocity_signer
    pub velocity_signer: AccountInfo<'info>,
    pub velocity_program: Program<'info, Velocity>,
    pub token_program: Program<'info, Token>,
}

impl<'info> TokenTransferCPI for Context<'info, RemoveInsuranceFundStake<'info>> {
    fn token_transfer(&self, amount: u64) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = Transfer {
            from: self
                .accounts
                .vault_if_token_account
                .to_account_info()
                .clone(),
            to: self
                .accounts
                .manager_token_account
                .to_account_info()
                .clone(),
            authority: self.accounts.vault.to_account_info().clone(),
        };
        let token_program = self.accounts.token_program.key();
        let cpi_context = CpiContext::new_with_signer(token_program, cpi_accounts, seeds);

        token::transfer(cpi_context, amount)?;

        Ok(())
    }
}

impl<'info> RemoveInsuranceFundStakeCPI for Context<'info, RemoveInsuranceFundStake<'info>> {
    fn velocity_remove_insurance_fund_stake(&self, market_index: u16) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = VelocityRemoveInsuranceFundStake {
            state: self.accounts.velocity_state.clone(),
            spot_market: self.accounts.velocity_spot_market.to_account_info().clone(),
            insurance_fund_stake: self.accounts.insurance_fund_stake.to_account_info().clone(),
            user_stats: self.accounts.velocity_user_stats.clone(),
            authority: self.accounts.vault.to_account_info().clone(),
            insurance_fund_vault: self.accounts.insurance_fund_vault.to_account_info().clone(),
            user_token_account: self
                .accounts
                .vault_if_token_account
                .to_account_info()
                .clone(),
            token_program: self.accounts.token_program.to_account_info().clone(),
            velocity_signer: self.accounts.velocity_signer.clone(),
        };

        let velocity_program = self.accounts.velocity_program.key();
        let cpi_context = CpiContext::new_with_signer(velocity_program, cpi_accounts, seeds)
            .with_remaining_accounts(self.remaining_accounts.into());
        velocity::cpi::remove_insurance_fund_stake(cpi_context, market_index)?;

        Ok(())
    }
}
