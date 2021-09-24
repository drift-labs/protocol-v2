use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct UserAccount {
    pub authority: Pubkey,
    pub collateral: u128,
    pub initial_purchase: i128,
    pub total_potential_fee: i128,
    pub positions: Pubkey,
}

#[account(zero_copy)]
#[derive(Default)]
pub struct UserPositionsAccount {
    pub user_account: Pubkey,
    pub positions: [MarketPosition; 10],
}

#[zero_copy]
#[derive(Default)]
pub struct MarketPosition {
    pub market_index: u64,
    pub base_asset_amount: i128,
    pub quote_asset_notional_amount: u128,
    pub last_cum_funding: i128,
    pub last_cum_repeg_profit: u128,
    pub last_funding_ts: i64,
}
