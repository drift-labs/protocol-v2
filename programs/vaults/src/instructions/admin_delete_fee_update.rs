use anchor_lang::prelude::*;

use crate::constraints::is_admin;
use crate::state::events::{FeeUpdateAction, FeeUpdateRecord};
use crate::state::{FeeUpdate, FeeUpdateStatus, Vault};

pub fn admin_delete_fee_update<'info>(
    ctx: Context<'info, AdminDeleteFeeUpdate<'info>>,
) -> Result<()> {
    let mut vault = ctx.accounts.vault.load_mut()?;

    if vault.fee_update_status == FeeUpdateStatus::PendingFeeUpdate as u8 {
        let now = Clock::get()?.unix_timestamp;
        emit!(FeeUpdateRecord {
            ts: now,
            action: FeeUpdateAction::Cancelled,
            timelock_end_ts: now,
            vault: vault.pubkey,
            old_management_fee: vault.management_fee,
            old_profit_share: vault.profit_share,
            old_hurdle_rate: vault.hurdle_rate,
            new_management_fee: vault.management_fee,
            new_profit_share: vault.profit_share,
            new_hurdle_rate: vault.hurdle_rate,
        });
    }

    vault.fee_update_status = FeeUpdateStatus::None as u8;

    Ok(())
}

#[derive(Accounts)]
pub struct AdminDeleteFeeUpdate<'info> {
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    #[account(
        mut,
        constraint = is_admin(&admin)?,
    )]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"fee_update".as_ref(), vault.key().as_ref()],
        bump,
        close = admin,
    )]
    pub fee_update: AccountLoader<'info, FeeUpdate>,
}
