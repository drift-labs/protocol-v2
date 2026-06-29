use anchor_lang::prelude::*;
use velocity::instructions::optional_accounts::AccountMaps;
use velocity::state::user::User;

use crate::constraints::{
    is_protocol_for_vault, is_user_for_vault, is_user_stats_for_vault, is_vault_protocol_for_vault,
};
use crate::{AccountMapProvider, Vault, VaultProtocol, WithdrawUnit};

pub fn protocol_request_withdraw<'info>(
    ctx: Context<'info, ProtocolRequestWithdraw<'info>>,
    withdraw_amount: u64,
    withdraw_unit: WithdrawUnit,
) -> Result<()> {
    let clock = &Clock::get()?;
    let mut vault = ctx.accounts.vault.load_mut()?;
    let now = clock.unix_timestamp;

    // backwards compatible: if last rem acct does not deserialize into [`VaultProtocol`] then it's a legacy vault.
    let mut vp = Some(ctx.accounts.vault_protocol.load_mut()?);

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

    vault.protocol_request_withdraw(
        &mut vp,
        &mut None,
        withdraw_amount,
        withdraw_unit,
        vault_equity,
        now,
        oracle.price,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct ProtocolRequestWithdraw<'info> {
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
        constraint = is_user_stats_for_vault(&vault, &velocity_user_stats.key())?
    )]
    /// CHECK: unused, for future proofing
    pub velocity_user_stats: AccountInfo<'info>,
    #[account(
        constraint = is_user_for_vault(&vault, &velocity_user.key())?
    )]
    pub velocity_user: AccountLoader<'info, User>,
}
