use crate::signer::get_signer_seeds;
use anchor_lang::prelude::*;
use drift_archive::cpi::accounts::{ArchiveUser, UnarchiveUser};
use solana_program::account_info::AccountInfo;
use solana_program::pubkey::Pubkey;

pub fn archive<'info>(
    authority: Pubkey,
    sub_account_id: u16,
    user: AccountInfo<'info>,
    payer: AccountInfo<'info>,
    archived_user: AccountInfo<'info>,
    drift_signer: AccountInfo<'info>,
    nonce: u8,
    rent: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    archive_program: AccountInfo<'info>,
) -> Result<()> {
    let signature_seeds = get_signer_seeds(&nonce);
    let signers = &[&signature_seeds[..]];
    let cpi_accounts = ArchiveUser {
        drift_user: user,
        payer,
        archived_user,
        rent,
        system_program,
        drift_signer,
    };
    let cpi_context = CpiContext::new_with_signer(archive_program, cpi_accounts, signers);

    drift_archive::cpi::archive_user(cpi_context, authority, sub_account_id)
}

pub fn unarchive<'info>(
    authority: Pubkey,
    sub_account_id: u16,
    payer: AccountInfo<'info>,
    archived_user: AccountInfo<'info>,
    drift_signer: AccountInfo<'info>,
    nonce: u8,
    archive_program: AccountInfo<'info>,
) -> Result<()> {
    let signature_seeds = get_signer_seeds(&nonce);
    let signers = &[&signature_seeds[..]];
    let cpi_accounts = UnarchiveUser {
        payer,
        archived_user,
        drift_signer,
    };
    let cpi_context = CpiContext::new_with_signer(archive_program, cpi_accounts, signers);

    drift_archive::cpi::unarchive_user(cpi_context, authority, sub_account_id)
}
