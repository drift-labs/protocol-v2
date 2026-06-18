use anchor_lang::prelude::*;

use crate::constraints::{is_protocol_for_vault, is_vault_protocol_for_vault};
use crate::state::{Vault, VaultProtocol};
use crate::{error::ErrorCode, validate};

pub fn update_vault_protocol<'info>(
    ctx: Context<'info, UpdateVaultProtocol<'info>>,
    params: UpdateVaultProtocolParams,
) -> Result<()> {
    let vault = ctx.accounts.vault.load_mut()?;

    // backwards compatible: if last rem acct does not deserialize into [`VaultProtocol`] then it's a legacy vault.
    let vp = Some(ctx.accounts.vault_protocol.load_mut()?);

    validate!(!vault.in_liquidation(), ErrorCode::OngoingLiquidation)?;

    if let Some(mut vp) = vp {
        if let Some(new_protocol_fee) = params.protocol_fee {
            validate!(
                new_protocol_fee < vp.protocol_fee,
                ErrorCode::InvalidVaultUpdate,
                "new protocol fee must be less than existing protocol fee"
            )?;
            vp.protocol_fee = new_protocol_fee;
        }

        if let Some(new_protocol_profit_share) = params.protocol_profit_share {
            validate!(
                new_protocol_profit_share < vp.protocol_profit_share,
                ErrorCode::InvalidVaultUpdate,
                "new protocol profit share must be less than existing protocol profit share"
            )?;
            vp.protocol_profit_share = new_protocol_profit_share;
        }
    }

    drop(vault);

    Ok(())
}

#[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub struct UpdateVaultProtocolParams {
    pub protocol_fee: Option<u64>,
    pub protocol_profit_share: Option<u32>,
}

#[derive(Accounts)]
pub struct UpdateVaultProtocol<'info> {
    #[account(
        mut,
        constraint = is_protocol_for_vault(&vault, &vault_protocol, &protocol)?
    )]
    pub vault: AccountLoader<'info, Vault>,
    pub protocol: Signer<'info>,
    #[account(
        mut,
        constraint = is_vault_protocol_for_vault(&vault_protocol, &vault)?
    )]
    pub vault_protocol: AccountLoader<'info, VaultProtocol>,
}
