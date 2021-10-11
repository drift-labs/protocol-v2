use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct State {
    pub admin: Pubkey,
    pub exchange_paused: bool,
    pub admin_controls_prices: bool,
    pub collateral_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub collateral_vault_authority: Pubkey,
    pub collateral_vault_nonce: u8,
    pub deposit_history: Pubkey,
    pub trade_history: Pubkey,
    pub funding_payment_history: Pubkey,
    pub funding_rate_history: Pubkey,
    pub liquidation_history: Pubkey,
    pub curve_history: Pubkey,
    pub insurance_vault: Pubkey,
    pub insurance_vault_authority: Pubkey,
    pub insurance_vault_nonce: u8,
    pub markets: Pubkey,
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
    pub collateral_deposits: u128,
    pub fees_collected: u128,
    pub fees_withdrawn: u128,
    pub whitelist_mint: Pubkey,
    pub drift_mint: Pubkey,
    pub oracle_guard_rails: OracleGuardRails,
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
    pub drift_token_rebate: DriftTokenRebate,
    pub referral_rebate: ReferralRebate,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct DriftTokenRebate {
    pub first_tier: DriftTokenRebateTier,
    pub second_tier: DriftTokenRebateTier,
    pub third_tier: DriftTokenRebateTier,
    pub fourth_tier: DriftTokenRebateTier,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct DriftTokenRebateTier {
    pub minimum_balance: u64,
    pub rebate_numerator: u128,
    pub rebate_denominator: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ReferralRebate {
    pub referrer_reward_numerator: u128,
    pub referrer_reward_denominator: u128,
    pub referee_rebate_numerator: u128,
    pub referee_rebate_denominator: u128,
}
