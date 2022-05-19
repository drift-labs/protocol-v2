use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
#[repr(packed)]
pub struct SettlementState {
    pub total_settlement_value: u64,
    pub collateral_available_to_claim: u64,
    pub collateral_claimed: u64,
    pub enabled: bool,
}
