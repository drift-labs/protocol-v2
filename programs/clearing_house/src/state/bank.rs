use std::cmp::min;
use std::fmt;
use std::fmt::{Display, Formatter};

use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use num_integer::Roots;

use crate::error::ClearingHouseResult;
use crate::math::constants::{BANK_IMF_PRECISION, BANK_WEIGHT_PRECISION};
use crate::math::margin::MarginRequirementType;
use crate::math_error;
use crate::state::oracle::OracleSource;

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
    pub cumulative_deposit_interest: u128,
    pub cumulative_borrow_interest: u128,
    pub last_updated: u64,
    pub initial_asset_weight: u128,
    pub maintenance_asset_weight: u128,
    pub initial_liability_weight: u128,
    pub maintenance_liability_weight: u128,
    pub imf_factor: u128,
}

impl Bank {
    pub fn get_asset_weight(
        &self,
        size: u128,
        margin_requirement_type: &MarginRequirementType,
    ) -> ClearingHouseResult<u128> {
        let mut asset_weight = match margin_requirement_type {
            MarginRequirementType::Initial => self.initial_asset_weight,
            MarginRequirementType::Partial => self.maintenance_asset_weight,
            MarginRequirementType::Maintenance => self.maintenance_asset_weight,
        };

        if self.imf_factor > 0 {
            let size_sqrt = (size / 1000).nth_root(2); //1e13 -> 1e10 -> 1e5
            let imf_numerator = BANK_IMF_PRECISION + BANK_IMF_PRECISION / 10;

            let size_discounted_asset_weight = imf_numerator
                .checked_mul(BANK_WEIGHT_PRECISION)
                .ok_or_else(math_error!())?
                .checked_div(
                    BANK_IMF_PRECISION
                        .checked_add(
                            size_sqrt // 1e5
                                .checked_mul(self.imf_factor)
                                .ok_or_else(math_error!())?
                                .checked_div(100_000) // 1e5
                                .ok_or_else(math_error!())?,
                        )
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?;

            asset_weight = min(asset_weight, size_discounted_asset_weight);
        }

        Ok(asset_weight)
    }

    pub fn get_liability_weight(&self, margin_requirement_type: &MarginRequirementType) -> u128 {
        match margin_requirement_type {
            MarginRequirementType::Initial => self.initial_liability_weight,
            MarginRequirementType::Partial => self.maintenance_liability_weight,
            MarginRequirementType::Maintenance => self.maintenance_liability_weight,
        }
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
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
