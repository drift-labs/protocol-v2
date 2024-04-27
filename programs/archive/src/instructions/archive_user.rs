use anchor_lang::prelude::*;

use crate::drift_signer;
use crate::state::ArchivedUser;
use arrayref::array_ref;

pub fn archive_user<'info>(
    ctx: Context<'_, '_, '_, 'info, ArchiveUser<'info>>,
    _authority: Pubkey,
    _sub_account_id: u16,
) -> Result<()> {
    let archived_user = &mut ctx.accounts.archived_user.load_init()?;
    let account_info_data = ctx.accounts.drift_user.try_borrow_data()?;
    let data = array_ref![account_info_data, 8, 4368];

    for i in 0..data.len() {
        archived_user.data[i] = data[i];
    }

    Ok(())
}

#[derive(Accounts)]
#[instruction(authority: Pubkey, sub_account_id: u16, )]
pub struct ArchiveUser<'info> {
    /// CHECK: do s.t.
    pub drift_user: AccountInfo<'info>,
    #[account(mut)]
    payer: Signer<'info>,
    #[account(
        address = drift_signer::id()
    )]
    pub drift_signer: Signer<'info>,
    #[account(
        init,
        seeds = [b"user",  authority.as_ref(), sub_account_id.to_le_bytes().as_ref()],
        space = ArchivedUser::SIZE,
        bump,
        payer = payer
    )]
    pub archived_user: AccountLoader<'info, ArchivedUser>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}
