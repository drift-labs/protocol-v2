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
#[derive(Default)]
pub struct UserPositions {
    pub user: Pubkey,
    pub positions: [MarketPosition; 5],
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
    pub open_orders: u128,

    // upgrade-ability
    pub padding0: u128,
    pub padding1: u128,
    pub padding2: u128,
    pub padding3: u128,
    pub padding4: u128,
    pub padding5: u128,
    pub padding6: u128,
}

impl MarketPosition {
    pub fn is_for(&self, market_index: u64) -> bool {
        self.market_index == market_index && (self.is_open_position() || self.has_open_order())
    }

    pub fn is_available(&self) -> bool {
        !self.is_open_position() && !self.has_open_order()
    }

    pub fn is_open_position(&self) -> bool {
        self.base_asset_amount != 0
    }

    pub fn has_open_order(&self) -> bool {
        self.open_orders != 0
    }
}
