use crate::{error::ErrorCode, validate};
use anchor_lang::prelude::*;

use super::UpdateVault;

pub fn update_vault_manager<'info>(
    ctx: Context<'info, UpdateVault<'info>>,
    manager: Pubkey,
) -> Result<()> {
    let mut vault = ctx.accounts.vault.load_mut()?;

    validate!(
        manager != vault.manager,
        ErrorCode::InvalidVaultUpdate,
        "Vault manager cannot be updated to the same manager"
    )?;

    validate!(
        manager != vault.pubkey,
        ErrorCode::InvalidVaultUpdate,
        "Vault manager cannot be updated to the vault"
    )?;

    validate!(
        manager != Pubkey::default(),
        ErrorCode::InvalidVaultUpdate,
        "Vault cannot be managerless"
    )?;

    msg!("Updating vault manager {} -> {}", vault.manager, manager);
    vault.manager = manager;

    Ok(())
}
