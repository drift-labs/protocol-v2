use anchor_lang::prelude::*;
use velocity::instructions::optional_accounts::AccountMaps;
use velocity::math::safe_math::SafeMath;
use velocity::state::user::User;

use crate::constraints::{
    is_authority_for_vault_depositor, is_user_for_vault, is_vault_for_vault_depositor,
};
use crate::error::ErrorCode;
use crate::state::traits::VaultDepositorBase;
use crate::{validate, AccountMapProvider};
use crate::{Vault, VaultDepositor, VaultProtocolProvider, WithdrawUnit};

pub fn transfer_vault_depositor_shares<'info>(
    ctx: Context<'info, TransferVaultDepositorShares<'info>>,
    amount: u64,
    withdraw_unit: WithdrawUnit,
) -> Result<()> {
    let clock = &Clock::get()?;

    let mut vault = ctx.accounts.vault.load_mut()?;

    validate!(!vault.in_liquidation(), ErrorCode::OngoingLiquidation)?;

    validate!(
        ctx.accounts.vault_depositor.key() != ctx.accounts.to_vault_depositor.key(),
        ErrorCode::InvalidVaultDeposit,
        "Cannot transfer shares to the same depositor"
    )?;

    validate!(
        amount > 0,
        ErrorCode::InvalidVaultWithdrawSize,
        "Transfer amount must be greater than 0"
    )?;

    let mut vault_depositor = ctx.accounts.vault_depositor.load_mut()?;
    let mut to_vault_depositor = ctx.accounts.to_vault_depositor.load_mut()?;

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

    validate!(
        !vault_depositor.last_withdraw_request.pending(),
        ErrorCode::InvalidVaultDeposit,
        "Cannot transfer shares with a pending withdraw request"
    )?;

    validate!(
        !to_vault_depositor.last_withdraw_request.pending(),
        ErrorCode::InvalidVaultDeposit,
        "Cannot transfer shares to a depositor with a pending withdraw request"
    )?;

    let spot_market = spot_market_map.get_ref(&spot_market_index)?;
    let oracle = oracle_map.get_price_data(&spot_market.oracle_id())?;

    let total_shares_before = vault_depositor
        .get_vault_shares()
        .safe_add(to_vault_depositor.get_vault_shares())?;

    vault_depositor.transfer_shares(
        &mut *to_vault_depositor,
        &mut vault,
        &mut vp,
        &mut None,
        amount,
        withdraw_unit,
        vault_equity,
        clock.unix_timestamp,
        oracle.price,
    )?;

    let total_shares_after = vault_depositor
        .get_vault_shares()
        .safe_add(to_vault_depositor.get_vault_shares())?;

    validate!(
        total_shares_after.eq(&total_shares_before),
        ErrorCode::InvalidVaultSharesDetected,
        "Total vault depositor shares before != after"
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct TransferVaultDepositorShares<'info> {
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    #[account(
        mut,
        seeds = [b"vault_depositor", vault.key().as_ref(), authority.key().as_ref()],
        bump,
        constraint = is_authority_for_vault_depositor(&vault_depositor, &authority)?,
    )]
    pub vault_depositor: AccountLoader<'info, VaultDepositor>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = is_vault_for_vault_depositor(&to_vault_depositor, &vault)?,
    )]
    pub to_vault_depositor: AccountLoader<'info, VaultDepositor>,
    #[account(
        constraint = is_user_for_vault(&vault, &velocity_user.key())?
    )]
    pub velocity_user: AccountLoader<'info, User>,
}
