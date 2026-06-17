use crate::constraints::{is_manager_for_vault, is_user_for_vault, is_user_stats_for_vault};
use crate::drift_cpi::ManagerBorrowCPI;
use crate::math::token_a_to_token_b;
use crate::state::events::{ManagerBorrowRecord, ManagerUpdateBorrowRecord};
use crate::state::{FeeUpdateProvider, FeeUpdateStatus, VaultProtocolProvider};
use crate::token_cpi::TokenTransferCPI;
use crate::{declare_vault_seeds, AccountMapProvider};
use crate::{error::ErrorCode, validate, Vault};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};
use anchor_spl::token::{Token, TokenAccount};
use drift::cpi::accounts::Withdraw as DriftWithdraw;
use drift::instructions::optional_accounts::AccountMaps;
use drift::math::safe_math::SafeMath;
use drift::program::Velocity;
use drift::state::user::{User, UserStats};

pub fn manager_borrow<'info>(
    ctx: Context<'info, ManagerBorrow<'info>>,
    borrow_spot_market_index: u16,
    borrow_amount: u64,
) -> Result<()> {
    let mut vault = ctx.accounts.vault.load_mut()?;
    validate!(
        vault.is_trusted_vault_class(),
        ErrorCode::InvalidVaultClass,
        "Only trusted vaults can be borrowed from"
    )?;

    validate!(
        borrow_amount > 0,
        ErrorCode::InvalidBorrowAmount,
        "Borrow amount must be greater than 0"
    )?;

    let clock = &Clock::get()?;
    let now = clock.unix_timestamp;

    // backwards compatible: if last rem acct does not deserialize into [`VaultProtocol`] then it's a legacy vault.
    let mut vp = ctx.vault_protocol();
    vault.validate_vault_protocol(&vp)?;
    let vp = vp.as_mut().map(|vp| vp.load_mut()).transpose()?;

    let has_fee_update = FeeUpdateStatus::has_pending_fee_update(vault.fee_update_status);
    let fee_update = ctx.fee_update(vp.is_some(), has_fee_update);
    vault.validate_fee_update(&fee_update)?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = ctx.load_maps(
        clock.slot,
        Some(borrow_spot_market_index),
        vp.is_some(),
        has_fee_update,
    )?;

    let user = ctx.accounts.drift_user.load()?;

    // drift program will check validity

    let borrow_spot_market = spot_market_map.get_ref(&borrow_spot_market_index)?;
    let deposit_spot_market = spot_market_map.get_ref(&vault.spot_market_index)?;

    let drift_spot_market_vault = &ctx.accounts.drift_spot_market_vault;
    validate!(
        drift_spot_market_vault.mint == borrow_spot_market.mint,
        ErrorCode::InvalidVaultWithdraw,
        "drift_spot_market_vault needs to match borrow_spot_market_index"
    )?;

    let borrow_oracle = *oracle_map.get_price_data(&borrow_spot_market.oracle_id())?;
    let deposit_oracle = *oracle_map.get_price_data(&deposit_spot_market.oracle_id())?;

    let vault_equity =
        vault.calculate_equity(&user, &perp_market_map, &spot_market_map, &mut oracle_map)?;

    let borrow_value = token_a_to_token_b(
        borrow_amount,
        borrow_oracle.price,
        borrow_spot_market.decimals,
        deposit_oracle.price,
        deposit_spot_market.decimals,
    )?;
    let previous_borrow_value = vault.manager_borrowed_value;
    vault.manager_borrowed_value = vault.manager_borrowed_value.safe_add(borrow_value)?;

    drop(borrow_spot_market);
    drop(deposit_spot_market);
    drop(vault);
    drop(user);
    drop(vp);

    ctx.drift_withdraw(borrow_spot_market_index, borrow_amount)?;

    ctx.token_transfer(borrow_amount)?;

    let vault = ctx.accounts.vault.load_mut()?;
    let user = ctx.accounts.drift_user.load()?;
    let borrow_spot_market = spot_market_map.get_ref(&borrow_spot_market_index)?;
    let deposit_spot_market = spot_market_map.get_ref(&vault.spot_market_index)?;

    let vault_equity_after =
        vault.calculate_equity(&user, &perp_market_map, &spot_market_map, &mut oracle_map)?;

    emit!(ManagerBorrowRecord {
        ts: now,
        vault: vault.pubkey,
        manager: vault.manager,
        borrow_amount,
        borrow_value,
        borrow_spot_market_index: borrow_spot_market.market_index,
        borrow_oracle_price: borrow_oracle.price,
        deposit_spot_market_index: deposit_spot_market.market_index,
        deposit_oracle_price: deposit_oracle.price,
        vault_equity,
    });

    emit!(ManagerUpdateBorrowRecord {
        ts: now,
        vault: vault.pubkey,
        manager: vault.manager,
        previous_borrow_value,
        new_borrow_value: vault.manager_borrowed_value,
        vault_equity_before: vault_equity,
        vault_equity_after,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ManagerBorrow<'info> {
    #[account(
        mut,
        constraint = is_manager_for_vault(&vault, &manager)?,
    )]
    pub vault: AccountLoader<'info, Vault>,
    #[account(
        mut,
        token::authority = vault.key(),
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    pub manager: Signer<'info>,
    #[account(
        mut,
        constraint = is_user_stats_for_vault(&vault, &drift_user_stats.key())?
    )]
    /// CHECK: checked in drift cpi
    pub drift_user_stats: AccountLoader<'info, UserStats>,
    #[account(
        mut,
        constraint = is_user_for_vault(&vault, &drift_user.key())?
    )]
    /// CHECK: checked in drift cpi
    pub drift_user: AccountLoader<'info, User>,
    /// CHECK: checked in drift cpi
    pub drift_state: AccountInfo<'info>,
    #[account(
        mut,
        token::mint = vault_token_account.mint
    )]
    pub drift_spot_market_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked in drift cpi
    pub drift_signer: AccountInfo<'info>,
    #[account(
        mut,
        token::authority = manager,
        token::mint = vault_token_account.mint
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub drift_program: Program<'info, Velocity>,
    pub token_program: Program<'info, Token>,
}

impl<'info> ManagerBorrowCPI for Context<'info, ManagerBorrow<'info>> {
    fn drift_withdraw(&self, market_index: u16, amount: u64) -> Result<()> {
        declare_vault_seeds!(self.accounts.vault, seeds);

        let cpi_accounts = DriftWithdraw {
            state: self.accounts.drift_state.to_account_info().clone(),
            user: self.accounts.drift_user.to_account_info().clone(),
            user_stats: self.accounts.drift_user_stats.to_account_info().clone(),
            authority: self.accounts.vault.to_account_info().clone(),
            spot_market_vault: self
                .accounts
                .drift_spot_market_vault
                .to_account_info()
                .clone(),
            velocity_signer: self.accounts.drift_signer.to_account_info().clone(),
            user_token_account: self.accounts.vault_token_account.to_account_info().clone(),
            token_program: self.accounts.token_program.to_account_info().clone(),
        };

        let drift_program = self.accounts.drift_program.key();
        let cpi_context = CpiContext::new_with_signer(drift_program, cpi_accounts, seeds)
            .with_remaining_accounts(self.remaining_accounts.into());
        drift::cpi::withdraw(cpi_context, market_index, amount, false)?;

        Ok(())
    }
}

impl<'info> TokenTransferCPI for Context<'info, ManagerBorrow<'info>> {
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
