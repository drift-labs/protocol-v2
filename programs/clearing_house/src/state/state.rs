use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
#[repr(packed)]
pub struct State {
    pub admin: Pubkey,
    pub exchange_paused: bool,
    pub funding_paused: bool,
    pub admin_controls_prices: bool,
    pub insurance_vault: Pubkey,
    pub insurance_vault_authority: Pubkey,
    pub insurance_vault_nonce: u8,
    pub margin_ratio_initial: u128,
    pub margin_ratio_maintenance: u128,
    pub margin_ratio_partial: u128,
    pub partial_liquidation_close_percentage_numerator: u128,
    pub partial_liquidation_close_percentage_denominator: u128,
    pub partial_liquidation_penalty_percentage_numerator: u128,
    pub partial_liquidation_penalty_percentage_denominator: u128,
    pub full_liquidation_penalty_percentage_numerator: u128,
    pub full_liquidation_penalty_percentage_denominator: u128,
    pub partial_liquidation_liquidator_share_denominator: u64,
    pub full_liquidation_liquidator_share_denominator: u64,
    pub fee_structure: FeeStructure,
    pub whitelist_mint: Pubkey,
    pub discount_mint: Pubkey,
    pub oracle_guard_rails: OracleGuardRails,
    pub number_of_markets: u64,
    pub number_of_banks: u64,
    pub order_filler_reward_structure: OrderFillerRewardStructure,
    pub min_order_quote_asset_amount: u128, // minimum est. quote_asset_amount for place_order to succeed

    // upgrade-ability
    pub padding0: u128,
    pub padding1: u128,
    pub padding2: u128,
    pub padding3: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct OracleGuardRails {
    pub price_divergence: PriceDivergenceGuardRails,
    pub validity: ValidityGuardRails,
    pub use_for_liquidations: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct PriceDivergenceGuardRails {
    pub mark_oracle_divergence_numerator: u128,
    pub mark_oracle_divergence_denominator: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ValidityGuardRails {
    pub slots_before_stale: i64,
    pub confidence_interval_max_size: u128,
    pub too_volatile_ratio: i128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct FeeStructure {
    pub fee_numerator: u128,
    pub fee_denominator: u128,
    pub discount_token_tiers: DiscountTokenTiers,
    pub referral_discount: ReferralDiscount,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct DiscountTokenTiers {
    pub first_tier: DiscountTokenTier,
    pub second_tier: DiscountTokenTier,
    pub third_tier: DiscountTokenTier,
    pub fourth_tier: DiscountTokenTier,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct DiscountTokenTier {
    pub minimum_balance: u64,
    pub discount_numerator: u128,
    pub discount_denominator: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ReferralDiscount {
    pub referrer_reward_numerator: u128,
    pub referrer_reward_denominator: u128,
    pub referee_discount_numerator: u128,
    pub referee_discount_denominator: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct OrderFillerRewardStructure {
    pub reward_numerator: u128,
    pub reward_denominator: u128,
    pub time_based_reward_lower_bound: u128, // minimum filler reward for time-based reward
}
