use crate::math::constants::ONE_BPS_DENOMINATOR;

pub struct FeeStructure2 {
    pub first_tier: FeeTier,
    pub second_tier: FeeTier,
    pub third_tier: FeeTier,
    pub fourth_tier: FeeTier,
    pub filler_reward_structure: OrderFillerRewardStructure,
    pub flat_filler_fee: u128,
}

#[derive(Default)]
pub struct FeeTier {
    pub fee_numerator: u128,
    pub fee_denominator: u128,
    pub maker_rebate_numerator: u128,
    pub maker_rebate_denominator: u128,
    pub referrer_reward_numerator: u128,
    pub referrer_reward_denominator: u128,
    pub referee_fee_numerator: u128,
    pub referee_fee_denominator: u128,
}

pub struct OrderFillerRewardStructure {
    pub reward_numerator: u128,
    pub reward_denominator: u128,
    pub time_based_reward_lower_bound: u128, // minimum filler reward for time-based reward
}

impl Default for FeeStructure2 {
    fn default() -> Self {
        FeeStructure2 {
            first_tier: FeeTier {
                fee_numerator: 10,
                fee_denominator: ONE_BPS_DENOMINATOR,
                maker_rebate_numerator: 6,
                maker_rebate_denominator: ONE_BPS_DENOMINATOR,
                referee_fee_numerator: 9,
                referee_fee_denominator: ONE_BPS_DENOMINATOR,
                referrer_reward_numerator: 1,
                referrer_reward_denominator: ONE_BPS_DENOMINATOR,
            },
            filler_reward_structure: OrderFillerRewardStructure {
                reward_numerator: 1,
                reward_denominator: ONE_BPS_DENOMINATOR,
                time_based_reward_lower_bound: 10_000, // 1 cent
            },
            ..PERP_FEE_STRUCTURE
        }
    }
}

pub const PERP_FEE_STRUCTURE: FeeStructure2 = FeeStructure2 {
    first_tier: FeeTier {
        fee_numerator: 10,
        fee_denominator: ONE_BPS_DENOMINATOR,
        maker_rebate_numerator: 2,
        maker_rebate_denominator: ONE_BPS_DENOMINATOR,
        referrer_reward_numerator: 1,
        referrer_reward_denominator: ONE_BPS_DENOMINATOR,
        referee_fee_numerator: 1,
        referee_fee_denominator: ONE_BPS_DENOMINATOR,
    },
    second_tier: FeeTier {
        fee_numerator: 10,
        fee_denominator: ONE_BPS_DENOMINATOR,
        maker_rebate_numerator: 2,
        maker_rebate_denominator: ONE_BPS_DENOMINATOR,
        referrer_reward_numerator: 1,
        referrer_reward_denominator: ONE_BPS_DENOMINATOR,
        referee_fee_numerator: 1,
        referee_fee_denominator: ONE_BPS_DENOMINATOR,
    },
    third_tier: FeeTier {
        fee_numerator: 10,
        fee_denominator: ONE_BPS_DENOMINATOR,
        maker_rebate_numerator: 2,
        maker_rebate_denominator: ONE_BPS_DENOMINATOR,
        referrer_reward_numerator: 1,
        referrer_reward_denominator: ONE_BPS_DENOMINATOR,
        referee_fee_numerator: 1,
        referee_fee_denominator: ONE_BPS_DENOMINATOR,
    },
    fourth_tier: FeeTier {
        fee_numerator: 10,
        fee_denominator: ONE_BPS_DENOMINATOR,
        maker_rebate_numerator: 2,
        maker_rebate_denominator: ONE_BPS_DENOMINATOR,
        referrer_reward_numerator: 1,
        referrer_reward_denominator: ONE_BPS_DENOMINATOR,
        referee_fee_numerator: 1,
        referee_fee_denominator: ONE_BPS_DENOMINATOR,
    },
    filler_reward_structure: OrderFillerRewardStructure {
        reward_numerator: 1,
        reward_denominator: ONE_BPS_DENOMINATOR,
        time_based_reward_lower_bound: 10_000, // 1 cent
    },
    flat_filler_fee: 10_000,
};

pub const SPOT_FEE_STRUCTURE: FeeStructure2 = FeeStructure2 {
    first_tier: FeeTier {
        fee_numerator: 10,
        fee_denominator: ONE_BPS_DENOMINATOR,
        maker_rebate_numerator: 2,
        maker_rebate_denominator: ONE_BPS_DENOMINATOR,
        referrer_reward_numerator: 1,
        referrer_reward_denominator: ONE_BPS_DENOMINATOR,
        referee_fee_numerator: 1,
        referee_fee_denominator: ONE_BPS_DENOMINATOR,
    },
    second_tier: FeeTier {
        fee_numerator: 10,
        fee_denominator: ONE_BPS_DENOMINATOR,
        maker_rebate_numerator: 2,
        maker_rebate_denominator: ONE_BPS_DENOMINATOR,
        referrer_reward_numerator: 1,
        referrer_reward_denominator: ONE_BPS_DENOMINATOR,
        referee_fee_numerator: 1,
        referee_fee_denominator: ONE_BPS_DENOMINATOR,
    },
    third_tier: FeeTier {
        fee_numerator: 10,
        fee_denominator: ONE_BPS_DENOMINATOR,
        maker_rebate_numerator: 2,
        maker_rebate_denominator: ONE_BPS_DENOMINATOR,
        referrer_reward_numerator: 1,
        referrer_reward_denominator: ONE_BPS_DENOMINATOR,
        referee_fee_numerator: 1,
        referee_fee_denominator: ONE_BPS_DENOMINATOR,
    },
    fourth_tier: FeeTier {
        fee_numerator: 10,
        fee_denominator: ONE_BPS_DENOMINATOR,
        maker_rebate_numerator: 2,
        maker_rebate_denominator: ONE_BPS_DENOMINATOR,
        referrer_reward_numerator: 1,
        referrer_reward_denominator: ONE_BPS_DENOMINATOR,
        referee_fee_numerator: 1,
        referee_fee_denominator: ONE_BPS_DENOMINATOR,
    },
    filler_reward_structure: OrderFillerRewardStructure {
        reward_numerator: 1,
        reward_denominator: ONE_BPS_DENOMINATOR,
        time_based_reward_lower_bound: 10_000, // 1 cent
    },
    flat_filler_fee: 10_000,
};
