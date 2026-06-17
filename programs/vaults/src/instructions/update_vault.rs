use crate::constraints::is_manager_for_vault;
use crate::state::events::{FeeUpdateAction, FeeUpdateRecord};
use crate::{error::ErrorCode, validate, Vault};
use anchor_lang::prelude::*;

pub fn update_vault<'info>(
    ctx: Context<'info, UpdateVault<'info>>,
    params: UpdateVaultParams,
) -> Result<()> {
    let mut vault = ctx.accounts.vault.load_mut()?;

    validate!(!vault.in_liquidation(), ErrorCode::OngoingLiquidation)?;

    if let Some(redeem_period) = params.redeem_period {
        validate!(
            redeem_period < vault.redeem_period,
            ErrorCode::InvalidVaultUpdate,
            "new redeem period must be shorter than existing redeem period"
        )?;
        vault.redeem_period = redeem_period;
    }

    if let Some(max_tokens) = params.max_tokens {
        vault.max_tokens = max_tokens;
    }

    if let Some(min_deposit_amount) = params.min_deposit_amount {
        vault.min_deposit_amount = min_deposit_amount;
    }

    let mut fee_updated = false;
    let old_management_fee = vault.management_fee;
    let old_profit_share = vault.profit_share;
    let old_hurdle_rate = vault.hurdle_rate;

    if let Some(management_fee) = params.management_fee {
        validate!(
            management_fee < vault.management_fee,
            ErrorCode::InvalidVaultUpdate,
            "new management fee must be lower than existing management fee, use manager_update_fees ix to raise fee with a timelock"
        )?;
        vault.management_fee = management_fee;
        fee_updated = true;
    }

    if let Some(profit_share) = params.profit_share {
        validate!(
            profit_share < vault.profit_share,
            ErrorCode::InvalidVaultUpdate,
            "new profit share must be lower than existing profit share, use manager_update_fees ix to raise share with a timelock"
        )?;
        vault.profit_share = profit_share;
        fee_updated = true;
    }

    if let Some(hurdle_rate) = params.hurdle_rate {
        validate!(
            hurdle_rate > vault.hurdle_rate,
            ErrorCode::InvalidVaultUpdate,
            "new hurdle rate must be greater than existing hurdle rate, use manager_update_fees ix to lower hurdle rate with a timelock"
        )?;
        vault.hurdle_rate = hurdle_rate;
        fee_updated = true;
    }

    if let Some(permissioned) = params.permissioned {
        vault.permissioned = permissioned;
    }

    if fee_updated {
        let now = Clock::get()?.unix_timestamp;
        emit!(FeeUpdateRecord {
            ts: now,
            action: FeeUpdateAction::Applied,
            timelock_end_ts: now,
            vault: ctx.accounts.vault.key(),
            old_management_fee,
            old_profit_share,
            old_hurdle_rate,
            new_management_fee: vault.management_fee,
            new_profit_share: vault.profit_share,
            new_hurdle_rate: vault.hurdle_rate,
        });
    }

    drop(vault);

    Ok(())
}

#[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub struct UpdateVaultParams {
    pub redeem_period: Option<i64>,
    pub max_tokens: Option<u64>,
    pub management_fee: Option<i64>,
    pub min_deposit_amount: Option<u64>,
    pub profit_share: Option<u32>,
    pub hurdle_rate: Option<u32>,
    pub permissioned: Option<bool>,
}

#[derive(Accounts)]
pub struct UpdateVault<'info> {
    #[account(
        mut,
        constraint = is_manager_for_vault(&vault, &manager)?,
    )]
    pub vault: AccountLoader<'info, Vault>,
    pub manager: Signer<'info>,
}
