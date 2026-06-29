use anchor_lang::prelude::*;
use velocity::instructions::optional_accounts::AccountMaps;
use velocity::math::casting::Cast;
use velocity::state::user::User;

use crate::constraints::{
    is_protocol_for_vault, is_user_for_vault, is_user_stats_for_vault, is_vault_protocol_for_vault,
};
use crate::{AccountMapProvider, Vault, VaultProtocol};

pub fn protocol_cancel_withdraw_request<'info>(
    ctx: Context<'info, ProtocolCancelWithdrawRequest<'info>>,
) -> Result<()> {
    let clock = &Clock::get()?;
    let vault = &mut ctx.accounts.vault.load_mut()?;

    let mut vp = Some(ctx.accounts.vault_protocol.load_mut()?);

    let user = ctx.accounts.velocity_user.load()?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = ctx.load_maps(clock.slot, None, vp.is_some(), false)?;

    let vault_equity =
        vault.calculate_equity(&user, &perp_market_map, &spot_market_map, &mut oracle_map)?;

    let spot_market = spot_market_map.get_ref(&vault.spot_market_index)?;
    let oracle = oracle_map.get_price_data(&spot_market.oracle_id())?;

    vault.protocol_cancel_withdraw_request(
        &mut vp,
        &mut None,
        vault_equity.cast()?,
        clock.unix_timestamp,
        oracle.price,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct ProtocolCancelWithdrawRequest<'info> {
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
