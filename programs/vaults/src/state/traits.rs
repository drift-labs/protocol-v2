use std::cell::RefMut;

use crate::error::ErrorCode;
use crate::events::{
    ShareTransferRecord, VaultDepositorAction, VaultDepositorRecord, VaultDepositorV1Record,
};
use crate::state::vault::Vault;
use crate::{validate, FeeUpdate, VaultFee, VaultProtocol, WithdrawUnit};
use anchor_lang::prelude::*;

use drift::math::casting::Cast;
use drift::math::constants::{PERCENTAGE_PRECISION, PERCENTAGE_PRECISION_I64};
use drift::math::insurance::{
    if_shares_to_vault_amount as depositor_shares_to_vault_amount,
    vault_amount_to_if_shares as vault_amount_to_depositor_shares,
};
use drift::math::safe_math::SafeMath;

pub trait Size {
    const SIZE: usize;
}

pub trait VaultDepositorBase {
    fn get_authority(&self) -> Pubkey;
    fn get_pubkey(&self) -> Pubkey;

    fn get_vault_shares(&self) -> u128;
    fn set_vault_shares(&mut self, shares: u128);

    fn get_vault_shares_base(&self) -> u32;
    fn set_vault_shares_base(&mut self, base: u32);

    fn get_net_deposits(&self) -> i64;
    fn set_net_deposits(&mut self, amount: i64);

    fn get_cumulative_profit_share_amount(&self) -> i64;
    fn set_cumulative_profit_share_amount(&mut self, amount: i64);

    fn get_profit_share_fee_paid(&self) -> u64;
    fn set_profit_share_fee_paid(&mut self, amount: u64);

    fn validate_base(&self, vault: &Vault) -> Result<()> {
        validate!(
            self.get_vault_shares_base() == vault.shares_base,
            ErrorCode::InvalidVaultRebase,
            "vault depositor bases mismatch. user base: {} vault base {}",
            self.get_vault_shares_base(),
            vault.shares_base
        )?;

        Ok(())
    }

    fn checked_vault_shares(&self, vault: &Vault) -> Result<u128> {
        self.validate_base(vault)?;
        Ok(self.get_vault_shares())
    }

    fn unchecked_vault_shares(&self) -> u128 {
        self.get_vault_shares()
    }

    fn increase_vault_shares(&mut self, delta: u128, vault: &Vault) -> Result<()> {
        self.validate_base(vault)?;
        self.set_vault_shares(self.get_vault_shares().safe_add(delta)?);
        Ok(())
    }

    fn decrease_vault_shares(&mut self, delta: u128, vault: &Vault) -> Result<()> {
        self.validate_base(vault)?;
        self.set_vault_shares(self.get_vault_shares().safe_sub(delta)?);
        Ok(())
    }

    fn update_vault_shares(&mut self, new_shares: u128, vault: &Vault) -> Result<()> {
        self.validate_base(vault)?;
        self.set_vault_shares(new_shares);
        Ok(())
    }

    fn calculate_profit_share_and_update(
        &mut self,
        total_amount: u64,
        vault: &Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
    ) -> Result<(u128, u128)> {
        let cumulative_profit_share_amount = self
            .get_net_deposits()
            .safe_add(self.get_cumulative_profit_share_amount())?;

        let profit = total_amount
            .cast::<i64>()?
            .safe_sub(cumulative_profit_share_amount)?;

        let profit_beyond_hurdle = if vault.hurdle_rate > 0 {
            cumulative_profit_share_amount
                .safe_mul(vault.hurdle_rate as i64)?
                .safe_div(PERCENTAGE_PRECISION_I64)?
        } else {
            0
        };

        if profit > profit_beyond_hurdle {
            let profit_u128 = profit.cast::<u128>()?;

            let manager_profit_share_amount = profit_u128
                .safe_mul(vault.profit_share.cast()?)?
                .safe_div(PERCENTAGE_PRECISION)?;
            let protocol_profit_share_amount = match vault_protocol {
                None => 0,
                Some(vp) => profit_u128
                    .safe_mul(vp.protocol_profit_share.cast()?)?
                    .safe_div(PERCENTAGE_PRECISION)?,
            };
            let profit_share_amount =
                manager_profit_share_amount.safe_add(protocol_profit_share_amount)?;

            let net_profit = profit_u128.safe_sub(profit_share_amount)?;

            self.set_cumulative_profit_share_amount(
                self.get_cumulative_profit_share_amount()
                    .safe_add(net_profit.cast()?)?,
            );

            self.set_profit_share_fee_paid(
                self.get_profit_share_fee_paid()
                    .safe_add(profit_share_amount.cast()?)?,
            );

            return Ok((manager_profit_share_amount, protocol_profit_share_amount));
        }

        Ok((0, 0))
    }

    fn apply_profit_share(
        &mut self,
        vault_equity: u64,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
    ) -> Result<(u64, u64)> {
        let total_amount = depositor_shares_to_vault_amount(
            self.get_vault_shares(),
            vault.total_shares,
            vault_equity,
        )?;

        let (manager_profit_share, protocol_profit_share) =
            self.calculate_profit_share_and_update(total_amount, vault, vault_protocol)?;
        let manager_profit_share: u64 = manager_profit_share.cast()?;
        let protocol_profit_share: u64 = protocol_profit_share.cast()?;
        let profit_share = manager_profit_share
            .safe_add(protocol_profit_share)?
            .cast()?;

        let profit_share_shares: u128 =
            vault_amount_to_depositor_shares(profit_share, vault.total_shares, vault_equity)?;

        self.decrease_vault_shares(profit_share_shares, vault)?;

        vault.user_shares = vault.user_shares.safe_sub(profit_share_shares)?;

        vault.manager_total_profit_share = vault
            .manager_total_profit_share
            .saturating_add(manager_profit_share);

        if let Some(vp) = vault_protocol {
            vp.protocol_total_profit_share = vp
                .protocol_total_profit_share
                .saturating_add(protocol_profit_share.cast()?);
            let protocol_profit_share_shares: u128 = vault_amount_to_depositor_shares(
                protocol_profit_share.cast()?,
                vault.total_shares,
                vault_equity,
            )?;
            msg!(
                "protocol profit share shares: {}",
                protocol_profit_share_shares
            );
            vp.protocol_profit_and_fee_shares = vp
                .protocol_profit_and_fee_shares
                .saturating_add(protocol_profit_share_shares);
            msg!("vp shares after: {}", vp.protocol_profit_and_fee_shares);
        }

        Ok((manager_profit_share, protocol_profit_share))
    }

    fn apply_rebase(
        &mut self,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        vault_equity: u64,
    ) -> Result<Option<u128>> {
        vault.apply_rebase(vault_protocol, vault_equity)?;

        let mut rebase_divisor: Option<u128> = None;

        if vault.shares_base != self.get_vault_shares_base() {
            validate!(
                vault.shares_base > self.get_vault_shares_base(),
                ErrorCode::InvalidVaultRebase,
                "Rebase expo out of bounds"
            )?;

            let expo_diff = (vault.shares_base - self.get_vault_shares_base()).cast::<u32>()?;

            rebase_divisor = Some(10_u128.pow(expo_diff));

            msg!(
                "rebasing vault depositor: base: {} -> {} ",
                self.get_vault_shares_base(),
                vault.shares_base,
            );

            self.set_vault_shares_base(vault.shares_base);

            let old_vault_shares = self.unchecked_vault_shares();
            let new_vault_shares =
                old_vault_shares.safe_div(rebase_divisor.ok_or(ErrorCode::InvalidVaultRebase)?)?;

            msg!(
                "rebasing vault depositor: shares {} -> {} ",
                old_vault_shares,
                new_vault_shares
            );

            self.update_vault_shares(new_vault_shares, vault)?;
        }

        validate!(
            self.get_vault_shares_base() == vault.shares_base,
            ErrorCode::InvalidVaultRebase,
            "vault depositor shares_base != vault shares_base"
        )?;

        Ok(rebase_divisor)
    }

    /// Transfer shares from `self` to `to`
    ///
    /// Returns the number of shares transferred
    #[allow(clippy::too_many_arguments)]
    fn transfer_shares<'a>(
        &mut self,
        to: &mut dyn VaultDepositorBase,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<'a, VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        withdraw_amount: u64,
        withdraw_unit: WithdrawUnit,
        vault_equity: u64,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<(u128, Option<RefMut<'a, VaultProtocol>>)> {
        let from_rebase_divisor = self.apply_rebase(vault, vault_protocol, vault_equity)?;
        let to_rebase_divisor = to.apply_rebase(vault, vault_protocol, vault_equity)?;

        validate!(
            from_rebase_divisor == to_rebase_divisor,
            ErrorCode::InvalidVaultRebase,
            "from and to vault depositors rebase divisors mismatch"
        )?;

        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = vault.apply_fee(vault_protocol, fee_update, vault_equity, now)?;

        let (from_manager_profit_share, from_protocol_profit_share) =
            self.apply_profit_share(vault_equity, vault, vault_protocol)?;
        let (to_manager_profit_share, to_protocol_profit_share) =
            to.apply_profit_share(vault_equity, vault, vault_protocol)?;

        let (withdraw_value, n_shares) = withdraw_unit.get_withdraw_value_and_shares(
            withdraw_amount,
            vault_equity,
            self.get_vault_shares(),
            vault.total_shares,
            from_rebase_divisor,
        )?;

        validate!(
            n_shares > 0,
            ErrorCode::InvalidVaultWithdrawSize,
            "Requested n_shares = 0"
        )?;

        let from_vault_shares_before: u128 = self.checked_vault_shares(vault)?;
        let to_vault_shares_before: u128 = to.checked_vault_shares(vault)?;
        let total_vault_shares_before = vault.total_shares;
        let user_vault_shares_before = vault.user_shares;
        let protocol_shares_before = vault.get_protocol_shares(vault_protocol);

        let from_depositor_shares_before = self.checked_vault_shares(vault)?;
        let to_depositor_shares_before = to.checked_vault_shares(vault)?;

        self.decrease_vault_shares(n_shares, vault)?;
        to.increase_vault_shares(n_shares, vault)?;

        self.set_net_deposits(self.get_net_deposits().safe_sub(withdraw_value.cast()?)?);
        to.set_net_deposits(to.get_net_deposits().safe_add(withdraw_value.cast()?)?);

        let from_depositor_shares_after = self.checked_vault_shares(vault)?;
        let to_depositor_shares_after = to.checked_vault_shares(vault)?;

        validate!(
            from_depositor_shares_before.safe_add(to_depositor_shares_before)?
                == from_depositor_shares_after.safe_add(to_depositor_shares_after)?,
            ErrorCode::InvalidVaultSharesDetected,
            "VaultDepositor: total shares mismatch"
        )?;

        emit!(ShareTransferRecord {
            ts: now,
            vault: vault.pubkey,
            from_vault_depositor: self.get_pubkey(),
            to_vault_depositor: to.get_pubkey(),

            shares: n_shares,
            value: withdraw_value,
            from_depositor_shares_before,
            from_depositor_shares_after,
            to_depositor_shares_before,
            to_depositor_shares_after,
        });

        match vault_protocol {
            None => {
                emit!(VaultDepositorRecord {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: self.get_authority(),
                    action: VaultDepositorAction::Withdraw,
                    amount: withdraw_amount,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before: from_vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after: self.checked_vault_shares(vault)?,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    profit_share: from_manager_profit_share
                        .safe_add(from_protocol_profit_share)?
                        .cast()?,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    deposit_oracle_price,
                });

                emit!(VaultDepositorRecord {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: to.get_authority(),
                    action: VaultDepositorAction::Deposit,
                    amount: withdraw_amount,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before: to_vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after: to.checked_vault_shares(vault)?,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    profit_share: to_manager_profit_share
                        .safe_add(to_protocol_profit_share)?
                        .cast()?,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    deposit_oracle_price,
                });
            }
            Some(_) => {
                emit!(VaultDepositorV1Record {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: self.get_authority(),
                    action: VaultDepositorAction::Withdraw,
                    amount: withdraw_amount,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before: from_vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after: self.checked_vault_shares(vault)?,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    protocol_profit_share: from_protocol_profit_share,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    manager_profit_share: from_manager_profit_share,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after: vault.get_protocol_shares(vault_protocol),
                    deposit_oracle_price,
                });

                emit!(VaultDepositorV1Record {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: to.get_authority(),
                    action: VaultDepositorAction::Deposit,
                    amount: withdraw_amount,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before: to_vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after: to.checked_vault_shares(vault)?,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    protocol_profit_share: to_protocol_profit_share,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    manager_profit_share: from_manager_profit_share,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after: vault.get_protocol_shares(vault_protocol),
                    deposit_oracle_price,
                });
            }
        }

        Ok((n_shares, vault_protocol.take()))
    }
}
