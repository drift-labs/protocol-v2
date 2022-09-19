use crate::math::constants::{MAX_REFERRER_REWARD_EPOCH_UPPER_BOUND, ONE_BPS_DENOMINATOR};
use anchor_lang::prelude::*;

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
            fee_denominator: ONE_BPS_DENOMINATOR,
            maker_rebate_numerator: 2,
            maker_rebate_denominator: ONE_BPS_DENOMINATOR,
            referrer_reward_numerator: 5,
            referrer_reward_denominator: 10 * ONE_BPS_DENOMINATOR,
            referee_fee_numerator: 95,
            referee_fee_denominator: 10 * ONE_BPS_DENOMINATOR,
        };
        FeeStructure {
            fee_tiers,
            filler_reward_structure: OrderFillerRewardStructure {
                reward_numerator: 1,
                reward_denominator: ONE_BPS_DENOMINATOR as u128,
                time_based_reward_lower_bound: 10_000, // 1 cent
            },
            flat_filler_fee: 10_000,
            referrer_reward_epoch_upper_bound: MAX_REFERRER_REWARD_EPOCH_UPPER_BOUND,
        }
    }

    pub fn spot_default() -> Self {
        Self::perps_default()
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
            referrer_reward_denominator: ONE_BPS_DENOMINATOR,
            referee_fee_numerator: 9,
            referee_fee_denominator: ONE_BPS_DENOMINATOR,
        };
        FeeStructure {
            fee_tiers,
            filler_reward_structure: OrderFillerRewardStructure {
                reward_numerator: 1,
                reward_denominator: ONE_BPS_DENOMINATOR as u128,
                time_based_reward_lower_bound: 10_000, // 1 cent
            },
            ..FeeStructure::perps_default()
        }
    }
}
