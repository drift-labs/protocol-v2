use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct User {
    pub authority: Pubkey,
    pub collateral: u128,
    pub cumulative_deposits: i128,
    pub total_fee_paid: u128,
    pub total_drift_token_rebate: u128,
    pub total_referral_reward: u128,
    pub total_referee_rebate: u128,
    pub positions: Pubkey,
}

#[account(zero_copy)]
#[derive(Default)]
pub struct UserPositions {
    pub user: Pubkey,
    pub positions: [MarketPosition; 10],
}

#[zero_copy]
#[derive(Default)]
pub struct MarketPosition {
    pub market_index: u64,
    pub base_asset_amount: i128,
    pub quote_asset_amount: u128,
    pub last_cumulative_funding_rate: i128,
    pub last_cumulative_repeg_rebate: u128,
    pub last_funding_rate_ts: i64,
}
