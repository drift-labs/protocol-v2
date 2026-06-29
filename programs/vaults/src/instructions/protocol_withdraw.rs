use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};
use anchor_spl::token::{Token, TokenAccount};
use velocity::cpi::accounts::Withdraw as VelocityWithdraw;
use velocity::instructions::optional_accounts::AccountMaps;
use velocity::program::Velocity;
use velocity::state::user::{User, UserStats};

use crate::constraints::{
    is_protocol_for_vault, is_user_for_vault, is_user_stats_for_vault, is_vault_protocol_for_vault,
};
use crate::state::{Vault, VaultProtocol};
use crate::token_cpi::TokenTransferCPI;
use crate::velocity_cpi::WithdrawCPI;
use crate::{declare_vault_seeds, AccountMapProvider};

pub fn protocol_withdraw<'info>(ctx: Context<'info, ProtocolWithdraw<'info>>) -> Result<()> {
    let clock = &Clock::get()?;
    let mut vault = ctx.accounts.vault.load_mut()?;
    let now = clock.unix_timestamp;

    let user = ctx.accounts.velocity_user.load()?;
    let spot_market_index = vault.spot_market_index;

    let mut vp = Some(ctx.accounts.vault_protocol.load_mut()?);

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = ctx.load_maps(clock.slot, Some(spot_market_index), vp.is_some(), false)?;

    let vault_equity =
        vault.calculate_equity(&user, &perp_market_map, &spot_market_map, &mut oracle_map)?;

    let spot_market = spot_market_map.get_ref(&spot_market_index)?;
    let oracle = oracle_map.get_price_data(&spot_market.oracle_id())?;

    let protocol_withdraw_amount =
        vault.protocol_withdraw(&mut vp, &mut None, vault_equity, now, oracle.price)?;

    drop(spot_market);
    drop(vault);
    drop(user);
    drop(vp);

    ctx.velocity_withdraw(protocol_withdraw_amount)?;

    ctx.token_transfer(protocol_withdraw_amount)?;

    Ok(())
}

#[derive(Accounts)]
pub struct ProtocolWithdraw<'info> {
    #[account(
        mut,
        constraint = is_protocol_for_vault(&vault, &vault_protocol, &protocol)?
    )]
    pub vault: AccountLoader<'info, Vault>,
    #[account(
        mut,
        constraint = is_vault_protocol_for_vault(&vault_protocol, &vault)?
    )]
    pub vault_protocol: AccountLoader<'info, VaultProtocol>,
    pub protocol: Signer<'info>,
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
    pub velocity_user_stats: AccountLoader<'info, UserStats>,
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
    /// CHECK: checked in velocity cpi
    pub velocity_signer: AccountInfo<'info>,
    #[account(
        mut,
        token::authority = protocol,
        token::mint = vault_token_account.mint
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub velocity_program: Program<'info, Velocity>,
    pub token_program: Program<'info, Token>,
}

impl<'info> WithdrawCPI for Context<'info, ProtocolWithdraw<'info>> {
    fn velocity_withdraw(&self, amount: u64) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);
        let spot_market_index = self.accounts.vault.load()?.spot_market_index;

        let cpi_accounts = VelocityWithdraw {
            state: self.accounts.velocity_state.to_account_info().clone(),
            user: self.accounts.velocity_user.to_account_info().clone(),
            user_stats: self.accounts.velocity_user_stats.to_account_info().clone(),
            authority: self.accounts.vault.to_account_info().clone(),
            spot_market_vault: self
                .accounts
                .velocity_spot_market_vault
                .to_account_info()
                .clone(),
            velocity_signer: self.accounts.velocity_signer.to_account_info().clone(),
            user_token_account: self.accounts.vault_token_account.to_account_info().clone(),
            token_program: self.accounts.token_program.to_account_info().clone(),
        };

        let velocity_program = self.accounts.velocity_program.key();
        let cpi_context = CpiContext::new_with_signer(velocity_program, cpi_accounts, seeds)
            .with_remaining_accounts(self.remaining_accounts.into());
        velocity::cpi::withdraw(cpi_context, spot_market_index, amount, false)?;

        Ok(())
    }
}

impl<'info> TokenTransferCPI for Context<'info, ProtocolWithdraw<'info>> {
    fn token_transfer(&self, amount: u64) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = Transfer {
            from: self.accounts.vault_token_account.to_account_info().clone(),
            to: self.accounts.user_token_account.to_account_info().clone(),
            authority: self.accounts.vault.to_account_info().clone(),
        };
        let token_program = self.accounts.token_program.key();
        let cpi_context = CpiContext::new_with_signer(token_program, cpi_accounts, seeds);

        token::transfer(cpi_context, amount)?;

        Ok(())
    }
}
