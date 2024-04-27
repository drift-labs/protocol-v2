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
    rent: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    archive_program: AccountInfo<'info>,
) -> Result<()> {
    let cpi_accounts = ArchiveUser {
        drift_user: user,
        payer,
        archived_user,
        rent,
        system_program,
    };
    let cpi_context = CpiContext::new(archive_program, cpi_accounts);

    drift_archive::cpi::archive_user(cpi_context, authority, sub_account_id)
}

pub fn unarchive<'info>(
    authority: Pubkey,
    sub_account_id: u16,
    payer: AccountInfo<'info>,
    archived_user: AccountInfo<'info>,
    archive_program: AccountInfo<'info>,
) -> Result<()> {
    let cpi_accounts = UnarchiveUser {
        payer,
        archived_user,
    };
    let cpi_context = CpiContext::new(archive_program, cpi_accounts);

    drift_archive::cpi::unarchive_user(cpi_context, authority, sub_account_id)
}
