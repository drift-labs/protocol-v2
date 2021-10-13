use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct State { // 1030
    // anchor discriminator 8
    pub admin: Pubkey, // 1
    pub exchange_paused: bool, // 1
    pub funding_paused: bool, // 1
    pub admin_controls_prices: bool, // 1
    pub collateral_mint: Pubkey, // 32
    pub collateral_vault: Pubkey, // 32
    pub collateral_vault_authority: Pubkey, // 32
    pub collateral_vault_nonce: u8, // 1
    pub deposit_history: Pubkey, // 32
    pub trade_history: Pubkey, // 32
    pub funding_payment_history: Pubkey, // 32
    pub funding_rate_history: Pubkey, // 32
    pub liquidation_history: Pubkey, // 32
    pub curve_history: Pubkey, // 32
    pub insurance_vault: Pubkey, // 32
    pub insurance_vault_authority: Pubkey, // 32
    pub insurance_vault_nonce: u8, // 1
    pub markets: Pubkey, // 32
    pub margin_ratio_initial: u128, // 16
    pub margin_ratio_maintenance: u128, // 16
    pub margin_ratio_partial: u128, // 16
    pub partial_liquidation_close_percentage_numerator: u128, // 16
    pub partial_liquidation_close_percentage_denominator: u128, // 16
    pub partial_liquidation_penalty_percentage_numerator: u128, // 16
    pub partial_liquidation_penalty_percentage_denominator: u128, // 16
    pub full_liquidation_penalty_percentage_numerator: u128, // 16
    pub full_liquidation_penalty_percentage_denominator: u128, // 16
    pub partial_liquidation_liquidator_share_denominator: u64, // 16
    pub full_liquidation_liquidator_share_denominator: u64, // 16
    pub fee_structure: FeeStructure, // 256
    pub fees_collected: u128, // 16
    pub fees_withdrawn: u128, // 16
    pub whitelist_mint: Pubkey, // 32
    pub drift_mint: Pubkey, // 32
    pub oracle_guard_rails: OracleGuardRails, // 73
    pub max_deposit: u128, // 16
}

pub const PADDED_CLEARING_HOUSE_SIZE : usize = 1030 + 512;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct OracleGuardRails { // 73
    pub price_divergence: PriceDivergenceGuardRails, // 32
    pub validity: ValidityGuardRails, // 40
    pub use_for_liquidations: bool, // 1
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct PriceDivergenceGuardRails { // 32
    pub mark_oracle_divergence_numerator: u128, // 16
    pub mark_oracle_divergence_denominator: u128, // 16
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ValidityGuardRails { // 40
    pub slots_before_stale: i64, // 8
    pub confidence_interval_max_size: u128, // 16
    pub too_volatile_ratio: i128, // 16
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct FeeStructure { // 256
    pub fee_numerator: u128, // 16
    pub fee_denominator: u128, // 16
    pub drift_token_rebate: DriftTokenRebate, // 160
    pub referral_rebate: ReferralRebate, // 64
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct DriftTokenRebate { // 160
    pub first_tier: DriftTokenRebateTier, // 40
    pub second_tier: DriftTokenRebateTier, // 40
    pub third_tier: DriftTokenRebateTier, // 40
    pub fourth_tier: DriftTokenRebateTier, // 40
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct DriftTokenRebateTier { // 40
    pub minimum_balance: u64, // 8
    pub rebate_numerator: u128, // 16
    pub rebate_denominator: u128, // 16
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ReferralRebate { // 64
    pub referrer_reward_numerator: u128, // 16
    pub referrer_reward_denominator: u128, // 16
    pub referee_rebate_numerator: u128, // 16
    pub referee_rebate_denominator: u128, // 16
}
