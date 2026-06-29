use anchor_lang::prelude::*;
use velocity::instructions::optional_accounts::AccountMaps;
use velocity::state::user::User;

use crate::constraints::{is_tokenized_depositor_for_vault, is_user_for_vault};
use crate::state::traits::VaultDepositorBase;
use crate::{AccountMapProvider, TokenizedVaultDepositor, Vault, VaultProtocolProvider};

pub fn apply_rebase_tokenized_depositor<'info>(
    ctx: Context<'info, ApplyRebaseTokenizedDepositor<'info>>,
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

    ctx.accounts
        .tokenized_vault_depositor
        .load_mut()?
        .apply_rebase(&mut vault, &mut vp, vault_equity)?;

    Ok(())
}

#[derive(Accounts)]
pub struct ApplyRebaseTokenizedDepositor<'info> {
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    #[account(
        mut,
        constraint = is_tokenized_depositor_for_vault(&tokenized_vault_depositor, &vault)?
    )]
    pub tokenized_vault_depositor: AccountLoader<'info, TokenizedVaultDepositor>,
    #[account(
        mut,
        constraint = is_user_for_vault(&vault, &velocity_user.key())?
    )]
    pub velocity_user: AccountLoader<'info, User>,
}
