use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct User {
    pub authority: Pubkey,
    pub collateral: u128,
    pub cumulative_deposits: i128,
    pub total_fee_paid: u128,
    pub total_token_discount: u128,
    pub total_referral_reward: u128,
    pub total_referee_discount: u128,
    pub positions: Pubkey,

    // upgrade-ability
    pub padding0: u128,
    pub padding1: u128,
    pub padding2: u128,
    pub padding3: u128,
}

#[account(zero_copy)]
pub struct UserPositions {
    pub user: Pubkey,
    pub positions: [MarketPosition; 5],
}

impl Default for UserPositions {
    fn default() -> Self {
        return Self {
            user: Pubkey::default(),
            positions: [MarketPosition::default(); 5],
        };
    }
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
    pub stop_loss_price: u128,
    pub stop_loss_amount: u128,
    pub stop_profit_price: u128,
    pub stop_profit_amount: u128,
    pub transfer_to: Pubkey,

    // upgrade-ability
    pub padding0: u128,
    pub padding1: u128,
}

impl MarketPosition {
    pub fn is_for(&self, market_index: u64) -> bool {
        return self.market_index == market_index && self.is_open_position();
    }

    pub fn is_open_position(&self) -> bool {
        return self.base_asset_amount != 0;
    }
}
