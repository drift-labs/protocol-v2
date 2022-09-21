use anchor_lang::prelude::*;

use crate::math::constants::{MAX_REFERRER_REWARD_EPOCH_UPPER_BOUND, ONE_BPS_DENOMINATOR};

#[account]
#[derive(Default)]
#[repr(packed)]
pub struct State {
    pub admin: Pubkey,
    pub exchange_paused: bool,
    pub funding_paused: bool,
    pub admin_controls_prices: bool,
    pub insurance_vault: Pubkey,
    pub whitelist_mint: Pubkey,
    pub discount_mint: Pubkey,
    pub oracle_guard_rails: OracleGuardRails,
    pub number_of_markets: u64,
    pub number_of_spot_markets: u64,
    pub min_order_quote_asset_amount: u128, // minimum est. quote_asset_amount for place_order to succeed
    pub min_perp_auction_duration: u8,
    pub default_market_order_time_in_force: u8,
    pub default_spot_auction_duration: u8,
    pub liquidation_margin_buffer_ratio: u32,
    pub settlement_duration: u16,
    pub signer: Pubkey,
    pub signer_nonce: u8,
    pub perp_fee_structure: FeeStructure,
    pub spot_fee_structure: FeeStructure,
}

#[derive(Copy, AnchorSerialize, AnchorDeserialize, Clone)]
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
                slots_before_stale_for_amm: 10,      // 5s
                slots_before_stale_for_margin: 120,  // 60s              // ~5 seconds
                confidence_interval_max_size: 20000, // 2% of price
                too_volatile_ratio: 5,               // 5x or 80% down
            },
            use_for_liquidations: true,
        }
    }
}

#[derive(Copy, AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct PriceDivergenceGuardRails {
    pub mark_oracle_divergence_numerator: u128,
    pub mark_oracle_divergence_denominator: u128,
}

#[derive(Copy, AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ValidityGuardRails {
    pub slots_before_stale_for_amm: i64,
    pub slots_before_stale_for_margin: i64,
    pub confidence_interval_max_size: u128,
    pub too_volatile_ratio: i128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FeeStructure {
    pub fee_tiers: [FeeTier; 10],
    pub filler_reward_structure: OrderFillerRewardStructure,
    pub referrer_reward_epoch_upper_bound: u64,
    pub flat_filler_fee: u128,
}

impl Default for FeeStructure {
    fn default() -> Self {
        FeeStructure::perps_default()
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone)]
pub struct FeeTier {
    pub fee_numerator: u32,
    pub fee_denominator: u32,
    pub maker_rebate_numerator: u32,
    pub maker_rebate_denominator: u32,
    pub referrer_reward_numerator: u32,
    pub referrer_reward_denominator: u32,
    pub referee_fee_numerator: u32,
    pub referee_fee_denominator: u32,
}

impl Default for FeeTier {
    fn default() -> Self {
        FeeTier {
            fee_numerator: 0,
            fee_denominator: 1,
            maker_rebate_numerator: 0,
            maker_rebate_denominator: 1,
            referrer_reward_numerator: 0,
            referrer_reward_denominator: 1,
            referee_fee_numerator: 0,
            referee_fee_denominator: 1,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Default, Clone)]
pub struct OrderFillerRewardStructure {
    pub reward_numerator: u128,
    pub reward_denominator: u128,
    pub time_based_reward_lower_bound: u128, // minimum filler reward for time-based reward
}

impl FeeStructure {
    pub fn perps_default() -> Self {
        let mut fee_tiers = [FeeTier::default(); 10];
        fee_tiers[0] = FeeTier {
            fee_numerator: 10,
            fee_denominator: ONE_BPS_DENOMINATOR, // 10 bps
            maker_rebate_numerator: 2,
            maker_rebate_denominator: ONE_BPS_DENOMINATOR, // 2bps
            referrer_reward_numerator: 15,
            referrer_reward_denominator: 100, // 15% of taker fee
            referee_fee_numerator: 5,
            referee_fee_denominator: 100, // 5%
        };
        fee_tiers[1] = FeeTier {
            fee_numerator: 8,
            fee_denominator: ONE_BPS_DENOMINATOR, // 8 bps
            maker_rebate_numerator: 2,
            maker_rebate_denominator: ONE_BPS_DENOMINATOR, // 2bps
            referrer_reward_numerator: 15,
            referrer_reward_denominator: 100, // 15% of taker fee
            referee_fee_numerator: 5,
            referee_fee_denominator: 100, // 5%
        };
        fee_tiers[2] = FeeTier {
            fee_numerator: 6,
            fee_denominator: ONE_BPS_DENOMINATOR, // 6 bps
            maker_rebate_numerator: 2,
            maker_rebate_denominator: ONE_BPS_DENOMINATOR, // 2bps
            referrer_reward_numerator: 15,
            referrer_reward_denominator: 100, // 15% of taker fee
            referee_fee_numerator: 5,
            referee_fee_denominator: 100, // 5%
        };
        fee_tiers[3] = FeeTier {
            fee_numerator: 5,
            fee_denominator: ONE_BPS_DENOMINATOR, // 5 bps
            maker_rebate_numerator: 2,
            maker_rebate_denominator: ONE_BPS_DENOMINATOR, // 2bps
            referrer_reward_numerator: 15,
            referrer_reward_denominator: 100, // 15% of taker fee
            referee_fee_numerator: 5,
            referee_fee_denominator: 100, // 5%
        };
        fee_tiers[4] = FeeTier {
            fee_numerator: 4,
            fee_denominator: ONE_BPS_DENOMINATOR, // 4 bps
            maker_rebate_numerator: 2,
            maker_rebate_denominator: ONE_BPS_DENOMINATOR, // 2bps
            referrer_reward_numerator: 15,
            referrer_reward_denominator: 100, // 15% of taker fee
            referee_fee_numerator: 5,
            referee_fee_denominator: 100, // 5%
        };
        fee_tiers[5] = FeeTier {
            fee_numerator: 35,
            fee_denominator: 10 * ONE_BPS_DENOMINATOR, // 3.5 bps
            maker_rebate_numerator: 2,
            maker_rebate_denominator: ONE_BPS_DENOMINATOR, // 2bps
            referrer_reward_numerator: 15,
            referrer_reward_denominator: 100, // 15% of taker fee
            referee_fee_numerator: 5,
            referee_fee_denominator: 100, // 5%
        };
        FeeStructure {
            fee_tiers,
            filler_reward_structure: OrderFillerRewardStructure {
                reward_numerator: 1,
                reward_denominator: 10,
                time_based_reward_lower_bound: 10_000, // 1 cent
            },
            flat_filler_fee: 10_000,
            referrer_reward_epoch_upper_bound: MAX_REFERRER_REWARD_EPOCH_UPPER_BOUND,
        }
    }

    pub fn spot_default() -> Self {
        let mut fee_tiers = [FeeTier::default(); 10];
        fee_tiers[0] = FeeTier {
            fee_numerator: 10,
            fee_denominator: ONE_BPS_DENOMINATOR, // 10 bps
            maker_rebate_numerator: 2,
            maker_rebate_denominator: ONE_BPS_DENOMINATOR, // 2bps
            referrer_reward_numerator: 0,
            referrer_reward_denominator: 1, // 0% of taker fee
            referee_fee_numerator: 0,
            referee_fee_denominator: 1, // 0%
        };
        FeeStructure {
            fee_tiers,
            filler_reward_structure: OrderFillerRewardStructure {
                reward_numerator: 1,
                reward_denominator: 10,
                time_based_reward_lower_bound: 10_000, // 1 cent
            },
            flat_filler_fee: 10_000,
            referrer_reward_epoch_upper_bound: MAX_REFERRER_REWARD_EPOCH_UPPER_BOUND,
        }
    }
}

#[cfg(test)]
impl FeeStructure {
    pub fn test_default() -> Self {
        let mut fee_tiers = [FeeTier::default(); 10];
        fee_tiers[0] = FeeTier {
            fee_numerator: 10,
            fee_denominator: ONE_BPS_DENOMINATOR,
            maker_rebate_numerator: 6,
            maker_rebate_denominator: ONE_BPS_DENOMINATOR,
            referrer_reward_numerator: 1,
            referrer_reward_denominator: 10,
            referee_fee_numerator: 1,
            referee_fee_denominator: 10,
        };
        FeeStructure {
            fee_tiers,
            filler_reward_structure: OrderFillerRewardStructure {
                reward_numerator: 1,
                reward_denominator: 10,
                time_based_reward_lower_bound: 10_000, // 1 cent
            },
            ..FeeStructure::perps_default()
        }
    }
}
