use crate::math::constants::{
    DEFAULT_DISCOUNT_TOKEN_FIRST_TIER_DISCOUNT_DENOMINATOR,
    DEFAULT_DISCOUNT_TOKEN_FIRST_TIER_DISCOUNT_NUMERATOR,
    DEFAULT_DISCOUNT_TOKEN_FIRST_TIER_MINIMUM_BALANCE,
    DEFAULT_DISCOUNT_TOKEN_FOURTH_TIER_DISCOUNT_DENOMINATOR,
    DEFAULT_DISCOUNT_TOKEN_FOURTH_TIER_DISCOUNT_NUMERATOR,
    DEFAULT_DISCOUNT_TOKEN_FOURTH_TIER_MINIMUM_BALANCE,
    DEFAULT_DISCOUNT_TOKEN_SECOND_TIER_DISCOUNT_DENOMINATOR,
    DEFAULT_DISCOUNT_TOKEN_SECOND_TIER_DISCOUNT_NUMERATOR,
    DEFAULT_DISCOUNT_TOKEN_SECOND_TIER_MINIMUM_BALANCE,
    DEFAULT_DISCOUNT_TOKEN_THIRD_TIER_DISCOUNT_DENOMINATOR,
    DEFAULT_DISCOUNT_TOKEN_THIRD_TIER_DISCOUNT_NUMERATOR,
    DEFAULT_DISCOUNT_TOKEN_THIRD_TIER_MINIMUM_BALANCE, DEFAULT_FEE_DENOMINATOR,
    DEFAULT_FEE_NUMERATOR, DEFAULT_REFEREE_DISCOUNT_DENOMINATOR,
    DEFAULT_REFEREE_DISCOUNT_NUMERATOR, DEFAULT_REFERRER_REWARD_DENOMINATOR,
    DEFAULT_REFERRER_REWARD_NUMERATOR,
};
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
    pub min_order_quote_asset_amount: u128, // minimum est. quote_asset_amount for place_order to succeed
    pub min_auction_duration: u8,
    pub max_auction_duration: u8,
    pub liquidation_margin_buffer_ratio: u8,

    // upgrade-ability
    pub padding0: u128,
    pub padding1: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OracleGuardRails {
    pub price_divergence: PriceDivergenceGuardRails,
    pub validity: ValidityGuardRails,
    pub use_for_liquidations: bool,
}

impl Default for OracleGuardRails {
    fn default() -> Self {
        OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale: 1000,
                confidence_interval_max_size: 4,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
        }
    }
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FeeStructure {
    pub fee_numerator: u128,
    pub fee_denominator: u128,
    pub discount_token_tiers: DiscountTokenTiers,
    pub referral_discount: ReferralDiscount,
    pub maker_rebate_numerator: u128,
    pub maker_rebate_denominator: u128,
    pub filler_reward_structure: OrderFillerRewardStructure,
    pub cancel_order_fee: u128,
}

impl Default for FeeStructure {
    fn default() -> Self {
        FeeStructure {
            fee_numerator: DEFAULT_FEE_NUMERATOR,
            fee_denominator: DEFAULT_FEE_DENOMINATOR,
            maker_rebate_numerator: 3, // 60% of taker fee
            maker_rebate_denominator: 5,
            discount_token_tiers: DiscountTokenTiers {
                first_tier: DiscountTokenTier {
                    minimum_balance: DEFAULT_DISCOUNT_TOKEN_FIRST_TIER_MINIMUM_BALANCE,
                    discount_numerator: DEFAULT_DISCOUNT_TOKEN_FIRST_TIER_DISCOUNT_NUMERATOR,
                    discount_denominator: DEFAULT_DISCOUNT_TOKEN_FIRST_TIER_DISCOUNT_DENOMINATOR,
                },
                second_tier: DiscountTokenTier {
                    minimum_balance: DEFAULT_DISCOUNT_TOKEN_SECOND_TIER_MINIMUM_BALANCE,
                    discount_numerator: DEFAULT_DISCOUNT_TOKEN_SECOND_TIER_DISCOUNT_NUMERATOR,
                    discount_denominator: DEFAULT_DISCOUNT_TOKEN_SECOND_TIER_DISCOUNT_DENOMINATOR,
                },
                third_tier: DiscountTokenTier {
                    minimum_balance: DEFAULT_DISCOUNT_TOKEN_THIRD_TIER_MINIMUM_BALANCE,
                    discount_numerator: DEFAULT_DISCOUNT_TOKEN_THIRD_TIER_DISCOUNT_NUMERATOR,
                    discount_denominator: DEFAULT_DISCOUNT_TOKEN_THIRD_TIER_DISCOUNT_DENOMINATOR,
                },
                fourth_tier: DiscountTokenTier {
                    minimum_balance: DEFAULT_DISCOUNT_TOKEN_FOURTH_TIER_MINIMUM_BALANCE,
                    discount_numerator: DEFAULT_DISCOUNT_TOKEN_FOURTH_TIER_DISCOUNT_NUMERATOR,
                    discount_denominator: DEFAULT_DISCOUNT_TOKEN_FOURTH_TIER_DISCOUNT_DENOMINATOR,
                },
            },
            referral_discount: ReferralDiscount {
                referrer_reward_numerator: DEFAULT_REFERRER_REWARD_NUMERATOR,
                referrer_reward_denominator: DEFAULT_REFERRER_REWARD_DENOMINATOR,
                referee_discount_numerator: DEFAULT_REFEREE_DISCOUNT_NUMERATOR,
                referee_discount_denominator: DEFAULT_REFEREE_DISCOUNT_DENOMINATOR,
            },
            filler_reward_structure: OrderFillerRewardStructure {
                reward_numerator: 1,
                reward_denominator: 10,
                time_based_reward_lower_bound: 10_000, // 1 cent
            },
            cancel_order_fee: 10_000,
        }
    }
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
