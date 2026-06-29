use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use velocity::cpi::accounts::Deposit as VelocityDeposit;
use velocity::instructions::optional_accounts::AccountMaps;
use velocity::program::Velocity;
use velocity::state::user::User;

use crate::constraints::{is_manager_for_vault, is_user_for_vault, is_user_stats_for_vault};
use crate::state::{Vault, VaultProtocolProvider};
use crate::token_cpi::TokenTransferCPI;
use crate::velocity_cpi::DepositCPI;
use crate::{declare_vault_seeds, AccountMapProvider};

pub fn manager_deposit<'info>(
    ctx: Context<'info, ManagerDeposit<'info>>,
    amount: u64,
) -> Result<()> {
    let clock = &Clock::get()?;

    let mut vault = ctx.accounts.vault.load_mut()?;

    // backwards compatible: if last rem acct does not deserialize into [`VaultProtocol`] then it's a legacy vault.
    let mut vp = ctx.vault_protocol();
    vault.validate_vault_protocol(&vp)?;
    let mut vp = vp.as_mut().map(|vp| vp.load_mut()).transpose()?;

    let user = ctx.accounts.velocity_user.load()?;
    let spot_market_index = vault.spot_market_index;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = ctx.load_maps(clock.slot, Some(spot_market_index), vp.is_some(), false)?;

    let vault_equity =
        vault.calculate_equity(&user, &perp_market_map, &spot_market_map, &mut oracle_map)?;

    let spot_market = spot_market_map.get_ref(&spot_market_index)?;
    let oracle = oracle_map.get_price_data(&spot_market.oracle_id())?;

    vault.manager_deposit(
        &mut vp,
        &mut None,
        amount,
        vault_equity,
        clock.unix_timestamp,
        oracle.price,
    )?;

    drop(spot_market);
    drop(vault);
    drop(user);
    drop(vp);

    ctx.token_transfer(amount)?;

    ctx.velocity_deposit(amount)?;

    Ok(())
}

#[derive(Accounts)]
pub struct ManagerDeposit<'info> {
    #[account(
        mut,
        constraint = is_manager_for_vault(&vault, &manager)?
    )]
    pub vault: AccountLoader<'info, Vault>,
    pub manager: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault_token_account".as_ref(), vault.key().as_ref()],
        bump,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = is_user_stats_for_vault(&vault, &velocity_user_stats.key())?
    )]
    /// CHECK: checked in velocity cpi
    pub velocity_user_stats: AccountInfo<'info>,
    #[account(
        mut,
        constraint = is_user_for_vault(&vault, &velocity_user.key())?
    )]
    /// CHECK: checked in velocity cpi
    pub velocity_user: AccountLoader<'info, User>,
    /// CHECK: checked in velocity cpi
    pub velocity_state: AccountInfo<'info>,
    #[account(
        mut,
        token::mint = vault_token_account.mint
    )]
    pub velocity_spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::authority = manager,
        token::mint = vault_token_account.mint
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub velocity_program: Program<'info, Velocity>,
    pub token_program: Program<'info, Token>,
}

impl<'info> TokenTransferCPI for Context<'info, ManagerDeposit<'info>> {
    fn token_transfer(&self, amount: u64) -> Result<()> {
        let cpi_accounts = Transfer {
            from: self.accounts.user_token_account.to_account_info().clone(),
            to: self.accounts.vault_token_account.to_account_info().clone(),
            authority: self.accounts.manager.to_account_info().clone(),
        };
        let token_program = self.accounts.token_program.key();
        let cpi_context = CpiContext::new(token_program, cpi_accounts);

        token::transfer(cpi_context, amount)?;

        Ok(())
    }
}

impl<'info> DepositCPI for Context<'info, ManagerDeposit<'info>> {
    fn velocity_deposit(&self, amount: u64) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);
        let spot_market_index = self.accounts.vault.load()?.spot_market_index;

        let cpi_program = self.accounts.velocity_program.key();
        let cpi_accounts = VelocityDeposit {
            state: self.accounts.velocity_state.clone(),
            user: self.accounts.velocity_user.to_account_info().clone(),
            user_stats: self.accounts.velocity_user_stats.clone(),
            authority: self.accounts.vault.to_account_info().clone(),
            spot_market_vault: self
                .accounts
                .velocity_spot_market_vault
                .to_account_info()
                .clone(),
            user_token_account: self.accounts.vault_token_account.to_account_info().clone(),
            token_program: self.accounts.token_program.to_account_info().clone(),
        };
        let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, seeds)
            .with_remaining_accounts(self.remaining_accounts.into());
        velocity::cpi::deposit(cpi_context, spot_market_index, amount, false)?;

        Ok(())
    }
}
