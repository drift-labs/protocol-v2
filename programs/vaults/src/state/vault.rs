use std::cell::RefMut;

use anchor_lang::prelude::*;
use drift::math::casting::Cast;
use drift::math::constants::{ONE_YEAR, PERCENTAGE_PRECISION, PERCENTAGE_PRECISION_I128};
use drift::math::insurance::calculate_rebase_info;
use drift::math::insurance::{
    if_shares_to_vault_amount as depositor_shares_to_vault_amount,
    vault_amount_to_if_shares as vault_amount_to_depositor_shares,
};
use drift::math::margin::calculate_user_equity;
use drift::math::safe_math::SafeMath;
use drift::state::oracle_map::OracleMap;
use drift::state::perp_market_map::PerpMarketMap;
use drift::state::spot_market_map::SpotMarketMap;
use drift::state::user::User;
use drift_macros::assert_no_slop;
use static_assertions::const_assert_eq;

use crate::constants::TIME_FOR_LIQUIDATION;
use crate::error::{ErrorCode, VaultResult};
use crate::events::{VaultDepositorAction, VaultDepositorV1Record};
use crate::state::events::VaultDepositorRecord;
use crate::state::withdraw_request::WithdrawRequest;
use crate::state::{FeeUpdate, VaultFee, VaultProtocol};
use crate::{validate, Size, WithdrawUnit};

#[assert_no_slop]
#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct Vault {
    /// The name of the vault. Vault pubkey is derived from this name.
    pub name: [u8; 32],
    /// The vault's pubkey. It is a pda of name and also used as the authority for drift user
    pub pubkey: Pubkey,
    /// The manager of the vault who has ability to update vault params
    pub manager: Pubkey,
    /// The vaults token account. Used to receive tokens between deposits and withdrawals
    pub token_account: Pubkey,
    /// The drift user stats account for the vault
    pub user_stats: Pubkey,
    /// The drift user account for the vault
    pub user: Pubkey,
    /// The vaults designated delegate for drift user account
    /// can differ from actual user delegate if vault is in liquidation
    pub delegate: Pubkey,
    /// The delegate handling liquidation for depositor
    pub liquidation_delegate: Pubkey,
    /// The sum of all shares held by the users (vault depositors)
    pub user_shares: u128,
    /// The sum of all shares: deposits from users, manager deposits, manager profit/fee, and protocol profit/fee.
    /// The manager deposits are total_shares - user_shares - protocol_profit_and_fee_shares.
    pub total_shares: u128,
    pub last_manager_withdraw_request: WithdrawRequest,
    /// Last fee update unix timestamp
    pub last_fee_update_ts: i64,
    /// When the liquidation starts
    pub liquidation_start_ts: i64,
    /// The period (in seconds) that a vault depositor must wait after requesting a withdrawal to finalize withdrawal.
    /// Currently, the maximum is 90 days.
    pub redeem_period: i64,
    /// The sum of all outstanding withdraw requests
    pub total_withdraw_requested: u64,
    /// Max token capacity, once hit/passed vault will reject new deposits (updatable)
    pub max_tokens: u64,
    /// The annual fee charged on deposits by the manager.
    /// Traditional funds typically charge 2% per year on assets under management.
    pub management_fee: i64,
    /// Timestamp vault initialized
    pub init_ts: i64,
    /// The net deposits for the vault
    pub net_deposits: i64,
    /// The net deposits for the manager
    pub manager_net_deposits: i64,
    /// Total deposits
    pub total_deposits: u64,
    /// Total withdraws
    pub total_withdraws: u64,
    /// Total deposits for the manager
    pub manager_total_deposits: u64,
    /// Total withdraws for the manager
    pub manager_total_withdraws: u64,
    /// Total management fee accrued by the manager
    pub manager_total_fee: i64,
    /// Total profit share accrued by the manager
    pub manager_total_profit_share: u64,
    /// The minimum deposit amount
    pub min_deposit_amount: u64,
    /// The total value (in deposit asset) of borrows the manager has outstanding.
    /// Purely for informational purposes for assets that have left the vault that the manager
    /// is expected to return.
    pub manager_borrowed_value: u64,
    /// The base 10 exponent of the shares (given massive share inflation can occur at near zero vault equity)
    pub shares_base: u32,
    /// Percentage the manager charges on all profits realized by depositors: PERCENTAGE_PRECISION
    pub profit_share: u32,
    /// Vault manager only collect incentive fees during periods when returns are higher than this amount: PERCENTAGE_PRECISION
    pub hurdle_rate: u32,
    /// The spot market index the vault deposits into/withdraws from
    pub spot_market_index: u16,
    /// The bump for the vault pda
    pub bump: u8,
    /// Whether anybody can be a depositor
    pub permissioned: bool,
    /// The optional [`VaultProtocol`] account.
    pub vault_protocol: bool,
    /// Whether the vault has a FeeUpdate account [`FeeUpdateStatus`]. Default is `FeeUpdateStatus::None`
    /// After a `FeeUpdate` account is created and the manager has staged a fee update, the status is set to `PendingFeeUpdate`.
    /// And instructsions that may finalize the fee update must include the `FeeUpdate` account with `remaining_accounts`.
    pub fee_update_status: u8,
    /// The class of the vault [`VaultClass`]. Default is `VaultClass::Normal`
    pub vault_class: u8,
    pub padding: [u8; 5],
}

impl Vault {
    pub fn get_vault_signer_seeds<'a>(name: &'a [u8], bump: &'a u8) -> [&'a [u8]; 3] {
        [b"vault".as_ref(), name, bytemuck::bytes_of(bump)]
    }

    pub fn is_normal_vault_class(&self) -> bool {
        self.vault_class == VaultClass::Normal as u8
    }

    pub fn is_trusted_vault_class(&self) -> bool {
        self.vault_class == VaultClass::Trusted as u8
    }
}

impl Size for Vault {
    const SIZE: usize = 480 + 8;
}
const_assert_eq!(Vault::SIZE, std::mem::size_of::<Vault>() + 8);

impl Vault {
    pub fn apply_fee(
        &mut self,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        vault_equity: u64,
        now: i64,
    ) -> Result<VaultFee> {
        if let Some(ref mut fee_update) = fee_update {
            fee_update.load_mut()?.try_update_vault_fees(now, self)?;
        }

        let depositor_equity =
            depositor_shares_to_vault_amount(self.user_shares, self.total_shares, vault_equity)?
                .cast::<i128>()?;
        let management_fee_payment: i128 = 0;
        let mut management_fee_shares: i128 = 0;
        let protocol_fee_payment: i128 = 0;
        let mut protocol_fee_shares: i128 = 0;
        let mut skip_ts_update = false;

        let mut handle_no_protocol_fee = |vault: &mut Vault| -> Result<()> {
            let since_last = now.safe_sub(vault.last_fee_update_ts)?;

            // default behavior in legacy [`Vault`], manager taxes equity - 1 if tax is >= equity
            let management_fee_payment = depositor_equity
                .safe_mul(vault.management_fee.cast()?)?
                .safe_div(PERCENTAGE_PRECISION_I128)?
                .safe_mul(since_last.cast()?)?
                .safe_div(ONE_YEAR.cast()?)?
                .min(depositor_equity.saturating_sub(1));

            let new_total_shares_factor: u128 = depositor_equity
                .safe_mul(PERCENTAGE_PRECISION_I128)?
                .safe_div(depositor_equity.safe_sub(management_fee_payment)?)?
                .cast()?;

            let new_total_shares = vault
                .total_shares
                .safe_mul(new_total_shares_factor.cast()?)?
                .safe_div(PERCENTAGE_PRECISION)?
                .max(vault.user_shares);

            if management_fee_payment == 0 || vault.total_shares == new_total_shares {
                // time delta wasn't large enough to pay any management/protocol fee
                skip_ts_update = true;
            }

            management_fee_shares = new_total_shares
                .cast::<i128>()?
                .safe_sub(vault.total_shares.cast()?)?;
            vault.total_shares = new_total_shares;
            vault.manager_total_fee = vault
                .manager_total_fee
                .saturating_add(management_fee_payment.cast()?);

            // in case total_shares is pushed to level that warrants a rebase
            vault.apply_rebase(&mut None, vault_equity)?;
            Ok(())
        };

        match vault_protocol {
            None => {
                if self.management_fee != 0 && depositor_equity > 0 {
                    handle_no_protocol_fee(self)?;
                }
            }
            Some(vp) => {
                if self.management_fee != 0 && vp.protocol_fee != 0 && depositor_equity > 0 {
                    let since_last = now.safe_sub(self.last_fee_update_ts)?;
                    let total_fee = self
                        .management_fee
                        .safe_add(vp.protocol_fee.cast()?)?
                        .cast::<i128>()?;

                    // if protocol fee is non-zero and total fee would lead to zero equity remaining,
                    // so tax equity - 1 but only for the protocol, so that the user is left with 1 and the manager retains their full fee.
                    let total_fee_payment = depositor_equity
                        .safe_mul(total_fee)?
                        .safe_div(PERCENTAGE_PRECISION_I128)?
                        .safe_mul(since_last.cast()?)?
                        .safe_div(ONE_YEAR.cast()?)?;
                    let management_fee_payment = total_fee_payment
                        .safe_mul(self.management_fee.cast()?)?
                        .safe_div(total_fee)?;
                    let protocol_fee_payment = total_fee_payment
                        .min(depositor_equity.saturating_sub(1))
                        .safe_sub(management_fee_payment)?;

                    let new_total_shares_factor: u128 = depositor_equity
                        .safe_mul(PERCENTAGE_PRECISION_I128)?
                        .safe_div(
                            depositor_equity
                                .safe_sub(management_fee_payment)?
                                .safe_sub(protocol_fee_payment)?,
                        )?
                        .cast()?;
                    let mgmt_fee_shares_factor: u128 = depositor_equity
                        .safe_mul(PERCENTAGE_PRECISION_I128)?
                        .safe_div(depositor_equity.safe_sub(management_fee_payment)?)?
                        .cast()?;
                    let protocol_fee_shares_factor: u128 = depositor_equity
                        .safe_mul(PERCENTAGE_PRECISION_I128)?
                        .safe_div(depositor_equity.safe_sub(protocol_fee_payment)?)?
                        .cast()?;

                    let new_total_shares = self
                        .total_shares
                        .safe_mul(new_total_shares_factor.cast()?)?
                        .safe_div(PERCENTAGE_PRECISION)?
                        .max(self.user_shares);

                    management_fee_shares = self
                        .total_shares
                        .safe_mul(mgmt_fee_shares_factor.cast()?)?
                        .safe_div(PERCENTAGE_PRECISION)?
                        .max(self.user_shares)
                        .cast::<i128>()?
                        .safe_sub(self.total_shares.cast()?)?;

                    protocol_fee_shares = self
                        .total_shares
                        .safe_mul(protocol_fee_shares_factor.cast()?)?
                        .safe_div(PERCENTAGE_PRECISION)?
                        .max(self.user_shares)
                        .cast::<i128>()?
                        .safe_sub(self.total_shares.cast()?)?;

                    if (management_fee_payment == 0 && protocol_fee_payment == 0)
                        || self.total_shares == new_total_shares
                    {
                        // time delta wasn't large enough to pay any management/protocol fee
                        skip_ts_update = true;
                    }

                    self.total_shares = new_total_shares;
                    self.manager_total_fee = self
                        .manager_total_fee
                        .saturating_add(management_fee_payment.cast()?);

                    vp.protocol_total_fee = vp
                        .protocol_total_fee
                        .saturating_add(protocol_fee_payment.cast()?);
                    vp.protocol_profit_and_fee_shares = vp
                        .protocol_profit_and_fee_shares
                        .safe_add(protocol_fee_shares.cast()?)?;

                    // in case total_shares is pushed to level that warrants a rebase
                    self.apply_rebase(vault_protocol, vault_equity)?;
                } else if self.management_fee == 0 && vp.protocol_fee != 0 && depositor_equity > 0 {
                    let since_last = now.safe_sub(self.last_fee_update_ts)?;

                    // default behavior in legacy [`Vault`], manager taxes equity - 1 if tax is >= equity
                    let protocol_fee_payment = depositor_equity
                        .safe_mul(vp.protocol_fee.cast()?)?
                        .safe_div(PERCENTAGE_PRECISION_I128)?
                        .safe_mul(since_last.cast()?)?
                        .safe_div(ONE_YEAR.cast()?)?
                        .min(depositor_equity.saturating_sub(1));

                    let new_total_shares_factor: u128 = depositor_equity
                        .safe_mul(PERCENTAGE_PRECISION_I128)?
                        .safe_div(depositor_equity.safe_sub(protocol_fee_payment)?)?
                        .cast()?;

                    let new_total_shares = self
                        .total_shares
                        .safe_mul(new_total_shares_factor.cast()?)?
                        .safe_div(PERCENTAGE_PRECISION)?
                        .max(self.user_shares);

                    if protocol_fee_payment == 0 || self.total_shares == new_total_shares {
                        // time delta wasn't large enough to pay any management/protocol fee
                        skip_ts_update = true;
                    }

                    protocol_fee_shares = new_total_shares
                        .cast::<i128>()?
                        .safe_sub(self.total_shares.cast()?)?;
                    self.total_shares = new_total_shares;
                    vp.protocol_total_fee = vp
                        .protocol_total_fee
                        .saturating_add(protocol_fee_payment.cast()?);
                    vp.protocol_profit_and_fee_shares = vp
                        .protocol_profit_and_fee_shares
                        .safe_add(protocol_fee_shares.cast()?)?;

                    // in case total_shares is pushed to level that warrants a rebase
                    self.apply_rebase(vault_protocol, vault_equity)?;
                } else if self.management_fee != 0 && vp.protocol_fee == 0 && depositor_equity > 0 {
                    handle_no_protocol_fee(self)?;
                }
            }
        }

        if !skip_ts_update {
            self.last_fee_update_ts = now;
        }

        validate!(
            self.total_shares >= self.user_shares,
            ErrorCode::InvalidVaultSharesDetected,
            "total_shares must be >= user_shares"
        )?;

        // this will underflow if there is an issue with protocol fee calc
        self.get_manager_shares(vault_protocol)?;

        Ok(VaultFee {
            management_fee_payment: management_fee_payment.cast::<i64>()?,
            management_fee_shares: management_fee_shares.cast::<i64>()?,
            protocol_fee_payment: protocol_fee_payment.cast::<i64>()?,
            protocol_fee_shares: protocol_fee_shares.cast::<i64>()?,
        })
    }

    pub fn get_manager_shares(
        &self,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
    ) -> VaultResult<u128> {
        Ok(match vault_protocol {
            None => self.total_shares.safe_sub(self.user_shares)?,
            Some(vp) => self
                .total_shares
                .safe_sub(self.user_shares)?
                .safe_sub(vp.protocol_profit_and_fee_shares)?,
        })
    }

    pub fn get_protocol_shares(&self, vault_protocol: &mut Option<RefMut<VaultProtocol>>) -> u128 {
        match vault_protocol {
            None => 0,
            Some(vp) => vp.protocol_profit_and_fee_shares,
        }
    }

    pub fn get_profit_share(&self, vault_protocol: &Option<&VaultProtocol>) -> VaultResult<u32> {
        Ok(match vault_protocol {
            None => self.profit_share,
            Some(vp) => self.profit_share.safe_add(vp.protocol_profit_share)?,
        })
    }

    pub fn apply_rebase(
        &mut self,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        vault_equity: u64,
    ) -> Result<Option<u128>> {
        let mut rebase_divisor = None;
        if vault_equity != 0 && vault_equity.cast::<u128>()? < self.total_shares {
            let (expo_diff, _rebase_divisor) =
                calculate_rebase_info(self.total_shares, vault_equity)?;

            if expo_diff != 0 {
                self.total_shares = self.total_shares.safe_div(_rebase_divisor)?;
                self.user_shares = self.user_shares.safe_div(_rebase_divisor)?;
                self.shares_base = self.shares_base.safe_add(expo_diff)?;
                if let Some(vp) = vault_protocol {
                    vp.protocol_profit_and_fee_shares = vp
                        .protocol_profit_and_fee_shares
                        .safe_div(_rebase_divisor)?;
                }

                if self.last_manager_withdraw_request.shares != 0 {
                    self.last_manager_withdraw_request.rebase(_rebase_divisor)?;
                }

                rebase_divisor = Some(_rebase_divisor);

                msg!("rebasing vault: expo_diff={}", expo_diff);
            }
        }

        if vault_equity != 0 && self.total_shares == 0 {
            self.total_shares = vault_equity.cast::<u128>()?;
        }

        Ok(rebase_divisor)
    }

    pub fn calculate_equity(
        &self,
        user: &User,
        perp_market_map: &PerpMarketMap,
        spot_market_map: &SpotMarketMap,
        oracle_map: &mut OracleMap,
    ) -> VaultResult<u64> {
        let (vault_equity, all_oracles_valid) =
            calculate_user_equity(user, perp_market_map, spot_market_map, oracle_map)?;

        validate!(
            all_oracles_valid,
            ErrorCode::InvalidEquityValue,
            "oracle invalid"
        )?;
        validate!(
            vault_equity >= 0,
            ErrorCode::InvalidEquityValue,
            "vault equity negative"
        )?;

        let spot_market = spot_market_map.get_ref(&self.spot_market_index)?;
        let spot_market_precision = spot_market.get_precision().cast::<i128>()?;
        let oracle_price = oracle_map
            .get_price_data(&spot_market.oracle_id())?
            .price
            .cast::<i128>()?;

        Ok(vault_equity
            .safe_mul(spot_market_precision)?
            .safe_div(oracle_price)?
            .safe_add(self.manager_borrowed_value as i128)?
            .cast::<u64>()?)
    }

    pub fn manager_deposit(
        &mut self,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        amount: u64,
        vault_equity: u64,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<()> {
        self.apply_rebase(vault_protocol, vault_equity)?;
        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = self.apply_fee(vault_protocol, fee_update, vault_equity, now)?;

        let user_vault_shares_before = self.user_shares;
        let total_vault_shares_before = self.total_shares;
        let vault_shares_before: u128 = self.get_manager_shares(vault_protocol)?;
        let protocol_shares_before = self.get_protocol_shares(vault_protocol);

        let n_shares =
            vault_amount_to_depositor_shares(amount, total_vault_shares_before, vault_equity)?;

        self.total_deposits = self.total_deposits.saturating_add(amount);
        self.manager_total_deposits = self.manager_total_deposits.saturating_add(amount);
        self.net_deposits = self.net_deposits.safe_add(amount.cast()?)?;
        self.manager_net_deposits = self.manager_net_deposits.safe_add(amount.cast()?)?;

        self.total_shares = self.total_shares.safe_add(n_shares)?;
        let vault_shares_after = self.get_manager_shares(vault_protocol)?;
        let protocol_shares_after = self.get_protocol_shares(vault_protocol);

        self.emit_vault_depositor_record(
            VaultDepositorRecordParams {
                ts: now,
                action: VaultDepositorAction::Deposit,
                amount: 0,
                depositor_authority: self.manager,
                vault_equity_before: vault_equity,
                vault_shares_before,
                user_vault_shares_before,
                total_vault_shares_before,
                vault_shares_after,
                manager_profit_share: 0,
                management_fee: management_fee_payment,
                management_fee_shares,
                deposit_oracle_price,
            },
            vault_protocol
                .as_mut()
                .map(|_| VaultDepositorRecordProtocolParams {
                    protocol_profit_share: 0,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after,
                    deposit_oracle_price,
                }),
        )?;

        Ok(())
    }

    pub fn check_available_for_liquidation(&self, now: i64) -> VaultResult {
        validate!(
            self.liquidation_delegate == Pubkey::default(),
            ErrorCode::VaultInLiquidation,
            "vault already has liquidation delegate"
        )?;

        validate!(
            now.saturating_sub(self.liquidation_start_ts) > TIME_FOR_LIQUIDATION,
            ErrorCode::VaultInLiquidation,
            "vault is still in liquidation"
        )?;

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn manager_request_withdraw(
        &mut self,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        withdraw_amount: u64,
        withdraw_unit: WithdrawUnit,
        vault_equity: u64,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<()> {
        let rebase_divisor = self.apply_rebase(vault_protocol, vault_equity)?;
        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = self.apply_fee(vault_protocol, fee_update, vault_equity, now)?;

        let vault_shares_before: u128 = self.get_manager_shares(vault_protocol)?;
        let protocol_shares_before = self.get_protocol_shares(vault_protocol);

        let (withdraw_value, n_shares) = withdraw_unit.get_withdraw_value_and_shares(
            withdraw_amount,
            vault_equity,
            self.get_manager_shares(vault_protocol)?,
            self.total_shares,
            rebase_divisor,
        )?;

        validate!(
            n_shares > 0,
            ErrorCode::InvalidVaultWithdrawSize,
            "Requested n_shares = 0"
        )?;
        validate!(
            vault_shares_before >= n_shares,
            ErrorCode::InvalidVaultWithdrawSize,
            "Requested n_shares={} > manager shares={}",
            n_shares,
            vault_shares_before,
        )?;

        let total_vault_shares_before = self.total_shares;
        let user_vault_shares_before = self.user_shares;

        self.last_manager_withdraw_request.set(
            vault_shares_before,
            n_shares,
            withdraw_value,
            vault_equity,
            now,
        )?;
        self.total_withdraw_requested = self.total_withdraw_requested.safe_add(withdraw_value)?;

        let vault_shares_after: u128 = self.get_manager_shares(vault_protocol)?;
        let protocol_shares_after = self.get_protocol_shares(vault_protocol);

        self.emit_vault_depositor_record(
            VaultDepositorRecordParams {
                ts: now,
                action: VaultDepositorAction::WithdrawRequest,
                amount: self.last_manager_withdraw_request.value,
                depositor_authority: self.manager,
                vault_equity_before: vault_equity,
                vault_shares_before,
                user_vault_shares_before,
                total_vault_shares_before,
                vault_shares_after,
                manager_profit_share: 0,
                management_fee: management_fee_payment,
                management_fee_shares,
                deposit_oracle_price,
            },
            Some(VaultDepositorRecordProtocolParams {
                protocol_profit_share: 0,
                protocol_fee: protocol_fee_payment,
                protocol_fee_shares,
                protocol_shares_before,
                protocol_shares_after,
                deposit_oracle_price,
            }),
        )?;

        Ok(())
    }

    pub fn manager_cancel_withdraw_request(
        &mut self,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        vault_equity: u64,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<()> {
        self.apply_rebase(vault_protocol, vault_equity)?;

        let manager_vault_shares_before: u128 = self.get_manager_shares(vault_protocol)?;
        let total_vault_shares_before = self.total_shares;
        let user_vault_shares_before = self.user_shares;
        let protocol_shares_before = self.get_protocol_shares(vault_protocol);

        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = self.apply_fee(vault_protocol, fee_update, vault_equity, now)?;

        let vault_shares_lost = self
            .last_manager_withdraw_request
            .calculate_shares_lost(self, vault_equity)?;

        // only deduct lost shares if manager doesn't own 100% of the vault
        let manager_owns_entire_vault = total_vault_shares_before == manager_vault_shares_before;

        if vault_shares_lost > 0 && !manager_owns_entire_vault {
            self.total_shares = self.total_shares.safe_sub(vault_shares_lost)?;
        }

        let vault_shares_after = self.get_manager_shares(vault_protocol)?;
        let protocol_shares_after = self.get_protocol_shares(vault_protocol);

        self.emit_vault_depositor_record(
            VaultDepositorRecordParams {
                ts: now,
                action: VaultDepositorAction::CancelWithdrawRequest,
                amount: 0,
                depositor_authority: self.manager,
                vault_equity_before: vault_equity,
                vault_shares_before: manager_vault_shares_before,
                user_vault_shares_before,
                total_vault_shares_before,
                vault_shares_after,
                manager_profit_share: 0,
                management_fee: management_fee_payment,
                management_fee_shares,
                deposit_oracle_price,
            },
            Some(VaultDepositorRecordProtocolParams {
                protocol_profit_share: 0,
                protocol_fee: protocol_fee_payment,
                protocol_fee_shares,
                protocol_shares_before,
                protocol_shares_after,
                deposit_oracle_price,
            }),
        )?;

        self.total_withdraw_requested = self
            .total_withdraw_requested
            .safe_sub(self.last_manager_withdraw_request.value)?;
        self.last_manager_withdraw_request.reset(now)?;

        Ok(())
    }

    pub fn manager_withdraw(
        &mut self,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        vault_equity: u64,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<u64> {
        self.last_manager_withdraw_request
            .check_redeem_period_finished(self, now)?;

        self.apply_rebase(vault_protocol, vault_equity)?;

        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = self.apply_fee(vault_protocol, fee_update, vault_equity, now)?;

        let vault_shares_before: u128 = self.get_manager_shares(vault_protocol)?;
        let total_vault_shares_before = self.total_shares;
        let user_vault_shares_before = self.user_shares;
        let protocol_shares_before = self.get_protocol_shares(vault_protocol);

        let n_shares = self.last_manager_withdraw_request.shares;

        validate!(
            n_shares > 0,
            ErrorCode::InvalidVaultWithdraw,
            "No last_withdraw_request.shares found, must call manager_request_withdraw first",
        )?;

        let amount: u64 =
            depositor_shares_to_vault_amount(n_shares, self.total_shares, vault_equity)?;

        let n_tokens = amount.min(self.last_manager_withdraw_request.value);

        validate!(
            vault_shares_before >= n_shares,
            ErrorCode::InsufficientVaultShares
        )?;

        self.total_withdraws = self.total_withdraws.saturating_add(n_tokens);
        self.manager_total_withdraws = self.manager_total_withdraws.saturating_add(n_tokens);
        self.net_deposits = self.net_deposits.safe_sub(n_tokens.cast()?)?;
        self.manager_net_deposits = self.manager_net_deposits.safe_sub(n_tokens.cast()?)?;

        let vault_shares_before = self.get_manager_shares(vault_protocol)?;

        validate!(
            vault_shares_before >= n_shares,
            ErrorCode::InvalidVaultWithdrawSize,
            "vault_shares_before={} < n_shares={}",
            vault_shares_before,
            n_shares
        )?;

        self.total_shares = self.total_shares.safe_sub(n_shares)?;
        let vault_shares_after = self.get_manager_shares(vault_protocol)?;
        let protocol_shares_after = self.get_protocol_shares(vault_protocol);

        self.emit_vault_depositor_record(
            VaultDepositorRecordParams {
                ts: now,
                action: VaultDepositorAction::Withdraw,
                amount: 0,
                depositor_authority: self.manager,
                vault_equity_before: vault_equity,
                vault_shares_before,
                user_vault_shares_before,
                total_vault_shares_before,
                vault_shares_after,
                manager_profit_share: 0,
                management_fee: management_fee_payment,
                management_fee_shares,
                deposit_oracle_price,
            },
            Some(VaultDepositorRecordProtocolParams {
                protocol_profit_share: 0,
                protocol_fee: protocol_fee_payment,
                protocol_fee_shares,
                protocol_shares_before,
                protocol_shares_after,
                deposit_oracle_price,
            }),
        )?;

        self.total_withdraw_requested = self
            .total_withdraw_requested
            .safe_sub(self.last_manager_withdraw_request.value)?;
        self.last_manager_withdraw_request.reset(now)?;

        Ok(n_tokens)
    }

    pub fn in_liquidation(&self) -> bool {
        self.liquidation_delegate != Pubkey::default()
    }

    pub fn check_can_exit_liquidation(&self, now: i64) -> VaultResult {
        validate!(
            now.saturating_sub(self.liquidation_start_ts) > TIME_FOR_LIQUIDATION,
            ErrorCode::VaultInLiquidation,
            "vault is in liquidation"
        )?;

        Ok(())
    }

    pub fn set_liquidation_delegate(&mut self, liquidation_delegate: Pubkey, now: i64) {
        self.liquidation_delegate = liquidation_delegate;
        self.liquidation_start_ts = now;
    }

    pub fn reset_liquidation_delegate(&mut self) {
        self.liquidation_delegate = Pubkey::default();
        self.liquidation_start_ts = 0;
    }

    #[allow(clippy::too_many_arguments)]
    pub fn protocol_request_withdraw(
        &mut self,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        withdraw_amount: u64,
        withdraw_unit: WithdrawUnit,
        vault_equity: u64,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<()> {
        if vault_protocol.is_none() {
            validate!(
                false,
                ErrorCode::VaultProtocolMissing,
                "Protocol cannot request withdraw for a non-protocol vault"
            )?;
        }

        let rebase_divisor = self.apply_rebase(vault_protocol, vault_equity)?;
        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = self.apply_fee(vault_protocol, fee_update, vault_equity, now)?;

        let vault_shares_before: u128 = self.get_manager_shares(vault_protocol)?;
        let protocol_shares_before = self.get_protocol_shares(vault_protocol);

        let (withdraw_value, n_shares) = withdraw_unit.get_withdraw_value_and_shares(
            withdraw_amount,
            vault_equity,
            protocol_shares_before,
            self.total_shares,
            rebase_divisor,
        )?;

        validate!(
            n_shares > 0,
            ErrorCode::InvalidVaultWithdrawSize,
            "Requested n_shares = 0"
        )?;
        validate!(
            protocol_shares_before >= n_shares,
            ErrorCode::InvalidVaultWithdrawSize,
            "Requested n_shares={} > protocol shares={}",
            n_shares,
            protocol_shares_before,
        )?;

        let total_vault_shares_before = self.total_shares;
        let user_vault_shares_before = self.user_shares;

        let vault_shares_after: u128 = self.get_manager_shares(vault_protocol)?;
        let protocol_shares_after = self.get_protocol_shares(vault_protocol);

        if let Some(vp) = vault_protocol {
            vp.last_protocol_withdraw_request.set(
                protocol_shares_before,
                n_shares,
                withdraw_value,
                vault_equity,
                now,
            )?;
            self.total_withdraw_requested =
                self.total_withdraw_requested.safe_add(withdraw_value)?;

            let amount = vp.last_protocol_withdraw_request.value;

            self.emit_vault_depositor_record(
                VaultDepositorRecordParams {
                    ts: now,
                    action: VaultDepositorAction::WithdrawRequest,
                    amount,
                    depositor_authority: vp.protocol,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after,
                    manager_profit_share: 0,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    deposit_oracle_price,
                },
                Some(VaultDepositorRecordProtocolParams {
                    protocol_profit_share: 0,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after,
                    deposit_oracle_price,
                }),
            )?;
        }

        Ok(())
    }

    pub fn protocol_cancel_withdraw_request(
        &mut self,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        vault_equity: u64,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<()> {
        if vault_protocol.is_none() {
            validate!(
                false,
                ErrorCode::VaultProtocolMissing,
                "Protocol cannot cancel withdraw request for a non-protocol vault"
            )?;
        }

        self.apply_rebase(vault_protocol, vault_equity)?;

        let manager_shares_before: u128 = self.get_manager_shares(vault_protocol)?;
        let total_vault_shares_before = self.total_shares;
        let user_vault_shares_before = self.user_shares;
        let protocol_shares_before = self.get_protocol_shares(vault_protocol);

        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = self.apply_fee(vault_protocol, fee_update, vault_equity, now)?;

        let vault_shares_lost = match vault_protocol {
            None => 0,
            Some(vp) => vp
                .last_protocol_withdraw_request
                .calculate_shares_lost(self, vault_equity)?,
        };

        if let Some(vp) = vault_protocol {
            self.total_withdraw_requested = self
                .total_withdraw_requested
                .safe_sub(vp.last_protocol_withdraw_request.value)?;
            vp.last_protocol_withdraw_request.reset(now)?;

            // only deduct lost shares if protocol doesn't own 100% of the vault
            let vp_owns_entire_vault = total_vault_shares_before == protocol_shares_before;

            if vault_shares_lost > 0 && !vp_owns_entire_vault {
                self.total_shares = self.total_shares.safe_sub(vault_shares_lost)?;
                vp.protocol_profit_and_fee_shares = vp
                    .protocol_profit_and_fee_shares
                    .safe_sub(vault_shares_lost)?;
            }

            // get_manager_shares logic but doesn't need Option<RefMut<VaultProtocol>>
            let vault_shares_after = self
                .total_shares
                .safe_sub(self.user_shares)?
                .safe_sub(vp.protocol_profit_and_fee_shares)?;
            // get_protocol_shares logic but doesn't need Option<RefMut<VaultProtocol>>
            let protocol_shares_after = vp.protocol_profit_and_fee_shares;

            self.emit_vault_depositor_record(
                VaultDepositorRecordParams {
                    ts: now,
                    action: VaultDepositorAction::CancelWithdrawRequest,
                    amount: 0,
                    depositor_authority: vp.protocol,
                    vault_equity_before: vault_equity,
                    vault_shares_before: manager_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after,
                    manager_profit_share: 0,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    deposit_oracle_price,
                },
                Some(VaultDepositorRecordProtocolParams {
                    protocol_profit_share: 0,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after,
                    deposit_oracle_price,
                }),
            )?;
        }

        Ok(())
    }

    pub fn protocol_withdraw(
        &mut self,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        vault_equity: u64,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<u64> {
        if vault_protocol.is_none() {
            validate!(
                false,
                ErrorCode::VaultProtocolMissing,
                "Protocol cannot withdraw for a non-protocol vault"
            )?;
        }

        if let Some(vp) = vault_protocol {
            vp.last_protocol_withdraw_request
                .check_redeem_period_finished(self, now)?;
        }

        self.apply_rebase(vault_protocol, vault_equity)?;

        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = self.apply_fee(vault_protocol, fee_update, vault_equity, now)?;

        let vault_shares_before: u128 = self.get_manager_shares(vault_protocol)?;
        let total_vault_shares_before = self.total_shares;
        let user_vault_shares_before = self.user_shares;
        let protocol_shares_before = self.get_protocol_shares(vault_protocol);

        let n_shares = match vault_protocol {
            None => 0,
            Some(vp) => vp.last_protocol_withdraw_request.shares,
        };

        validate!(
            n_shares > 0,
            ErrorCode::InvalidVaultWithdraw,
            "No last_withdraw_request.shares found, must call protocol_request_withdraw first",
        )?;

        let amount: u64 =
            depositor_shares_to_vault_amount(n_shares, self.total_shares, vault_equity)?;

        let n_tokens = match vault_protocol {
            None => amount,
            Some(vp) => amount.min(vp.last_protocol_withdraw_request.value),
        };

        validate!(
            protocol_shares_before >= n_shares,
            ErrorCode::InsufficientVaultShares
        )?;

        self.total_withdraws = self.total_withdraws.saturating_add(n_tokens);
        if let Some(vp) = vault_protocol {
            vp.protocol_total_withdraws = vp.protocol_total_withdraws.saturating_add(n_tokens);
        }
        self.net_deposits = self.net_deposits.safe_sub(n_tokens.cast()?)?;

        self.total_shares = self.total_shares.safe_sub(n_shares)?;

        if let Some(vp) = vault_protocol {
            vp.protocol_profit_and_fee_shares =
                vp.protocol_profit_and_fee_shares.safe_sub(n_shares)?;

            // get_manager_shares but doesn't need Option<RefMut<VaultProtocol>>
            let vault_shares_after = self
                .total_shares
                .safe_sub(self.user_shares)?
                .safe_sub(vp.protocol_profit_and_fee_shares)?;
            // get_protocol_shares but doesn't need Option<RefMut<VaultProtocol>>
            let protocol_shares_after = vp.protocol_profit_and_fee_shares;

            self.emit_vault_depositor_record(
                VaultDepositorRecordParams {
                    ts: now,
                    action: VaultDepositorAction::Withdraw,
                    amount: 0,
                    depositor_authority: vp.protocol,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after,
                    manager_profit_share: 0,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    deposit_oracle_price,
                },
                Some(VaultDepositorRecordProtocolParams {
                    protocol_profit_share: 0,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after,
                    deposit_oracle_price,
                }),
            )?;

            self.total_withdraw_requested = self
                .total_withdraw_requested
                .safe_sub(vp.last_protocol_withdraw_request.value)?;
            vp.last_protocol_withdraw_request.reset(now)?;
        }

        Ok(n_tokens)
    }

    pub fn validate_vault_protocol(&self, vp: &Option<AccountLoader<VaultProtocol>>) -> Result<()> {
        match vp {
            None => {
                if self.vault_protocol {
                    // Vault has VaultProtocol but no rem acct provided.
                    let ec = ErrorCode::VaultProtocolMissing;
                    msg!("Error {} thrown at {}:{}", ec, file!(), line!());
                    msg!("VaultProtocol missing in remaining accounts");
                    Err(anchor_lang::error::Error::from(ec))
                } else {
                    // Vault does not have VaultProtocol and none given in rem accts.
                    Ok(())
                }
            }
            Some(vp) => {
                if self.vault_protocol {
                    // Vault has VaultProtocol and rem accts provided one.
                    // check if PDA matches rem acct given.
                    let (expected, _) = Pubkey::find_program_address(
                        &[b"vault_protocol", self.pubkey.as_ref()],
                        &crate::id(),
                    );
                    let actual = vp.to_account_info().key();
                    if actual != expected {
                        Err(
                            anchor_lang::error::Error::from(error::ErrorCode::ConstraintSeeds)
                                .with_account_name("vault_protocol")
                                .with_pubkeys((actual, expected)),
                        )
                    } else {
                        Ok(())
                    }
                } else {
                    // Vault does not have VaultProtocol, but rem accts provided one
                    let ec = ErrorCode::VaultProtocolMissing;
                    msg!("Error {} thrown at {}:{}", ec, file!(), line!());
                    msg!("Vault does not have VaultProtocol");
                    Err(anchor_lang::error::Error::from(ec))
                }
            }
        }
    }

    pub fn validate_fee_update(&self, fee_update: &Option<AccountLoader<FeeUpdate>>) -> Result<()> {
        let has_fee_update = FeeUpdateStatus::has_pending_fee_update(self.fee_update_status);
        match fee_update {
            None => {
                if has_fee_update {
                    // Vault has FeeUpdate but no rem acct provided.
                    let ec = ErrorCode::FeeUpdateMissing;
                    msg!("Error {} thrown at {}:{}", ec, file!(), line!());
                    msg!("FeeUpdate missing in remaining accounts");
                    Err(anchor_lang::error::Error::from(ec))
                } else {
                    Ok(())
                }
            }
            Some(fee_update) => {
                if has_fee_update {
                    // Vault has FeeUpdate and rem accts provided one.
                    // check if PDA matches rem acct given.
                    let (expected, _) = Pubkey::find_program_address(
                        &[b"fee_update", self.pubkey.as_ref()],
                        &crate::id(),
                    );
                    let actual = fee_update.to_account_info().key();
                    if actual != expected {
                        Err(
                            anchor_lang::error::Error::from(error::ErrorCode::ConstraintSeeds)
                                .with_account_name("fee_update")
                                .with_pubkeys((actual, expected)),
                        )
                    } else {
                        Ok(())
                    }
                } else {
                    // Vault has no FeeUpdate but rem acct provided one.
                    let ec = ErrorCode::FeeUpdateMissing;
                    msg!("Error {} thrown at {}:{}", ec, file!(), line!());
                    msg!("FeeUpdate missing in remaining accounts");
                    Err(anchor_lang::error::Error::from(ec))
                }
            }
        }
    }

    fn emit_vault_depositor_record(
        &self,
        params: VaultDepositorRecordParams,
        optional_params: Option<VaultDepositorRecordProtocolParams>,
    ) -> Result<()> {
        match optional_params {
            None => {
                emit!(VaultDepositorRecord {
                    ts: params.ts,
                    vault: self.pubkey,
                    depositor_authority: params.depositor_authority,
                    action: params.action,
                    amount: params.amount,
                    spot_market_index: self.spot_market_index,
                    vault_equity_before: params.vault_equity_before,
                    vault_shares_before: params.vault_shares_before,
                    user_vault_shares_before: params.user_vault_shares_before,
                    total_vault_shares_before: params.total_vault_shares_before,
                    vault_shares_after: params.vault_shares_after,
                    total_vault_shares_after: self.total_shares,
                    user_vault_shares_after: self.user_shares,
                    profit_share: params.manager_profit_share,
                    management_fee: params.management_fee,
                    management_fee_shares: params.management_fee_shares,
                    deposit_oracle_price: params.deposit_oracle_price,
                });
            }
            Some(protocol_params) => {
                emit!(VaultDepositorV1Record {
                    ts: params.ts,
                    vault: self.pubkey,
                    depositor_authority: params.depositor_authority,
                    action: params.action,
                    amount: params.amount,
                    spot_market_index: self.spot_market_index,
                    vault_equity_before: params.vault_equity_before,
                    vault_shares_before: params.vault_shares_before,
                    user_vault_shares_before: params.user_vault_shares_before,
                    total_vault_shares_before: params.total_vault_shares_before,
                    vault_shares_after: params.vault_shares_after,
                    total_vault_shares_after: self.total_shares,
                    user_vault_shares_after: self.user_shares,
                    manager_profit_share: params.manager_profit_share,
                    management_fee: params.management_fee,
                    management_fee_shares: params.management_fee_shares,

                    protocol_profit_share: protocol_params.protocol_profit_share,
                    protocol_fee: protocol_params.protocol_fee,
                    protocol_fee_shares: protocol_params.protocol_fee_shares,
                    protocol_shares_before: protocol_params.protocol_shares_before,
                    protocol_shares_after: protocol_params.protocol_shares_after,
                    deposit_oracle_price: protocol_params.deposit_oracle_price,
                });
            }
        };
        Ok(())
    }
}

pub enum FeeUpdateStatus {
    None = 0b00000000,
    PendingFeeUpdate = 0b00000001,
}

impl TryFrom<u8> for FeeUpdateStatus {
    type Error = ErrorCode;

    fn try_from(value: u8) -> std::result::Result<Self, ErrorCode> {
        match value {
            0 => Ok(FeeUpdateStatus::None),
            1 => Ok(FeeUpdateStatus::PendingFeeUpdate),
            _ => Err(ErrorCode::InvalidFeeUpdateStatus),
        }
    }
}

impl FeeUpdateStatus {
    pub fn is_none(status: u8) -> bool {
        status & FeeUpdateStatus::None as u8 != 0
    }

    pub fn has_pending_fee_update(status: u8) -> bool {
        status & FeeUpdateStatus::PendingFeeUpdate as u8 != 0
    }
}

pub enum VaultClass {
    Normal = 0b00000000,
    Trusted = 0b00000001,
}

impl TryFrom<u8> for VaultClass {
    type Error = ErrorCode;

    fn try_from(value: u8) -> std::result::Result<Self, ErrorCode> {
        match value {
            0 => Ok(VaultClass::Normal),
            1 => Ok(VaultClass::Trusted),
            _ => Err(ErrorCode::InvalidVaultClass),
        }
    }
}

struct VaultDepositorRecordParams {
    pub ts: i64,
    pub action: VaultDepositorAction,
    pub amount: u64,
    pub depositor_authority: Pubkey,

    pub vault_shares_before: u128,
    pub vault_shares_after: u128,

    pub vault_equity_before: u64,

    pub user_vault_shares_before: u128,
    pub total_vault_shares_before: u128,

    pub manager_profit_share: u64,
    pub management_fee: i64,
    pub management_fee_shares: i64,

    pub deposit_oracle_price: i64,
}

struct VaultDepositorRecordProtocolParams {
    pub protocol_profit_share: u64,
    pub protocol_fee: i64,
    pub protocol_fee_shares: i64,

    pub protocol_shares_before: u128,
    pub protocol_shares_after: u128,

    pub deposit_oracle_price: i64,
}
