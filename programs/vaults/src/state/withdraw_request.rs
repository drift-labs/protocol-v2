use crate::error::ErrorCode;
use crate::error::VaultResult;
use crate::{validate, Vault};
use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use bytemuck::Zeroable;
use drift::math::insurance::{
    if_shares_to_vault_amount as depositor_shares_to_vault_amount,
    vault_amount_to_if_shares as vault_amount_to_depositor_shares,
};
use drift::math::safe_math::SafeMath;
use drift_macros::assert_no_slop;
use solana_program::msg;
use static_assertions::const_assert_eq;

#[assert_no_slop]
#[derive(
    Default, AnchorSerialize, AnchorDeserialize, Copy, Clone, Eq, PartialEq, Debug, Zeroable,
)]
#[repr(C)]
pub struct WithdrawRequest {
    /// request shares of vault withdraw
    pub shares: u128,
    /// requested value (in vault spot_market_index) of shares for withdraw
    pub value: u64,
    /// request ts of vault withdraw
    pub ts: i64,
}

impl WithdrawRequest {
    pub fn pending(&self) -> bool {
        self.shares != 0 || self.value != 0
    }

    pub fn rebase(&mut self, rebase_divisor: u128) -> VaultResult {
        self.shares = self.shares.safe_div(rebase_divisor)?;
        Ok(())
    }

    pub fn calculate_shares_lost(&self, vault: &Vault, vault_equity: u64) -> VaultResult<u128> {
        let n_shares = self.shares;

        let amount = depositor_shares_to_vault_amount(n_shares, vault.total_shares, vault_equity)?;

        let vault_shares_lost = if amount > self.value {
            let new_n_shares = vault_amount_to_depositor_shares(
                self.value,
                vault.total_shares.safe_sub(n_shares)?,
                vault_equity.safe_sub(self.value)?,
            )?;

            validate!(
                new_n_shares <= n_shares,
                ErrorCode::InvalidVaultSharesDetected,
                "Issue calculating delta if_shares after canceling request {} < {}",
                new_n_shares,
                n_shares
            )?;

            n_shares.safe_sub(new_n_shares)?
        } else {
            0
        };

        Ok(vault_shares_lost)
    }

    pub fn set(
        &mut self,
        current_shares: u128,
        withdraw_shares: u128,
        withdraw_value: u64,
        vault_equity: u64,
        now: i64,
    ) -> VaultResult {
        validate!(
            self.value == 0,
            ErrorCode::VaultWithdrawRequestInProgress,
            "withdraw request is already in progress"
        )?;

        validate!(
            withdraw_shares <= current_shares,
            ErrorCode::InvalidVaultWithdrawSize,
            "shares requested exceeds vault_shares {} > {}",
            withdraw_shares,
            current_shares
        )?;

        self.shares = withdraw_shares;

        validate!(
            withdraw_value == 0 || withdraw_value <= vault_equity,
            ErrorCode::InvalidVaultWithdrawSize,
            "Requested withdraw value {} is not equal or below vault_equity {}",
            withdraw_value,
            vault_equity
        )?;

        self.value = withdraw_value;

        self.ts = now;

        Ok(())
    }

    pub fn reset(&mut self, now: i64) -> VaultResult {
        // reset vault_depositor withdraw request info
        self.shares = 0;
        self.value = 0;
        self.ts = now;

        Ok(())
    }

    pub fn check_redeem_period_finished(&self, vault: &Vault, now: i64) -> VaultResult {
        let time_since_withdraw_request = now.safe_sub(self.ts)?;

        validate!(
            time_since_withdraw_request >= vault.redeem_period,
            ErrorCode::CannotWithdrawBeforeRedeemPeriodEnd
        )?;

        Ok(())
    }
}
