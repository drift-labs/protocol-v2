use crate::state::oracle::OracleSource;
use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct Bank {
    pub bank_index: u64,
    pub pubkey: Pubkey,
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
    pub oracle: Pubkey,
    pub oracle_source: OracleSource,
    pub initial_asset_weight: u128,
    pub maintenance_asset_weight: u128,
}
