use std::fmt;
use std::fmt::{Display, Formatter};

use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

use crate::error::ClearingHouseResult;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, BANK_WEIGHT_PRECISION, LIQUIDATION_FEE_PRECISION,
};
use crate::math::margin::{
    calculate_size_discount_asset_weight, calculate_size_premium_liability_weight,
    MarginRequirementType,
};
use crate::math_error;
use crate::state::oracle::OracleSource;
use solana_program::msg;

#[account(zero_copy)]
#[derive(Default)]
#[repr(packed)]
pub struct Bank {
    pub bank_index: u64,
    pub pubkey: Pubkey,
    pub oracle: Pubkey,
    pub oracle_source: OracleSource,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub vault_authority: Pubkey,
    pub vault_authority_nonce: u8,
    pub decimals: u8,
    pub optimal_utilization: u128,
    pub optimal_borrow_rate: u128,
    pub max_borrow_rate: u128,
    pub deposit_balance: u128,
    pub borrow_balance: u128,
    pub deposit_token_twap: u128, // 24 hour twap
    pub borrow_token_twap: u128,  // 24 hour twap
    pub utilization_twap: u128,   // 24 hour twap
    pub cumulative_deposit_interest: u128,
    pub cumulative_borrow_interest: u128,
    pub last_updated: u64,
    pub initial_asset_weight: u128,
    pub maintenance_asset_weight: u128,
    pub initial_liability_weight: u128,
    pub maintenance_liability_weight: u128,
    pub imf_factor: u128,
    pub liquidation_fee: u128,
    pub withdraw_guard_threshold: u128, // no withdraw limits/guards when bank deposits below this threshold
}

impl Bank {
    pub fn get_asset_weight(
        &self,
        size: u128,
        margin_requirement_type: &MarginRequirementType,
    ) -> ClearingHouseResult<u128> {
        let size_precision = 10_u128.pow(self.decimals as u32);

        let size_in_amm_reserve_precision = if size_precision > AMM_RESERVE_PRECISION {
            size / (size_precision / AMM_RESERVE_PRECISION)
        } else {
            (size * AMM_RESERVE_PRECISION) / size_precision
        };
        let asset_weight = match margin_requirement_type {
            MarginRequirementType::Initial => calculate_size_discount_asset_weight(
                size_in_amm_reserve_precision,
                self.imf_factor,
                self.initial_asset_weight,
            )?,
            MarginRequirementType::Maintenance => self.maintenance_asset_weight,
        };
        Ok(asset_weight)
    }

    pub fn get_liability_weight(
        &self,
        size: u128,
        margin_requirement_type: &MarginRequirementType,
    ) -> ClearingHouseResult<u128> {
        let size_precision = 10_u128.pow(self.decimals as u32);

        let size_in_amm_reserve_precision = if size_precision > AMM_RESERVE_PRECISION {
            size / (size_precision / AMM_RESERVE_PRECISION)
        } else {
            (size * AMM_RESERVE_PRECISION) / size_precision
        };

        let liability_weight = match margin_requirement_type {
            MarginRequirementType::Initial => calculate_size_premium_liability_weight(
                size_in_amm_reserve_precision,
                self.imf_factor,
                self.initial_liability_weight,
                BANK_WEIGHT_PRECISION,
            )?,
            MarginRequirementType::Maintenance => self.maintenance_liability_weight,
        };

        Ok(liability_weight)
    }

    pub fn get_liquidation_fee_multiplier(
        &self,
        balance_type: BankBalanceType,
    ) -> ClearingHouseResult<u128> {
        match balance_type {
            BankBalanceType::Deposit => LIQUIDATION_FEE_PRECISION
                .checked_add(self.liquidation_fee)
                .ok_or_else(math_error!()),
            BankBalanceType::Borrow => LIQUIDATION_FEE_PRECISION
                .checked_sub(self.liquidation_fee)
                .ok_or_else(math_error!()),
        }
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Eq, Debug)]
pub enum BankBalanceType {
    Deposit,
    Borrow,
}

impl Display for BankBalanceType {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        match self {
            BankBalanceType::Deposit => write!(f, "BankBalanceType::Deposit"),
            BankBalanceType::Borrow => write!(f, "BankBalanceType::Borrow"),
        }
    }
}

impl Default for BankBalanceType {
    fn default() -> Self {
        BankBalanceType::Deposit
    }
}

pub trait BankBalance {
    fn balance_type(&self) -> &BankBalanceType;

    fn balance(&self) -> u128;

    fn increase_balance(&mut self, delta: u128) -> ClearingHouseResult;

    fn decrease_balance(&mut self, delta: u128) -> ClearingHouseResult;

    fn update_balance_type(&mut self, balance_type: BankBalanceType) -> ClearingHouseResult;
}
