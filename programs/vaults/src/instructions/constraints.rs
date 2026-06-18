use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use velocity::state::insurance_fund_stake::InsuranceFundStake;

use crate::constants::admin;
use crate::state::VaultProtocol;
use crate::{TokenizedVaultDepositor, Vault, VaultDepositor};

pub fn is_vault_for_vault_depositor(
    vault_depositor: &AccountLoader<VaultDepositor>,
    vault: &AccountLoader<Vault>,
) -> Result<bool> {
    Ok(vault_depositor.load()?.vault.eq(&vault.key()))
}

pub fn is_authority_for_vault_depositor(
    vault_depositor: &AccountLoader<VaultDepositor>,
    signer: &Signer,
) -> Result<bool> {
    Ok(vault_depositor.load()?.authority.eq(signer.key))
}

pub fn is_authority_key_for_vault_depositor(
    vault_depositor: &AccountLoader<VaultDepositor>,
    authority_key: &Pubkey,
) -> Result<bool> {
    Ok(vault_depositor.load()?.authority.eq(authority_key))
}

pub fn is_manager_for_vault(vault: &AccountLoader<Vault>, signer: &Signer) -> Result<bool> {
    Ok(vault.load()?.manager.eq(signer.key))
}

pub fn is_admin(signer: &Signer) -> Result<bool> {
    Ok(signer.key.eq(&admin::ID))
}

pub fn is_protocol_for_vault(
    vault: &AccountLoader<Vault>,
    vault_protocol: &AccountLoader<VaultProtocol>,
    signer: &Signer,
) -> Result<bool> {
    let vault_ref = vault.load()?;
    let vp_key = vault_protocol.key();
    if vault_ref.vault_protocol {
        let (expected, _) =
            Pubkey::find_program_address(&[b"vault_protocol", vault.key().as_ref()], &crate::id());
        Ok(vp_key.eq(&expected) && vault_protocol.load()?.protocol.eq(signer.key))
    } else {
        // Vault does not have VaultProtocol, but rem accts provided one
        let ec = crate::error::ErrorCode::VaultProtocolMissing;
        msg!("Error {} thrown at {}:{}", ec, file!(), line!());
        msg!("Vault does not have VaultProtocol");
        Err(anchor_lang::error::Error::from(ec))
    }
}

pub fn is_delegate_for_vault(vault: &AccountLoader<Vault>, signer: &Signer) -> Result<bool> {
    Ok(vault.load()?.delegate.eq(signer.key))
}

pub fn is_user_for_vault(vault: &AccountLoader<Vault>, user_key: &Pubkey) -> Result<bool> {
    Ok(vault.load()?.user.eq(user_key))
}

pub fn is_user_stats_for_vault(vault: &AccountLoader<Vault>, user_stats: &Pubkey) -> Result<bool> {
    Ok(vault.load()?.user_stats.eq(user_stats))
}

pub fn is_vault_protocol_for_vault(
    vault_protocol: &AccountLoader<VaultProtocol>,
    vault: &AccountLoader<Vault>,
) -> Result<bool> {
    let vault_ref = vault.load()?;
    let vp_key = vault_protocol.key();
    if vault_ref.vault_protocol {
        let (expected, _) =
            Pubkey::find_program_address(&[b"vault_protocol", vault.key().as_ref()], &crate::id());
        Ok(vp_key.eq(&expected))
    } else {
        // Vault does not have VaultProtocol, but rem accts provided one
        let ec = crate::error::ErrorCode::VaultProtocolMissing;
        msg!("Error {} thrown at {}:{}", ec, file!(), line!());
        msg!("Vault does not have VaultProtocol");
        Err(anchor_lang::error::Error::from(ec))
    }
}

pub fn is_tokenized_depositor_for_vault(
    tokenized_vault_depositor: &AccountLoader<TokenizedVaultDepositor>,
    vault: &AccountLoader<Vault>,
) -> anchor_lang::Result<bool> {
    Ok(tokenized_vault_depositor.load()?.vault.eq(&vault.key()))
}

pub fn is_mint_for_tokenized_depositor(
    mint: &Pubkey,
    tokenized_vault_depositor: &AccountLoader<TokenizedVaultDepositor>,
) -> anchor_lang::Result<bool> {
    Ok(tokenized_vault_depositor.load()?.mint.eq(mint))
}

pub fn is_vault_shares_base_for_tokenized_depositor(
    vault_shares_base: &u32,
    tokenized_vault_depositor: &AccountLoader<TokenizedVaultDepositor>,
) -> anchor_lang::Result<bool> {
    Ok(tokenized_vault_depositor
        .load()?
        .vault_shares_base
        .eq(vault_shares_base))
}

pub fn is_ata(token_account: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> anchor_lang::Result<bool> {
    Ok(get_associated_token_address(owner, mint).eq(token_account))
}

pub fn is_if_stake_for_vault(
    if_stake: &AccountLoader<InsuranceFundStake>,
    vault: &AccountLoader<Vault>,
) -> Result<bool> {
    Ok(if_stake.load()?.authority.eq(&vault.key()))
}
