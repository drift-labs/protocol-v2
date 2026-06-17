use std::cell::RefMut;

use anchor_lang::prelude::*;
use drift::controller::spot_balance::update_spot_balances;
use drift::error::ErrorCode as DriftErrorCode;
use drift::math::casting::Cast;
use drift::math::constants::PERCENTAGE_PRECISION;
use drift::math::insurance::{
    if_shares_to_vault_amount as depositor_shares_to_vault_amount,
    vault_amount_to_if_shares as vault_amount_to_depositor_shares,
};
use drift::math::margin::{meets_initial_margin_requirement, validate_spot_margin_trading};
use drift::math::safe_math::SafeMath;
use drift::state::oracle_map::OracleMap;
use drift::state::perp_market_map::PerpMarketMap;
use drift::state::spot_market::SpotBalanceType;
use drift::state::spot_market_map::SpotMarketMap;
use drift::state::user::User;
use drift_macros::assert_no_slop;
use static_assertions::const_assert_eq;

use crate::error::ErrorCode;
use crate::events::VaultDepositorAction;
use crate::state::events::{VaultDepositorRecord, VaultDepositorV1Record};
use crate::state::withdraw_request::WithdrawRequest;
use crate::state::withdraw_unit::WithdrawUnit;
use crate::state::{FeeUpdate, Vault, VaultDepositorBase, VaultFee, VaultProtocol};
use crate::validate;
use crate::Size;

#[assert_no_slop]
#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct VaultDepositor {
    /// The vault deposited into
    pub vault: Pubkey,
    /// The vault depositor account's pubkey. It is a pda of vault and authority
    pub pubkey: Pubkey,
    /// The authority is the address w permission to deposit/withdraw
    pub authority: Pubkey,
    /// share of vault owned by this depositor. vault_shares / vault.total_shares is depositor's ownership of vault_equity
    vault_shares: u128,
    /// last withdraw request
    pub last_withdraw_request: WithdrawRequest,
    /// creation ts of vault depositor
    pub last_valid_ts: i64,
    /// lifetime net deposits of vault depositor for the vault
    pub net_deposits: i64,
    /// lifetime total deposits
    pub total_deposits: u64,
    /// lifetime total withdraws
    pub total_withdraws: u64,
    /// the token amount of gains the vault depositor has paid performance fees on
    pub cumulative_profit_share_amount: i64,
    pub profit_share_fee_paid: u64,
    /// the exponent for vault_shares decimal places
    pub vault_shares_base: u32,
    pub padding_align: u32,
    pub padding: [u64; 5],
}

impl Size for VaultDepositor {
    const SIZE: usize = 240 + 8;
}

const_assert_eq!(
    VaultDepositor::SIZE,
    std::mem::size_of::<VaultDepositor>() + 8
);

impl VaultDepositorBase for VaultDepositor {
    fn get_authority(&self) -> Pubkey {
        self.authority
    }
    fn get_pubkey(&self) -> Pubkey {
        self.pubkey
    }

    fn get_vault_shares(&self) -> u128 {
        self.vault_shares
    }
    fn set_vault_shares(&mut self, shares: u128) {
        self.vault_shares = shares;
    }

    fn get_vault_shares_base(&self) -> u32 {
        self.vault_shares_base
    }
    fn set_vault_shares_base(&mut self, base: u32) {
        self.vault_shares_base = base;
    }

    fn get_net_deposits(&self) -> i64 {
        self.net_deposits
    }
    fn set_net_deposits(&mut self, amount: i64) {
        self.net_deposits = amount;
    }

    fn get_cumulative_profit_share_amount(&self) -> i64 {
        self.cumulative_profit_share_amount
    }
    fn set_cumulative_profit_share_amount(&mut self, amount: i64) {
        self.cumulative_profit_share_amount = amount;
    }

    fn get_profit_share_fee_paid(&self) -> u64 {
        self.profit_share_fee_paid
    }
    fn set_profit_share_fee_paid(&mut self, amount: u64) {
        self.profit_share_fee_paid = amount;
    }
}

impl VaultDepositor {
    pub fn new(vault: Pubkey, pubkey: Pubkey, authority: Pubkey, now: i64) -> Self {
        VaultDepositor {
            vault,
            pubkey,
            authority,
            vault_shares: 0,
            vault_shares_base: 0,
            last_withdraw_request: WithdrawRequest::default(),
            last_valid_ts: now,
            net_deposits: 0,
            total_deposits: 0,
            total_withdraws: 0,
            cumulative_profit_share_amount: 0,
            profit_share_fee_paid: 0,
            padding_align: 0,
            padding: [0u64; 5],
        }
    }

    pub fn validate_base(&self, vault: &Vault) -> Result<()> {
        validate!(
            self.vault_shares_base == vault.shares_base,
            ErrorCode::InvalidVaultRebase,
            "vault depositor bases mismatch. user base: {} vault base {}",
            self.vault_shares_base,
            vault.shares_base
        )?;

        Ok(())
    }

    pub fn checked_vault_shares(&self, vault: &Vault) -> Result<u128> {
        self.validate_base(vault)?;
        Ok(self.vault_shares)
    }

    pub fn unchecked_vault_shares(&self) -> u128 {
        self.vault_shares
    }

    pub fn increase_vault_shares(&mut self, delta: u128, vault: &Vault) -> Result<()> {
        self.validate_base(vault)?;
        self.vault_shares = self.vault_shares.safe_add(delta)?;
        Ok(())
    }

    pub fn decrease_vault_shares(&mut self, delta: u128, vault: &Vault) -> Result<()> {
        self.validate_base(vault)?;
        self.vault_shares = self.vault_shares.safe_sub(delta)?;
        Ok(())
    }

    pub fn update_vault_shares(&mut self, new_shares: u128, vault: &Vault) -> Result<()> {
        self.validate_base(vault)?;
        self.vault_shares = new_shares;

        Ok(())
    }

    pub fn apply_rebase(
        &mut self,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        vault_equity: u64,
    ) -> Result<Option<u128>> {
        if let Some(rebase_divisor) =
            VaultDepositorBase::apply_rebase(self, vault, vault_protocol, vault_equity)?
        {
            self.last_withdraw_request.rebase(rebase_divisor)?;
            Ok(Some(rebase_divisor))
        } else {
            Ok(None)
        }
    }

    pub fn calculate_profit_share_and_update(
        &mut self,
        total_amount: u64,
        vault: &Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
    ) -> Result<(u128, u128)> {
        let profit = total_amount.cast::<i64>()?.safe_sub(
            self.net_deposits
                .safe_add(self.cumulative_profit_share_amount)?,
        )?;
        if profit > 0 {
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
            self.cumulative_profit_share_amount = self
                .cumulative_profit_share_amount
                .safe_add(profit_u128.cast()?)?;
            self.profit_share_fee_paid = self
                .profit_share_fee_paid
                .safe_add(profit_share_amount.cast()?)?;
            return Ok((manager_profit_share_amount, protocol_profit_share_amount));
        }

        Ok((0, 0))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn deposit(
        &mut self,
        amount: u64,
        vault_equity: u64,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<()> {
        validate!(
            vault.max_tokens == 0 || vault.max_tokens >= vault_equity.safe_add(amount)?,
            ErrorCode::VaultIsAtCapacity,
            "after deposit vault equity is {} > {}",
            vault_equity.safe_add(amount)?,
            vault.max_tokens
        )?;

        validate!(
            vault.min_deposit_amount == 0 || amount >= vault.min_deposit_amount,
            ErrorCode::InvalidVaultDeposit,
            "deposit amount {} is below vault min_deposit_amount {}",
            amount,
            vault.min_deposit_amount
        )?;

        validate!(
            !(vault_equity == 0 && vault.total_shares != 0),
            ErrorCode::InvalidVaultForNewDepositors,
            "Vault balance should be non-zero for new depositors to enter"
        )?;

        validate!(
            !self.last_withdraw_request.pending(),
            ErrorCode::WithdrawInProgress,
            "withdraw request is in progress"
        )?;

        self.apply_rebase(vault, vault_protocol, vault_equity)?;

        let vault_shares_before = self.checked_vault_shares(vault)?;
        let total_vault_shares_before = vault.total_shares;
        let user_vault_shares_before = vault.user_shares;
        let protocol_shares_before = vault.get_protocol_shares(vault_protocol);

        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = vault.apply_fee(vault_protocol, fee_update, vault_equity, now)?;
        let (manager_profit_share, protocol_profit_share) =
            self.apply_profit_share(vault_equity, vault, vault_protocol, now)?;

        let n_shares = vault_amount_to_depositor_shares(amount, vault.total_shares, vault_equity)?;

        self.total_deposits = self.total_deposits.saturating_add(amount);
        self.net_deposits = self.net_deposits.safe_add(amount.cast()?)?;

        vault.total_deposits = vault.total_deposits.saturating_add(amount);
        vault.net_deposits = vault.net_deposits.safe_add(amount.cast()?)?;

        self.increase_vault_shares(n_shares, vault)?;

        vault.total_shares = vault.total_shares.safe_add(n_shares)?;
        vault.user_shares = vault.user_shares.safe_add(n_shares)?;

        let vault_shares_after = self.checked_vault_shares(vault)?;
        let protocol_shares_after = vault.get_protocol_shares(vault_protocol);

        match vault_protocol {
            None => {
                emit!(VaultDepositorRecord {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: self.authority,
                    action: VaultDepositorAction::Deposit,
                    amount,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    profit_share: manager_profit_share,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    deposit_oracle_price,
                });
            }
            Some(_) => {
                emit!(VaultDepositorV1Record {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: self.authority,
                    action: VaultDepositorAction::Deposit,
                    amount,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    protocol_profit_share,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    manager_profit_share,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after,
                    deposit_oracle_price,
                });
            }
        }

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn request_withdraw(
        &mut self,
        withdraw_amount: u64,
        withdraw_unit: WithdrawUnit,
        vault_equity: u64,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<()> {
        let rebase_divisor = self.apply_rebase(vault, vault_protocol, vault_equity)?;
        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = vault.apply_fee(vault_protocol, fee_update, vault_equity, now)?;
        let (manager_profit_share, protocol_profit_share) =
            self.apply_profit_share(vault_equity, vault, vault_protocol, now)?;

        let (withdraw_value, n_shares) = withdraw_unit.get_withdraw_value_and_shares(
            withdraw_amount,
            vault_equity,
            self.get_vault_shares(),
            vault.total_shares,
            rebase_divisor,
        )?;

        validate!(
            n_shares > 0,
            ErrorCode::InvalidVaultWithdrawSize,
            "Requested n_shares = 0"
        )?;

        let vault_shares_before: u128 = self.checked_vault_shares(vault)?;
        let total_vault_shares_before = vault.total_shares;
        let user_vault_shares_before = vault.user_shares;
        let protocol_shares_before = vault.get_protocol_shares(vault_protocol);

        self.last_withdraw_request.set(
            vault_shares_before,
            n_shares,
            withdraw_value,
            vault_equity,
            now,
        )?;
        vault.total_withdraw_requested = vault.total_withdraw_requested.safe_add(withdraw_value)?;

        let vault_shares_after = self.checked_vault_shares(vault)?;
        let protocol_shares_after = vault.get_protocol_shares(vault_protocol);

        match vault_protocol {
            None => {
                emit!(VaultDepositorRecord {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: self.authority,
                    action: VaultDepositorAction::WithdrawRequest,
                    amount: self.last_withdraw_request.value,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    profit_share: manager_profit_share,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    deposit_oracle_price,
                });
            }
            Some(_) => {
                emit!(VaultDepositorV1Record {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: self.authority,
                    action: VaultDepositorAction::WithdrawRequest,
                    amount: self.last_withdraw_request.value,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    protocol_profit_share,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    manager_profit_share,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after,
                    deposit_oracle_price,
                });
            }
        }

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn cancel_withdraw_request(
        &mut self,
        vault_equity: u64,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<()> {
        self.apply_rebase(vault, vault_protocol, vault_equity)?;

        let vd_vault_shares_before: u128 = self.checked_vault_shares(vault)?;
        let total_vault_shares_before = vault.total_shares;
        let user_vault_shares_before = vault.user_shares;
        let protocol_shares_before = vault.get_protocol_shares(vault_protocol);

        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = vault.apply_fee(vault_protocol, fee_update, vault_equity, now)?;

        let vault_shares_lost = self
            .last_withdraw_request
            .calculate_shares_lost(vault, vault_equity)?;

        // only deduct lost shares if user doesn't own 100% of the vault
        let user_owns_entire_vault = total_vault_shares_before == vd_vault_shares_before;

        if vault_shares_lost > 0 && !user_owns_entire_vault {
            self.decrease_vault_shares(vault_shares_lost, vault)?;

            vault.total_shares = vault.total_shares.safe_sub(vault_shares_lost)?;
            vault.user_shares = vault.user_shares.safe_sub(vault_shares_lost)?;
        }

        let vault_shares_after = self.checked_vault_shares(vault)?;
        let protocol_shares_after = vault.get_protocol_shares(vault_protocol);

        match vault_protocol {
            None => {
                emit!(VaultDepositorRecord {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: self.authority,
                    action: VaultDepositorAction::CancelWithdrawRequest,
                    amount: 0,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before: vd_vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    profit_share: 0,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    deposit_oracle_price,
                });
            }
            Some(_) => {
                emit!(VaultDepositorV1Record {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: self.authority,
                    action: VaultDepositorAction::CancelWithdrawRequest,
                    amount: 0,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before: vd_vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    protocol_profit_share: 0,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    manager_profit_share: 0,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after,
                    deposit_oracle_price,
                });
            }
        }

        vault.total_withdraw_requested = vault
            .total_withdraw_requested
            .safe_sub(self.last_withdraw_request.value)?;

        self.last_withdraw_request.reset(now)?;

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn withdraw(
        &mut self,
        vault_equity: u64,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<(u64, bool)> {
        self.last_withdraw_request
            .check_redeem_period_finished(vault, now)?;

        self.apply_rebase(vault, vault_protocol, vault_equity)?;

        let vault_shares_before: u128 = self.checked_vault_shares(vault)?;
        let total_vault_shares_before = vault.total_shares;
        let user_vault_shares_before = vault.user_shares;
        let protocol_shares_before = vault.get_protocol_shares(vault_protocol);

        let n_shares = self.last_withdraw_request.shares;

        validate!(
            n_shares > 0,
            ErrorCode::InvalidVaultWithdraw,
            "No last_withdraw_request.shares found, must call request_withdraw first",
        )?;

        validate!(
            vault_shares_before >= n_shares,
            ErrorCode::InsufficientVaultShares
        )?;

        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = vault.apply_fee(vault_protocol, fee_update, vault_equity, now)?;
        msg!("after management_fee vault_shares={}", self.vault_shares);

        let amount: u64 =
            depositor_shares_to_vault_amount(n_shares, vault.total_shares, vault_equity)?;

        let withdraw_amount = amount.min(self.last_withdraw_request.value);
        msg!(
            "amount={}, last_withdraw_request_value={}",
            amount,
            self.last_withdraw_request.value
        );
        msg!(
            "vault_shares={}, last_withdraw_request_shares={}",
            self.get_vault_shares(),
            self.last_withdraw_request.shares
        );

        self.decrease_vault_shares(n_shares, vault)?;

        self.total_withdraws = self.total_withdraws.saturating_add(withdraw_amount);
        self.net_deposits = self.net_deposits.safe_sub(withdraw_amount.cast()?)?;

        vault.total_withdraws = vault.total_withdraws.saturating_add(withdraw_amount);
        vault.net_deposits = vault.net_deposits.safe_sub(withdraw_amount.cast()?)?;
        vault.total_shares = vault.total_shares.safe_sub(n_shares)?;
        vault.user_shares = vault.user_shares.safe_sub(n_shares)?;
        vault.total_withdraw_requested = vault
            .total_withdraw_requested
            .safe_sub(self.last_withdraw_request.value)?;

        self.last_withdraw_request.reset(now)?;

        let vault_shares_after = self.checked_vault_shares(vault)?;
        let protocol_shares_after = vault.get_protocol_shares(vault_protocol);

        match vault_protocol {
            None => {
                emit!(VaultDepositorRecord {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: self.authority,
                    action: VaultDepositorAction::Withdraw,
                    amount: withdraw_amount,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    profit_share: 0,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    deposit_oracle_price,
                });
            }
            Some(_) => {
                emit!(VaultDepositorV1Record {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: self.authority,
                    action: VaultDepositorAction::Withdraw,
                    amount: withdraw_amount,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    protocol_profit_share: 0,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    manager_profit_share: 0,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after,
                    deposit_oracle_price,
                });
            }
        }

        let finishing_liquidation = vault.liquidation_delegate == self.authority;

        Ok((withdraw_amount, finishing_liquidation))
    }

    pub fn apply_profit_share(
        &mut self,
        vault_equity: u64,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        _now: i64,
    ) -> Result<(u64, u64)> {
        validate!(
            !self.last_withdraw_request.pending(),
            ErrorCode::InvalidVaultDeposit,
            "Cannot apply profit share to depositor with pending withdraw request"
        )?;
        VaultDepositorBase::apply_profit_share(self, vault_equity, vault, vault_protocol)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn realize_profits(
        &mut self,
        vault_equity: u64,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<u64> {
        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = vault.apply_fee(vault_protocol, fee_update, vault_equity, now)?;

        let vault_shares_before = self.checked_vault_shares(vault)?;
        let total_vault_shares_before = vault.total_shares;
        let user_vault_shares_before = vault.user_shares;
        let protocol_shares_before = vault.get_protocol_shares(vault_protocol);

        let (manager_profit_share, protocol_profit_share) =
            self.apply_profit_share(vault_equity, vault, vault_protocol, now)?;
        let profit_share = manager_profit_share.saturating_add(protocol_profit_share);
        let protocol_shares_after = vault.get_protocol_shares(vault_protocol);

        match vault_protocol {
            None => {
                emit!(VaultDepositorRecord {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: self.authority,
                    action: VaultDepositorAction::FeePayment,
                    amount: 0,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after: self.vault_shares,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    profit_share: manager_profit_share,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    deposit_oracle_price,
                });
            }
            Some(_) => {
                emit!(VaultDepositorV1Record {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: self.authority,
                    action: VaultDepositorAction::FeePayment,
                    amount: 0,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after: self.vault_shares,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    protocol_profit_share,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    manager_profit_share,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after,
                    deposit_oracle_price,
                });
            }
        }

        Ok(profit_share)
    }

    pub fn check_cant_withdraw(
        &self,
        vault: &Vault,
        vault_equity: u64,
        drift_user: &mut User,
        perp_market_map: &PerpMarketMap,
        spot_market_map: &SpotMarketMap,
        oracle_map: &mut OracleMap,
    ) -> Result<()> {
        let shares_value = depositor_shares_to_vault_amount(
            self.last_withdraw_request.shares,
            vault.total_shares,
            vault_equity,
        )?;
        let withdraw_amount = self.last_withdraw_request.value.min(shares_value);

        let mut spot_market = spot_market_map.get_ref_mut(&vault.spot_market_index)?;

        // Save relevant data before updating balances
        let spot_market_deposit_balance_before = spot_market.deposit_balance;
        let spot_market_borrow_balance_before = spot_market.borrow_balance;
        let user_spot_position_before = drift_user.spot_positions;

        update_spot_balances(
            withdraw_amount.cast()?,
            &SpotBalanceType::Borrow,
            &mut spot_market,
            drift_user.force_get_spot_position_mut(vault.spot_market_index)?,
            true,
        )?;

        drop(spot_market);

        let sufficient_collateral = meets_initial_margin_requirement(
            drift_user,
            perp_market_map,
            spot_market_map,
            oracle_map,
        )?;

        let margin_trading_ok = match validate_spot_margin_trading(
            drift_user,
            perp_market_map,
            spot_market_map,
            oracle_map,
        ) {
            Ok(_) => true,
            Err(DriftErrorCode::MarginTradingDisabled) => false,
            Err(e) => {
                msg!("Error validating spot margin trading: {:?}", e);
                return Err(ErrorCode::DriftError.into());
            }
        };

        if sufficient_collateral && margin_trading_ok {
            msg!(
                "depositor is able to withdraw. sufficient collateral = {} margin trading ok = {}",
                sufficient_collateral,
                margin_trading_ok
            );
            return Err(ErrorCode::DriftError.into());
        }

        // Must reset drift accounts afterward else ix will fail
        let mut spot_market = spot_market_map.get_ref_mut(&vault.spot_market_index)?;
        spot_market.deposit_balance = spot_market_deposit_balance_before;
        spot_market.borrow_balance = spot_market_borrow_balance_before;

        drift_user.spot_positions = user_spot_position_before;

        Ok(())
    }
}

#[cfg(test)]
mod vault_v1_tests {
    use std::cell::RefCell;

    use anchor_lang::prelude::Pubkey;
    use drift::math::casting::Cast;
    use drift::math::constants::{PERCENTAGE_PRECISION_U64, QUOTE_PRECISION_U64};
    use drift::math::insurance::if_shares_to_vault_amount;

    use crate::{Vault, VaultDepositor, VaultProtocol, WithdrawUnit};

    #[test]
    fn base_init() {
        let now = 1337;
        let vd = VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(vd.last_valid_ts, now);
    }

    #[test]
    fn test_deposit_withdraw() {
        let now = 1000;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);

        let vault_equity: u64 = 100 * QUOTE_PRECISION_U64; // $100 in total equity
        let amount: u64 = 100 * QUOTE_PRECISION_U64; // $100 of new deposits to add to total equity, for new total of $200
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();

        let vault_equity: u64 = 200 * QUOTE_PRECISION_U64;

        vd.request_withdraw(
            amount.cast().unwrap(),
            WithdrawUnit::Token,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();

        let (withdraw_amount, _) = vd
            .withdraw(
                vault_equity,
                &mut vault,
                &mut Some(vp.borrow_mut()),
                &mut None,
                now + 20,
                0,
            )
            .unwrap();
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(withdraw_amount, amount);
    }

    #[test]
    fn test_deposit_partial_withdraw_profit_share() {
        let now = 1000;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64; // $100 in total equity for depositor
        let amount: u64 = 100 * QUOTE_PRECISION_U64; // $100 in total equity for vault
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 100_000_000); // 100_000_000 shares or $200 in equity
        assert_eq!(vault.user_shares, 100_000_000);
        assert_eq!(vault.total_shares, 200_000_000);

        vault.profit_share = 100_000; // 10% profit share
        vp.borrow_mut().protocol_profit_share = 50_000; // 5% profit share
        vault_equity = 400 * QUOTE_PRECISION_U64; // vault gains 100% in value ($200 -> $400)

        // withdraw principal
        vd.request_withdraw(
            amount.cast().unwrap(), // only withdraw profit ($100)
            WithdrawUnit::Token,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();
        // 100M shares, 50M of which are profit. 15% profit share on 50M shares is 7.5M shares. 100M - 7.5M = 92.5M shares
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 92_500_000);

        assert_eq!(vd.last_withdraw_request.shares, 50_000_000);
        assert_eq!(vd.last_withdraw_request.value, 100_000_000);
        assert_eq!(vd.last_withdraw_request.ts, now + 20);

        let (withdraw_amount, _ll) = vd
            .withdraw(
                vault_equity,
                &mut vault,
                &mut Some(vp.borrow_mut()),
                &mut None,
                now + 20,
                0,
            )
            .unwrap();
        // 100M shares minus 50M shares of profit and 15% or 7.5M profit share = 42.5M shares
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 42_500_000);
        assert_eq!(vault.user_shares, 42_500_000);
        // manager is 200M total shares - 100M user shares + 5M or 10% profit share from user withdrawal.
        assert_eq!(
            vault
                .get_manager_shares(&mut Some(vp.borrow_mut()))
                .unwrap(),
            105_000_000
        );
        // protocol received 5% profit share on 50M shares, or 2.5M shares.
        assert_eq!(
            vault.get_protocol_shares(&mut Some(vp.borrow_mut())),
            2_500_000
        );
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(vault.total_shares, 150_000_000);
        assert_eq!(withdraw_amount, amount);

        vault_equity -= withdraw_amount;

        let manager_owned_shares = vault
            .get_manager_shares(&mut Some(vp.borrow_mut()))
            .unwrap();
        let manager_owned_amount =
            if_shares_to_vault_amount(manager_owned_shares, vault.total_shares, vault_equity)
                .unwrap();
        // 100M shares or $200 in equity plus 10% of 50M shares or $100 profit which is $10, for a total of $210.
        assert_eq!(manager_owned_amount, 210_000_000);

        let user_owned_shares = vault.user_shares;
        let user_owned_amount =
            if_shares_to_vault_amount(user_owned_shares, vault.total_shares, vault_equity).unwrap();
        // $200 in equity - $100 in realized profit - 15% profit share on $100 = $85
        assert_eq!(user_owned_amount, 85_000_000);

        let protocol_owned_shares = vault.get_protocol_shares(&mut Some(vp.borrow_mut()));
        let protocol_owned_amount =
            if_shares_to_vault_amount(protocol_owned_shares, vault.total_shares, vault_equity)
                .unwrap();
        // 5% profit share on $100 = $5
        assert_eq!(protocol_owned_amount, 5_000_000);
    }

    #[test]
    fn test_deposit_partial_withdraw_profit_share_no_protocol() {
        let now = 1000;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64; // $100 in total equity for depositor
        let amount: u64 = 100 * QUOTE_PRECISION_U64; // $100 in total equity for vault
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 100_000_000); // 100_000_000 shares or $200 in equity
        assert_eq!(vault.user_shares, 100_000_000);
        assert_eq!(vault.total_shares, 200_000_000);

        vault.profit_share = 100_000; // 10% profit share
        vault_equity = 400 * QUOTE_PRECISION_U64; // vault gains 100% in value ($200 -> $400)

        // withdraw principal
        vd.request_withdraw(
            amount.cast().unwrap(), // only withdraw profit ($100)
            WithdrawUnit::Token,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 95_000_000);

        assert_eq!(vd.last_withdraw_request.shares, 50_000_000);
        assert_eq!(vd.last_withdraw_request.value, 100_000_000);
        assert_eq!(vd.last_withdraw_request.ts, now + 20);

        let (withdraw_amount, _ll) = vd
            .withdraw(
                vault_equity,
                &mut vault,
                &mut Some(vp.borrow_mut()),
                &mut None,
                now + 20,
                0,
            )
            .unwrap();
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 45_000_000);
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(vault.user_shares, 45_000_000);
        assert_eq!(vault.total_shares, 150_000_000);
        assert_eq!(withdraw_amount, amount);

        vault_equity -= withdraw_amount;

        let manager_owned_shares = vault
            .get_manager_shares(&mut Some(vp.borrow_mut()))
            .unwrap();
        let manager_owned_amount =
            if_shares_to_vault_amount(manager_owned_shares, vault.total_shares, vault_equity)
                .unwrap();
        assert_eq!(manager_owned_amount, 210_000_000); // $210

        let user_owned_shares = vault.user_shares;
        let user_owned_amount =
            if_shares_to_vault_amount(user_owned_shares, vault.total_shares, vault_equity).unwrap();
        assert_eq!(user_owned_amount, 90_000_000); // $90

        let protocol_owned_shares = vault.get_protocol_shares(&mut Some(vp.borrow_mut()));
        let protocol_owned_amount =
            if_shares_to_vault_amount(protocol_owned_shares, vault.total_shares, vault_equity)
                .unwrap();
        println!("protocol amount: {}", protocol_owned_amount);
        assert_eq!(protocol_owned_amount, 0); // $100
    }

    #[test]
    fn test_deposit_full_withdraw_profit_share() {
        let now = 1000;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 100_000_000);
        assert_eq!(vault.user_shares, 100_000_000);
        assert_eq!(vault.total_shares, 200_000_000);

        vault.profit_share = 100_000; // 10% profit share
        vp.borrow_mut().protocol_profit_share = 50_000; // 5% profit share
        vault_equity = 400 * QUOTE_PRECISION_U64; // up 100%

        // withdraw all
        vd.request_withdraw(
            185 * QUOTE_PRECISION_U64, // vault_equity * (100% - 15% profit share)
            WithdrawUnit::Token,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();
        // user has 100M shares, with 100% profit, so 50M shares are profit.
        // profit share of 15% of 50M shares is 7.5M shares, and 100M - 7.5M = 92.5M shares
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 92_500_000);
        assert_eq!(vd.last_withdraw_request.shares, 92_500_000);
        // user has 200M worth of value, with 15% profit share on 100M in profit, or 200M - 15M = 185M
        assert_eq!(vd.last_withdraw_request.value, 185_000_000);
        assert_eq!(vd.last_withdraw_request.ts, now + 20);

        let (withdraw_amount, _) = vd
            .withdraw(
                vault_equity,
                &mut vault,
                &mut Some(vp.borrow_mut()),
                &mut None,
                now + 20,
                0,
            )
            .unwrap();
        let profit = amount;
        let equity_minus_fee = amount + profit - (profit as f64 * 0.15).round() as u64;
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 0);
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(vault.user_shares, 0);
        // user had 100M shares, vault had 200M total
        // user paid 15% profit share on 50M shares, or 7.5M shares
        // total shares outside of user is now 100M + 7.5M = 107.5M
        assert_eq!(vault.total_shares, 107_500_000);
        assert_eq!(withdraw_amount, equity_minus_fee);
        // $85 = 100 - 10% - 5%, worth of profit that has been realized (this is not total fees paid)
        assert_eq!(vd.cumulative_profit_share_amount, 85_000_000);
        println!("vault shares: {}", vd.checked_vault_shares(&vault).unwrap());
        println!("shares base: {}", vd.vault_shares_base);
        println!("user shares: {}", vault.user_shares);
        println!("total shares: {}", vault.total_shares);
        println!(
            "withdraw amount: {}, actual: {}",
            withdraw_amount, equity_minus_fee
        );
        println!(
            "cum profit share amount: {}",
            vd.cumulative_profit_share_amount
        );

        vault_equity -= withdraw_amount;

        let manager_owned_shares = vault
            .get_manager_shares(&mut Some(vp.borrow_mut()))
            .unwrap();
        let manager_owned_amount =
            if_shares_to_vault_amount(manager_owned_shares, vault.total_shares, vault_equity)
                .unwrap();
        println!(
            "manager total profit share: {}",
            vault.manager_total_profit_share
        );
        println!("manager shares: {}", manager_owned_shares);
        println!("manager owned amount: {}", manager_owned_amount);
        // 10% of 50M shares of profit on top of 100M owned shares
        assert_eq!(manager_owned_shares, 105_000_000);
        // 10% of $100 in profit on top of $200 in owned equity
        // totals $210 in equity
        assert_eq!(manager_owned_amount, 210_000_000);

        let protocol_owned_shares = vault.get_protocol_shares(&mut Some(vp.borrow_mut()));
        let protocol_owned_amount =
            if_shares_to_vault_amount(protocol_owned_shares, vault.total_shares, vault_equity)
                .unwrap();
        println!(
            "protocol total profit share: {}",
            vp.borrow().protocol_total_profit_share
        );
        println!("protocol shares: {}", protocol_owned_shares);
        println!("protocol amount: {}", protocol_owned_amount);
        // 5% of 50M shares of profit
        assert_eq!(protocol_owned_shares, 2_500_000);
        // 5% of $100 in profit which totals $5 in equity
        assert_eq!(protocol_owned_amount, 5_000_000);
    }

    #[test]
    fn test_deposit_full_withdraw_profit_share_no_protocol() {
        let now = 1000;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 100_000_000);
        assert_eq!(vault.user_shares, 100_000_000);
        assert_eq!(vault.total_shares, 200_000_000);

        vault.profit_share = 100_000; // 10% profit share
        vault_equity = 400 * QUOTE_PRECISION_U64; // up 100%

        // withdraw all
        vd.request_withdraw(
            190 * QUOTE_PRECISION_U64, // vault_equity * (100% - 10% profit share)
            WithdrawUnit::Token,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();
        // user has 100M shares, with 100% profit, so 50M shares are profit.
        // profit share of 15% of 50M shares is 7.5M shares, and 100M - 5M = 95M shares
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 95_000_000);
        assert_eq!(vd.last_withdraw_request.shares, 95_000_000);
        // user has 200M worth of value, with 10% profit share on 100M in profit, or 200M - 10M = 190M
        assert_eq!(vd.last_withdraw_request.value, 190_000_000);
        assert_eq!(vd.last_withdraw_request.ts, now + 20);

        let (withdraw_amount, _) = vd
            .withdraw(
                vault_equity,
                &mut vault,
                &mut Some(vp.borrow_mut()),
                &mut None,
                now + 20,
                0,
            )
            .unwrap();
        let profit = amount;
        let equity_minus_fee = amount + profit - (profit as f64 * 0.10).round() as u64;
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 0);
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(vault.user_shares, 0);
        // user had 100M shares, vault had 200M total
        // user paid 15% profit share on 50M shares, or 5M shares
        // total shares outside of user is now 100M + 5M = 105M
        assert_eq!(vault.total_shares, 105_000_000);
        assert_eq!(withdraw_amount, equity_minus_fee);
        // $90 = $100 - 10% worth of profit that has been realized (this is not total fees paid)
        assert_eq!(vd.cumulative_profit_share_amount, 90_000_000);
        println!("vault shares: {}", vd.checked_vault_shares(&vault).unwrap());
        println!("shares base: {}", vd.vault_shares_base);
        println!("user shares: {}", vault.user_shares);
        println!("total shares: {}", vault.total_shares);
        println!(
            "withdraw amount: {}, actual: {}",
            withdraw_amount, equity_minus_fee
        );
        println!(
            "cum profit share amount: {}",
            vd.cumulative_profit_share_amount
        );

        vault_equity -= withdraw_amount;

        let manager_owned_shares = vault
            .get_manager_shares(&mut Some(vp.borrow_mut()))
            .unwrap();
        let manager_owned_amount =
            if_shares_to_vault_amount(manager_owned_shares, vault.total_shares, vault_equity)
                .unwrap();
        println!(
            "manager total profit share: {}",
            vault.manager_total_profit_share
        );
        println!("manager shares: {}", manager_owned_shares);
        println!("manager owned amount: {}", manager_owned_amount);
        // 10% of 50M shares of profit on top of 100M owned shares
        assert_eq!(manager_owned_shares, 105_000_000);
        // 10% of $100 in profit on top of $200 in owned equity
        // totals $210 in equity
        assert_eq!(manager_owned_amount, 210_000_000);

        let protocol_owned_shares = vault.get_protocol_shares(&mut Some(vp.borrow_mut()));
        let protocol_owned_amount =
            if_shares_to_vault_amount(protocol_owned_shares, vault.total_shares, vault_equity)
                .unwrap();
        println!(
            "protocol total profit share: {}",
            vp.borrow().protocol_total_profit_share
        );
        println!("protocol shares: {}", protocol_owned_shares);
        println!("protocol amount: {}", protocol_owned_amount);
        // 0% of 50M shares of profit is 0 shares
        assert_eq!(protocol_owned_shares, 0);
        // 0% of $100 in profit which totals $0 in equity
        assert_eq!(protocol_owned_amount, 0);
    }

    #[test]
    fn test_force_realize_profit_share() {
        let now = 1000;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64; // $100 in equity
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap();
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 100000000);
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);

        vault.profit_share = 100_000; // 10% profit share
                                      // vault_protocol.protocol_profit_share = 50_000; // 5% profit share
        vault_equity = 400 * QUOTE_PRECISION_U64; // up 100%

        vd.realize_profits(
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap();

        println!("vault shares: {}", vd.checked_vault_shares(&vault).unwrap());
        println!(
            "cum profit share amount: {}",
            vd.cumulative_profit_share_amount
        );
        println!("user shares: {}", vault.user_shares);
        println!("total shares: {}", vault.total_shares);
        // assert_eq!(vd.checked_vault_shares(vault).unwrap(), 95000000);
        // assert_eq!(vd.cumulative_profit_share_amount, 100000000); // $100
        // assert_eq!(vault.user_shares, 95000000); // $95
        // assert_eq!(vault.total_shares, 200000000); // $200

        // withdraw all
        vd.request_withdraw(
            190 * QUOTE_PRECISION_U64,
            WithdrawUnit::Token,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 95000000);

        assert_eq!(vd.last_withdraw_request.value, 190000000);
        assert_eq!(vd.last_withdraw_request.ts, now + 20);
        // assert_eq!(vd.last_withdraw_request.shares, 100000000);

        let (withdraw_amount, _ll) = vd
            .withdraw(
                vault_equity,
                &mut vault,
                &mut Some(vp.borrow_mut()),
                &mut None,
                now + 20,
                0,
            )
            .unwrap();
        // assert_eq!(vd.checked_vault_shares(vault).unwrap(), 0);
        // assert_eq!(vd.vault_shares_base, 0);
        // assert_eq!(vault.user_shares, 0);
        // assert_eq!(vault.total_shares, 105000000);
        assert_eq!(withdraw_amount, amount * 2 - amount * 2 / 20);
        // assert_eq!(vd.cumulative_profit_share_amount, 100000000); // $100
        println!("vault shares: {}", vd.checked_vault_shares(&vault).unwrap());
        println!("shares base: {}", vd.vault_shares_base);
        println!("user shares: {}", vault.user_shares);
        println!("total shares: {}", vault.total_shares);
        println!(
            "cum profit share amount: {}",
            vd.cumulative_profit_share_amount
        );
    }

    #[test]
    fn test_vault_depositor_request_in_loss_withdraw_in_profit() {
        // test for vault depositor who requests withdraw when in loss
        // then waits redeem period for withdraw
        // upon withdraw, vault depositor would have been in profit had they not requested in loss
        // should get request withdraw valuation and not break invariants

        let now = 1000;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap();
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 100000000);
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);

        vault.profit_share = 100_000; // 10% profit share
        vp.borrow_mut().protocol_profit_share = 50_000; // 5% profit share
        vault.redeem_period = 3600; // 1 hour
        vault_equity = 100 * QUOTE_PRECISION_U64; // down 50%

        // assert_eq!(vd.checked_vault_shares(vault).unwrap(), 100000000);
        // assert_eq!(vd.cumulative_profit_share_amount, 0); // $0
        // assert_eq!(vault.user_shares, 100000000);
        // assert_eq!(vault.total_shares, 200000000);
        println!("vault shares: {}", vd.checked_vault_shares(&vault).unwrap());
        println!(
            "cum profit share amount: {}",
            vd.cumulative_profit_share_amount
        );
        println!("user shares: {}", vault.user_shares);
        println!("total shares: {}", vault.total_shares);

        // let vault_before = vault;
        vd.realize_profits(
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap(); // should be noop

        // request withdraw all
        vd.request_withdraw(
            PERCENTAGE_PRECISION_U64,
            WithdrawUnit::SharesPercent,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();
        // assert_eq!(vd.checked_vault_shares(vault).unwrap(), 100000000);
        println!("request shares: {}", vd.last_withdraw_request.shares);

        // assert_eq!(vd.last_withdraw_request.value, 50000000);
        assert_eq!(vd.last_withdraw_request.ts, now + 20);
        println!("request value: {}", vd.last_withdraw_request.value);

        vault_equity *= 5; // up 400%

        let (withdraw_amount, _ll) = vd
            .withdraw(
                vault_equity,
                &mut vault,
                &mut Some(vp.borrow_mut()),
                &mut None,
                now + 20 + 3600,
                0,
            )
            .unwrap();
        // assert_eq!(vd.checked_vault_shares(vault).unwrap(), 0);
        // assert_eq!(vd.vault_shares_base, 0);
        // assert_eq!(vault.user_shares, 0);
        // assert_eq!(vault.total_shares, 100000000);
        assert_eq!(withdraw_amount, 50000000);
        // assert_eq!(vd.cumulative_profit_share_amount, 0); // $0
        println!("vault shares: {}", vd.checked_vault_shares(&vault).unwrap());
        println!("shares base: {}", vd.vault_shares_base);
        println!("user shares: {}", vault.user_shares);
        println!("total shares: {}", vault.total_shares);
        println!(
            "cum profit share amount: {}",
            vd.cumulative_profit_share_amount
        );
    }

    #[test]
    fn test_vault_depositor_request_in_profit_withdraw_in_loss() {
        // test for vault depositor who requests withdraw when in profit
        // then waits redeem period for withdraw
        // upon withdraw, vault depositor is in loss even though they withdrew in profit
        // should get withdraw valuation and not break invariants

        let now = 1000;
        let mut vault = Vault::default();
        let vp = RefCell::new(VaultProtocol::default());

        let vd =
            &mut VaultDepositor::new(Pubkey::default(), Pubkey::default(), Pubkey::default(), now);

        let mut vault_equity: u64 = 100 * QUOTE_PRECISION_U64;
        let amount: u64 = 100 * QUOTE_PRECISION_U64;
        vd.deposit(
            amount,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap();
        assert_eq!(vd.vault_shares_base, 0);
        assert_eq!(vd.checked_vault_shares(&vault).unwrap(), 100000000);
        assert_eq!(vault.user_shares, 100000000);
        assert_eq!(vault.total_shares, 200000000);

        vault.profit_share = 100_000; // 10% profit share
        vp.borrow_mut().protocol_profit_share = 50_000; // 5% profit share
        vault.redeem_period = 3600; // 1 hour
        vault_equity = 200 * QUOTE_PRECISION_U64;

        // assert_eq!(vd.checked_vault_shares(vault).unwrap(), 100000000);
        // assert_eq!(vd.cumulative_profit_share_amount, 0); // $0
        // assert_eq!(vault.user_shares, 100000000);
        // assert_eq!(vault.total_shares, 200000000);
        println!("vault shares: {}", vd.checked_vault_shares(&vault).unwrap());
        println!(
            "cum profit share amount: {}",
            vd.cumulative_profit_share_amount
        );
        println!("user shares: {}", vault.user_shares);
        println!("total shares: {}", vault.total_shares);

        // let vault_before = vault;
        vd.realize_profits(
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now,
            0,
        )
        .unwrap(); // should be noop

        // request withdraw all
        vd.request_withdraw(
            PERCENTAGE_PRECISION_U64,
            WithdrawUnit::SharesPercent,
            vault_equity,
            &mut vault,
            &mut Some(vp.borrow_mut()),
            &mut None,
            now + 20,
            0,
        )
        .unwrap();
        // assert_eq!(vd.checked_vault_shares(vault).unwrap(), 100000000);
        println!("request shares: {}", vd.last_withdraw_request.shares);

        assert_eq!(vd.last_withdraw_request.value, 100000000);
        assert_eq!(vd.last_withdraw_request.ts, now + 20);

        vault_equity /= 5; // down 80%

        let (withdraw_amount, _ll) = vd
            .withdraw(
                vault_equity,
                &mut vault,
                &mut Some(vp.borrow_mut()),
                &mut None,
                now + 20 + 3600,
                0,
            )
            .unwrap();
        // assert_eq!(vd.checked_vault_shares(vault).unwrap(), 0);
        // assert_eq!(vd.vault_shares_base, 0);
        // assert_eq!(vault.user_shares, 0);
        // assert_eq!(vault.total_shares, 100000000);
        assert_eq!(withdraw_amount, 20000000); // getting back 20% of deposit
                                               // assert_eq!(vd.cumulative_profit_share_amount, 0); // $0
        println!("vault shares: {}", vd.checked_vault_shares(&vault).unwrap());
        println!("shares base: {}", vd.vault_shares_base);
        println!("user shares: {}", vault.user_shares);
        println!("total shares: {}", vault.total_shares);
        println!(
            "cum profit share amount: {}",
            vd.cumulative_profit_share_amount
        );
    }
}
