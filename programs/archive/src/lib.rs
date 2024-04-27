mod instructions;
mod state;

use anchor_lang::prelude::*;
use instructions::*;

declare_id!("4Vivs8x3dKt6PUsPpSJKDU3Gc6Y3MDc3J4GNm2LpxDz6");

pub mod drift_signer {
    use solana_program::declare_id;
    declare_id!("JCNCMFXo5M5qwUPg2Utu1u6YWp3MbygxqBsBeXXJfrw");
}

#[program]
pub mod drift_archive {
    use super::*;

    pub fn archive_user<'info>(
        ctx: Context<'_, '_, '_, 'info, ArchiveUser<'info>>,
        authority: Pubkey,
        sub_account_id: u16,
    ) -> Result<()> {
        instructions::archive_user(ctx, authority, sub_account_id)
    }

    pub fn unarchive_user<'info>(
        ctx: Context<'_, '_, '_, 'info, UnarchiveUser<'info>>,
        authority: Pubkey,
        sub_account_id: u16,
    ) -> Result<()> {
        instructions::unarchive_user(ctx, authority, sub_account_id)
    }
}
