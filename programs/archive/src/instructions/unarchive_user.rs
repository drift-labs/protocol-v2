use anchor_lang::prelude::*;

use crate::drift_signer;
use crate::state::ArchivedUser;

pub fn unarchive_user<'info>(
    _ctx: Context<'_, '_, '_, 'info, UnarchiveUser<'info>>,
    _authority: Pubkey,
    _sub_account_id: u16,
) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
#[instruction(authority: Pubkey, sub_account_id: u16, )]
pub struct UnarchiveUser<'info> {
    #[account(mut)]
    payer: Signer<'info>,
    #[account(
        address = drift_signer::id()
    )]
    pub drift_signer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"user",  authority.as_ref(), sub_account_id.to_le_bytes().as_ref()],
        bump,
        close = payer,
    )]
    pub archived_user: AccountLoader<'info, ArchivedUser>,
}
