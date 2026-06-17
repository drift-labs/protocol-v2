use crate::error::{ErrorCode, VaultResult};
use crate::validate;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::msg;

use drift::math::casting::Cast;
use drift::math::safe_math::SafeMath;

use drift::math::insurance::{
    if_shares_to_vault_amount as depositor_shares_to_vault_amount,
    vault_amount_to_if_shares as vault_amount_to_depositor_shares,
};

#[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub enum WithdrawUnit {
    Shares,
    Token,
    SharesPercent,
}

const MAX_WITHDRAW_PERCENT: u128 = 1_000_000;
impl WithdrawUnit {
    pub fn get_withdraw_value_and_shares(
        &self,
        withdraw_amount: u64,
        vault_equity: u64,
        shares: u128,
        total_shares: u128,
        rebase_divisor: Option<u128>,
    ) -> VaultResult<(u64, u128)> {
        match self {
            WithdrawUnit::Token => {
                let withdraw_value = withdraw_amount;
                let n_shares: u128 =
                    vault_amount_to_depositor_shares(withdraw_value, total_shares, vault_equity)?;
                Ok((withdraw_value, n_shares))
            }
            WithdrawUnit::Shares => {
                let mut n_shares = withdraw_amount.cast::<u128>()?;
                if let Some(rebase_divisor) = rebase_divisor {
                    n_shares = n_shares.safe_div(rebase_divisor)?;
                }
                let withdraw_value =
                    depositor_shares_to_vault_amount(n_shares, total_shares, vault_equity)?
                        .min(vault_equity);
                Ok((withdraw_value, n_shares))
            }
            WithdrawUnit::SharesPercent => {
                let n_shares =
                    WithdrawUnit::get_shares_from_percent(withdraw_amount.cast()?, shares)?;
                let withdraw_value: u64 =
                    depositor_shares_to_vault_amount(n_shares, total_shares, vault_equity)?
                        .min(vault_equity);
                Ok((withdraw_value, n_shares))
            }
        }
    }

    fn get_shares_from_percent(percent: u128, shares: u128) -> VaultResult<u128> {
        validate!(
            percent <= MAX_WITHDRAW_PERCENT,
            ErrorCode::SharesPercentTooLarge
        )?;
        let shares = shares.safe_mul(percent)?.safe_div(MAX_WITHDRAW_PERCENT)?;
        Ok(shares)
    }
}
