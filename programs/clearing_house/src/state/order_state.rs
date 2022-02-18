use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct OrderState {
    pub order_history: Pubkey,
    pub order_filler_reward_structure: OrderFillerRewardStructure,
    pub min_order_quote_asset_amount: u128, // minimum est. quote_asset_amount for place_order to succeed
    pub padding: [u128; 10],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct OrderFillerRewardStructure {
    pub reward_numerator: u128,
    pub reward_denominator: u128,
    pub time_based_reward_lower_bound: u128, // minimum filler reward for time-based reward
}
