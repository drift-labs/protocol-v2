use crate::math::margin::MarginRequirementType;
use crate::state::oracle::OracleSource;
use anchor_lang::prelude::*;

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
}

impl Bank {
    pub fn get_asset_weight(&self, margin_requirement_type: &MarginRequirementType) -> u128 {
        match margin_requirement_type {
            MarginRequirementType::Initial => self.initial_asset_weight,
            MarginRequirementType::Partial => self.maintenance_asset_weight,
            MarginRequirementType::Maintenance => self.maintenance_asset_weight,
        }
    }

    pub fn get_liability_weight(&self, margin_requirement_type: &MarginRequirementType) -> u128 {
        match margin_requirement_type {
            MarginRequirementType::Initial => self.initial_liability_weight,
            MarginRequirementType::Partial => self.maintenance_liability_weight,
            MarginRequirementType::Maintenance => self.maintenance_liability_weight,
        }
    }
}
