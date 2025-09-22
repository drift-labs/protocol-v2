use std::cmp::{max, min};

use num_integer::Roots;

use crate::error::DriftResult;
use crate::math::casting::Cast;

use crate::math::constants::{
    FIVE_MILLION_QUOTE, ONE_HUNDRED_MILLION_QUOTE, ONE_HUNDRED_THOUSAND_QUOTE, ONE_MILLION_QUOTE,
    ONE_THOUSAND_QUOTE, TEN_BPS, TEN_MILLION_QUOTE, TEN_THOUSAND_QUOTE, TWENTY_FIVE_THOUSAND_QUOTE,
    TWO_HUNDRED_FIFTY_THOUSAND_QUOTE,
};
use crate::math::helpers::get_proportion_u128;
use crate::math::safe_math::SafeMath;

use crate::state::state::{FeeStructure, FeeTier, OrderFillerRewardStructure};
use crate::state::user::{MarketType, UserStats};

use crate::msg;
use crate::{FEE_ADJUSTMENT_MAX, QUOTE_PRECISION_U64};

#[cfg(test)]
mod tests;

pub struct FillFees {
    pub user_fee: u64,
    pub maker_rebate: u64,
    pub fee_to_market: i64,
    pub fee_to_market_for_lp: i64,
    pub filler_reward: u64,
    pub referrer_reward: u64,
    pub referee_discount: u64,
}

pub fn calculate_fee_for_fulfillment_with_amm(
    user_stats: &UserStats,
    quote_asset_amount: u64,
    fee_structure: &FeeStructure,
    order_slot: u64,
    clock_slot: u64,
    reward_filler: bool,
    reward_referrer: bool,
    referrer_stats: &Option<&mut UserStats>,
    quote_asset_amount_surplus: i64,
    is_post_only: bool,
    fee_adjustment: i16,
    user_high_leverage_mode: bool,
) -> DriftResult<FillFees> {
    let fee_tier = determine_user_fee_tier(
        user_stats,
        fee_structure,
        &MarketType::Perp,
        user_high_leverage_mode,
    )?;

    // if there was a quote_asset_amount_surplus, the order was a maker order and fee_to_market comes from surplus
    if is_post_only {
        let maker_rebate = calculate_maker_rebate(quote_asset_amount, &fee_tier, fee_adjustment)?;

        let fee = quote_asset_amount_surplus
            .cast::<u64>()?
            .safe_sub(maker_rebate)
            .map_err(|e| {
                msg!(
                    "quote_asset_amount_surplus {} quote_asset_amount {} maker_rebate {}",
                    quote_asset_amount_surplus,
                    quote_asset_amount,
                    maker_rebate
                );
                e
            })?;

        let filler_reward = if !reward_filler {
            0_u64
        } else {
            calculate_filler_reward(
                fee,
                order_slot,
                clock_slot,
                0,
                &fee_structure.filler_reward_structure,
            )?
        };
        let fee_to_market = fee.safe_sub(filler_reward)?.cast::<i64>()?;
        let user_fee = 0_u64;

        Ok(FillFees {
            user_fee,
            maker_rebate,
            fee_to_market,
            fee_to_market_for_lp: 0,
            filler_reward,
            referrer_reward: 0,
            referee_discount: 0,
        })
    } else {
        let mut fee = calculate_taker_fee(quote_asset_amount, &fee_tier, fee_adjustment)?;

        if user_high_leverage_mode {
            fee = fee.safe_mul(2)?;
        }

        let (fee, referee_discount, referrer_reward) = if reward_referrer {
            calculate_referee_fee_and_referrer_reward(
                fee,
                &fee_tier,
                fee_structure.referrer_reward_epoch_upper_bound,
                referrer_stats,
            )?
        } else {
            (fee, 0, 0)
        };

        let filler_reward = if !reward_filler {
            0_u64
        } else {
            calculate_filler_reward(
                fee,
                order_slot,
                clock_slot,
                0,
                &fee_structure.filler_reward_structure,
            )?
        };

        let fee_to_market = fee
            .safe_sub(filler_reward)?
            .safe_sub(referrer_reward)?
            .cast::<i64>()?
            .safe_add(quote_asset_amount_surplus)?;

        let fee_to_market_for_lp = fee_to_market.safe_sub(quote_asset_amount_surplus)?;

        // must be non-negative
        Ok(FillFees {
            user_fee: fee,
            maker_rebate: 0,
            fee_to_market,
            fee_to_market_for_lp,
            filler_reward,
            referrer_reward,
            referee_discount,
        })
    }
}

fn calculate_taker_fee(
    quote_asset_amount: u64,
    fee_tier: &FeeTier,
    fee_adjustment: i16,
) -> DriftResult<u64> {
    let mut taker_fee = quote_asset_amount
        .cast::<u128>()?
        .safe_mul(fee_tier.fee_numerator.cast::<u128>()?)?
        .safe_div_ceil(fee_tier.fee_denominator.cast::<u128>()?)?
        .cast::<u64>()?;

    if fee_adjustment < 0 {
        taker_fee = taker_fee.saturating_sub(
            taker_fee
                .safe_mul(fee_adjustment.unsigned_abs().cast()?)?
                .safe_div(FEE_ADJUSTMENT_MAX)?,
        );
    } else if fee_adjustment > 0 {
        taker_fee = taker_fee.saturating_add(
            taker_fee
                .safe_mul(fee_adjustment.cast()?)?
                .safe_div_ceil(FEE_ADJUSTMENT_MAX)?,
        );
    }

    Ok(taker_fee)
}

fn calculate_maker_rebate(
    quote_asset_amount: u64,
    fee_tier: &FeeTier,
    fee_adjustment: i16,
) -> DriftResult<u64> {
    let mut maker_fee = quote_asset_amount
        .cast::<u128>()?
        .safe_mul(fee_tier.maker_rebate_numerator as u128)?
        .safe_div(fee_tier.maker_rebate_denominator as u128)?
        .cast::<u64>()?;

    if fee_adjustment < 0 {
        maker_fee = maker_fee.saturating_sub(
            maker_fee
                .safe_mul(fee_adjustment.unsigned_abs().cast()?)?
                .safe_div_ceil(FEE_ADJUSTMENT_MAX)?,
        );
    } else if fee_adjustment > 0 {
        maker_fee = maker_fee.saturating_add(
            maker_fee
                .safe_mul(fee_adjustment.cast()?)?
                .safe_div(FEE_ADJUSTMENT_MAX)?,
        );
    }

    Ok(maker_fee)
}

fn calculate_referee_fee_and_referrer_reward(
    fee: u64,
    fee_tier: &FeeTier,
    referrer_reward_epoch_upper_bound: u64,
    referrer_stats: &Option<&mut UserStats>,
) -> DriftResult<(u64, u64, u64)> {
    let referee_discount = get_proportion_u128(
        fee as u128,
        fee_tier.referee_fee_numerator as u128,
        fee_tier.referee_fee_denominator as u128,
    )?
    .cast::<u64>()?;

    let max_referrer_reward_from_fee = get_proportion_u128(
        fee as u128,
        fee_tier.referrer_reward_numerator as u128,
        fee_tier.referrer_reward_denominator as u128,
    )?
    .cast::<u64>()?;

    let referee_fee = fee.safe_sub(referee_discount)?;

    let referrer_reward = match referrer_stats {
        Some(referrer_stats) => {
            let max_referrer_reward_in_epoch = referrer_reward_epoch_upper_bound
                .saturating_sub(referrer_stats.fees.current_epoch_referrer_reward);
            max_referrer_reward_from_fee.min(max_referrer_reward_in_epoch)
        }
        None => max_referrer_reward_from_fee,
    };
    Ok((referee_fee, referee_discount, referrer_reward))
}

fn calculate_filler_reward(
    fee: u64,
    order_slot: u64,
    clock_slot: u64,
    multiplier: u64,
    filler_reward_structure: &OrderFillerRewardStructure,
) -> DriftResult<u64> {
    // incentivize keepers to prioritize filling older orders (rather than just largest orders)
    // for sufficiently small-sized order, reward based on fraction of fee paid

    let size_filler_reward = fee
        .safe_mul(filler_reward_structure.reward_numerator as u64)?
        .safe_div(filler_reward_structure.reward_denominator as u64)?;

    let multiplier_precision = TEN_BPS.cast::<u128>()?;

    let min_time_filler_reward = filler_reward_structure
        .time_based_reward_lower_bound
        .safe_mul(
            multiplier
                .cast::<u128>()?
                .max(multiplier_precision)
                .min(multiplier_precision * 100),
        )?
        .safe_div(multiplier_precision)?;

    let slots_since_order = max(1, clock_slot.safe_sub(order_slot)?.cast::<u128>()?);
    let time_filler_reward = slots_since_order
        .safe_mul(100_000_000)? // 1e8
        .nth_root(4)
        .safe_mul(min_time_filler_reward)?
        .safe_div(100)? // 1e2 = sqrt(sqrt(1e8))
        .cast::<u64>()?;

    // lesser of size-based and time-based reward
    let fee = min(size_filler_reward, time_filler_reward);

    Ok(fee)
}

pub fn calculate_fee_for_fulfillment_with_match(
    taker_stats: &UserStats,
    maker_stats: &Option<&mut UserStats>,
    quote_asset_amount: u64,
    fee_structure: &FeeStructure,
    order_slot: u64,
    clock_slot: u64,
    filler_multiplier: u64,
    reward_referrer: bool,
    referrer_stats: &Option<&mut UserStats>,
    market_type: &MarketType,
    fee_adjustment: i16,
    user_high_leverage_mode: bool,
) -> DriftResult<FillFees> {
    let taker_fee_tier = determine_user_fee_tier(
        taker_stats,
        fee_structure,
        market_type,
        user_high_leverage_mode,
    )?;
    let maker_fee_tier = if let Some(maker_stats) = maker_stats {
        determine_user_fee_tier(maker_stats, fee_structure, market_type, false)?
    } else {
        determine_user_fee_tier(taker_stats, fee_structure, market_type, false)?
    };

    let mut taker_fee = calculate_taker_fee(quote_asset_amount, &taker_fee_tier, fee_adjustment)?;

    if user_high_leverage_mode {
        taker_fee = taker_fee.safe_mul(2)?;
    }

    let (taker_fee, referee_discount, referrer_reward) = if reward_referrer {
        calculate_referee_fee_and_referrer_reward(
            taker_fee,
            &taker_fee_tier,
            fee_structure.referrer_reward_epoch_upper_bound,
            referrer_stats,
        )?
    } else {
        (taker_fee, 0, 0)
    };

    let maker_rebate = calculate_maker_rebate(quote_asset_amount, &maker_fee_tier, fee_adjustment)?;

    let filler_reward = if filler_multiplier == 0 {
        0_u64
    } else {
        calculate_filler_reward(
            taker_fee,
            order_slot,
            clock_slot,
            filler_multiplier,
            &fee_structure.filler_reward_structure,
        )?
    };

    // must be non-negative
    let fee_to_market = taker_fee
        .safe_sub(filler_reward)?
        .safe_sub(referrer_reward)?
        .safe_sub(maker_rebate)?
        .cast::<i64>()?;

    Ok(FillFees {
        user_fee: taker_fee,
        maker_rebate,
        fee_to_market,
        filler_reward,
        referrer_reward,
        fee_to_market_for_lp: 0,
        referee_discount,
    })
}

pub struct ExternalFillFees {
    pub user_fee: u64,
    pub fee_to_market: u64,
    pub fee_pool_delta: i64,
    pub filler_reward: u64,
}

pub fn calculate_fee_for_fulfillment_with_external_market(
    user_stats: &UserStats,
    quote_asset_amount: u64,
    fee_structure: &FeeStructure,
    order_slot: u64,
    clock_slot: u64,
    reward_filler: bool,
    external_market_fee: u64,
    unsettled_referrer_rebate: u64,
    fee_pool_amount: u64,
    fee_adjustment: i16,
) -> DriftResult<ExternalFillFees> {
    let taker_fee_tier =
        determine_user_fee_tier(user_stats, fee_structure, &MarketType::Spot, false)?;

    let fee = calculate_taker_fee(quote_asset_amount, &taker_fee_tier, fee_adjustment)?;

    let fee_plus_referrer_rebate = external_market_fee.safe_add(unsettled_referrer_rebate)?;

    let user_fee = fee.max(fee_plus_referrer_rebate);

    let filler_reward = if reward_filler {
        let immediately_available_fee = user_fee.safe_sub(fee_plus_referrer_rebate)?;

        let eventual_available_fee = user_fee.safe_sub(external_market_fee)?;

        // can only pay the filler immediately if
        // 1. there are fees already in the fee pool
        // 2. the user_fee is greater than the serum_fee_plus_referrer_rebate
        let available_fee =
            eventual_available_fee.min(fee_pool_amount.max(immediately_available_fee));

        calculate_filler_reward(
            quote_asset_amount,
            order_slot,
            clock_slot,
            0,
            &fee_structure.filler_reward_structure,
        )?
        .min(available_fee)
    } else {
        0
    };

    let fee_to_market = user_fee
        .safe_sub(external_market_fee)?
        .safe_sub(filler_reward)?;

    let fee_pool_delta = fee_to_market
        .cast::<i64>()?
        .safe_sub(unsettled_referrer_rebate.cast()?)?;

    Ok(ExternalFillFees {
        user_fee,
        fee_to_market,
        filler_reward,
        fee_pool_delta,
    })
}

pub fn determine_user_fee_tier<'a>(
    user_stats: &UserStats,
    fee_structure: &'a FeeStructure,
    market_type: &MarketType,
    user_high_leverage_mode: bool,
) -> DriftResult<FeeTier> {
    match market_type {
        MarketType::Perp if user_high_leverage_mode => Ok(fee_structure.fee_tiers[0]),
        MarketType::Perp => determine_perp_fee_tier(user_stats, fee_structure),
        MarketType::Spot => Ok(*determine_spot_fee_tier(user_stats, fee_structure)?),
    }
}

fn determine_perp_fee_tier(
    user_stats: &UserStats,
    fee_structure: &FeeStructure,
) -> DriftResult<FeeTier> {
    let total_30d_volume = user_stats.get_total_30d_volume()?;
    let staked_gov_token_amount = user_stats.if_staked_gov_token_amount;

    const TIER_LENGTH: usize = 5;

    const VOLUME_THRESHOLDS: [u64; TIER_LENGTH] = [
        ONE_MILLION_QUOTE * 2,
        FIVE_MILLION_QUOTE * 2,
        TEN_MILLION_QUOTE * 2,
        TEN_MILLION_QUOTE * 8,
        ONE_HUNDRED_MILLION_QUOTE * 2,
    ];

    const STAKE_THRESHOLDS: [u64; TIER_LENGTH] = [
        ONE_THOUSAND_QUOTE - QUOTE_PRECISION_U64,
        TEN_THOUSAND_QUOTE - QUOTE_PRECISION_U64,
        (TWENTY_FIVE_THOUSAND_QUOTE * 2) - QUOTE_PRECISION_U64,
        ONE_HUNDRED_THOUSAND_QUOTE - QUOTE_PRECISION_U64,
        TWO_HUNDRED_FIFTY_THOUSAND_QUOTE - QUOTE_PRECISION_U64 * 5,
    ];

    const STAKE_BENEFIT_FRAC: [u32; TIER_LENGTH + 1] = [0, 5, 10, 20, 30, 40];

    let mut fee_tier_index = TIER_LENGTH;
    for i in 0..TIER_LENGTH {
        if total_30d_volume < VOLUME_THRESHOLDS[i] {
            fee_tier_index = i;
            break;
        }
    }

    let mut stake_benefit_index = TIER_LENGTH;
    for i in 0..TIER_LENGTH {
        if staked_gov_token_amount < STAKE_THRESHOLDS[i] {
            stake_benefit_index = i;
            break;
        }
    }

    let stake_benefit = STAKE_BENEFIT_FRAC[stake_benefit_index];

    let mut tier = fee_structure.fee_tiers[fee_tier_index];

    if stake_benefit > 0 {
        if let Some(div_scalar) = match stake_benefit {
            5 => Some(20),
            10 => Some(10),
            20 => Some(5),
            _ => None,
        } {
            // Fast path for 5%, 10%, 20% using no mul
            tier.fee_numerator = tier
                .fee_numerator
                .saturating_sub(tier.fee_numerator.safe_div_ceil(div_scalar)?);

            tier.maker_rebate_numerator = tier
                .maker_rebate_numerator
                .safe_add(tier.maker_rebate_numerator.safe_div(div_scalar)?)?;
        } else {
            // General path with mul/div
            tier.fee_numerator = tier
                .fee_numerator
                .safe_mul(100_u32.saturating_sub(stake_benefit))?
                .safe_div_ceil(100_u32)?;

            tier.maker_rebate_numerator = tier
                .maker_rebate_numerator
                .safe_mul(100_u32.saturating_add(stake_benefit))?
                .safe_div(100_u32)?;
        }
    }

    Ok(tier)
}

fn determine_spot_fee_tier<'a>(
    _user_stats: &UserStats,
    fee_structure: &'a FeeStructure,
) -> DriftResult<&'a FeeTier> {
    Ok(&fee_structure.fee_tiers[0])
}
