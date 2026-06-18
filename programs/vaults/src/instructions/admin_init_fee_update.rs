use anchor_lang::prelude::*;

use crate::constraints::is_admin;
use crate::state::traits::Size;
use crate::state::{FeeUpdate, FeeUpdateStatus, Vault};
use crate::{error::ErrorCode, validate};

pub fn admin_init_fee_update<'info>(ctx: Context<'info, AdminInitFeeUpdate<'info>>) -> Result<()> {
    let vault = ctx.accounts.vault.load_mut()?;
    let mut fee_update = ctx.accounts.fee_update.load_init()?;

    validate!(!vault.in_liquidation(), ErrorCode::OngoingLiquidation)?;
    validate!(
        vault.fee_update_status == FeeUpdateStatus::None as u8,
        ErrorCode::InvalidVaultUpdate,
        "vault already has a FeeUpdate account"
    )?;

    fee_update.reset();

    Ok(())
}

#[derive(Accounts)]
pub struct AdminInitFeeUpdate<'info> {
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    #[account(
        mut,
        constraint = is_admin(&admin)?,
    )]
    pub admin: Signer<'info>,
    #[account(
        init,
        seeds = [b"fee_update".as_ref(), vault.key().as_ref()],
        bump,
        payer = admin,
        space = FeeUpdate::SIZE,
    )]
    pub fee_update: AccountLoader<'info, FeeUpdate>,
    pub system_program: Program<'info, System>,
}
