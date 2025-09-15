use crate::msg;

use crate::error::{DriftResult, ErrorCode};
use crate::math::constants::{
    FEE_DENOMINATOR, FEE_PERCENTAGE_DENOMINATOR, OPEN_ORDER_MARGIN_REQUIREMENT,
    PERCENTAGE_PRECISION,
};
use crate::state::state::{FeeStructure, FeeTier};
use crate::validate;

#[cfg(test)]
mod tests;

pub fn validate_fee_structure(fee_structure: &FeeStructure) -> DriftResult {
    for (i, fee_tier) in fee_structure.fee_tiers.iter().enumerate() {
        validate_fee_tier(
            i,
            fee_tier,
            fee_structure.filler_reward_structure.reward_numerator,
        )?;
    }

    let is_filler_reward_valid = fee_structure.filler_reward_structure.reward_numerator <= 20
        && fee_structure.filler_reward_structure.reward_denominator == FEE_PERCENTAGE_DENOMINATOR; // <= 20%

    validate!(
        is_filler_reward_valid,
        ErrorCode::InvalidFeeStructure,
        "invalid filler reward numerator ({}) or denominator  ({})",
        fee_structure.filler_reward_structure.reward_numerator,
        fee_structure.filler_reward_structure.reward_denominator
    )?;

    validate!(
        fee_structure.flat_filler_fee < OPEN_ORDER_MARGIN_REQUIREMENT as u64 / 2,
        ErrorCode::InvalidFeeStructure,
        "invalid flat filler fee {}",
        fee_structure.flat_filler_fee
    )?;

    Ok(())
}

pub fn validate_fee_tier(
    fee_tier_index: usize,
    fee_tier: &FeeTier,
    filler_reward_numerator: u32,
) -> DriftResult {
    let fee_valid = fee_tier.fee_numerator <= 300 && fee_tier.fee_denominator >= FEE_DENOMINATOR; // <= 30bps

    validate!(
        fee_valid,
        ErrorCode::InvalidFeeStructure,
        "invalid fee numerator ({}) or denominator  ({})",
        fee_tier.fee_numerator,
        fee_tier.fee_denominator
    )?;

    let maker_rebate_valid = fee_tier.maker_rebate_numerator <= 30
        && fee_tier.maker_rebate_denominator >= FEE_DENOMINATOR; // <= 3bps

    validate!(
        maker_rebate_valid,
        ErrorCode::InvalidFeeStructure,
        "invalid maker rebate numerator ({}) or denominator  ({})",
        fee_tier.maker_rebate_numerator,
        fee_tier.maker_rebate_denominator
    )?;

    let referee_discount_valid = fee_tier.referee_fee_numerator <= FEE_PERCENTAGE_DENOMINATOR
        && fee_tier.referee_fee_denominator == FEE_PERCENTAGE_DENOMINATOR; // <= 100%

    validate!(
        referee_discount_valid,
        ErrorCode::InvalidFeeStructure,
        "invalid referee discount numerator ({}) or denominator  ({})",
        fee_tier.referee_fee_numerator,
        fee_tier.referee_fee_denominator
    )?;

    let referrer_reward_valid = fee_tier.referrer_reward_numerator <= FEE_PERCENTAGE_DENOMINATOR
        && fee_tier.referrer_reward_denominator == FEE_PERCENTAGE_DENOMINATOR; // <= 100%

    validate!(
        referrer_reward_valid,
        ErrorCode::InvalidFeeStructure,
        "invalid referrer reward numerator ({}) or denominator  ({})",
        fee_tier.referrer_reward_numerator,
        fee_tier.referrer_reward_denominator
    )?;

    let taker_fee = fee_tier.fee_numerator * (100 - fee_tier.referee_fee_numerator) / 100;
    let fee_to_market_pre_maker = taker_fee
        - taker_fee * (fee_tier.referrer_reward_numerator + filler_reward_numerator) / 100;

    validate!(
        fee_to_market_pre_maker <= fee_tier.fee_numerator,
        ErrorCode::InvalidFeeStructure,
        "invalid taker fee to market ({}) for index ({})",
        fee_tier.referrer_reward_numerator,
        fee_tier_index,
    )?;

    let fee_to_market = fee_to_market_pre_maker as u128 * PERCENTAGE_PRECISION
        / fee_tier.fee_denominator as u128
        - fee_tier.maker_rebate_numerator as u128 * PERCENTAGE_PRECISION
            / fee_tier.maker_rebate_denominator as u128;

    validate!(
        fee_to_market >= 0,
        ErrorCode::InvalidFeeStructure,
        "invalid maker fee to market ({}) for index ({})",
        fee_tier.referrer_reward_numerator,
        fee_tier_index,
    )?;

    Ok(())
}
