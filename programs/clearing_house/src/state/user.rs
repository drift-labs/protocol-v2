use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct User { // 168
    // anchor discriminator 8
    pub authority: Pubkey, // 32
    pub collateral: u128, // 16
    pub cumulative_deposits: i128, // 16
    pub total_fee_paid: u128, // 16
    pub total_drift_token_rebate: u128, // 16
    pub total_referral_reward: u128, // 16
    pub total_referee_rebate: u128, // 16
    pub positions: Pubkey, // 32
}

pub const PADDED_USER_SIZE : usize = 168 + 128;

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
