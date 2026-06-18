use crate::constraints::is_manager_for_vault;
use crate::state::events::{FeeUpdateAction, FeeUpdateRecord};
use crate::state::{FeeUpdate, FeeUpdateStatus};
use crate::{error::ErrorCode, validate, Vault};
use anchor_lang::prelude::*;

pub fn manager_cancel_fee_update<'info>(
    ctx: Context<'info, ManagerCancelFeeUpdate<'info>>,
) -> Result<()> {
    let mut vault = ctx.accounts.vault.load_mut()?;
    let mut fee_update = ctx.accounts.fee_update.load_mut()?;

    validate!(
        FeeUpdateStatus::has_pending_fee_update(vault.fee_update_status) && fee_update.is_pending(),
        ErrorCode::InvalidFeeUpdateStatus,
        "No pending fee update to cancel"
    )?;

    let now = Clock::get()?.unix_timestamp;

    emit!(FeeUpdateRecord {
        ts: now,
        action: FeeUpdateAction::Cancelled,
        timelock_end_ts: fee_update.incoming_update_ts,
        vault: vault.pubkey,
        old_management_fee: vault.management_fee,
        old_profit_share: vault.profit_share,
        old_hurdle_rate: vault.hurdle_rate,
        new_management_fee: fee_update.incoming_management_fee,
        new_profit_share: fee_update.incoming_profit_share,
        new_hurdle_rate: fee_update.incoming_hurdle_rate,
    });

    fee_update.reset();
    vault.fee_update_status = FeeUpdateStatus::None as u8;

    Ok(())
}

#[derive(Accounts)]
pub struct ManagerCancelFeeUpdate<'info> {
    #[account(
        mut,
        constraint = is_manager_for_vault(&vault, &manager)?,
    )]
    pub vault: AccountLoader<'info, Vault>,
    pub manager: Signer<'info>,
    #[account(
        mut,
        seeds = [b"fee_update".as_ref(), vault.key().as_ref()],
        bump,
    )]
    pub fee_update: AccountLoader<'info, FeeUpdate>,
}
