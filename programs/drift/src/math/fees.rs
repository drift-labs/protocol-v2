use std::cmp::{max, min};

use num_integer::Roots;

use crate::error::DriftResult;
use crate::math::casting::Cast;

use crate::math::constants::{
    FIFTY_MILLION_QUOTE, FIVE_MILLION_QUOTE, ONE_HUNDRED_MILLION_QUOTE, ONE_MILLION_QUOTE,
    ONE_THOUSAND_QUOTE, TEN_BPS, TEN_MILLION_QUOTE, TEN_THOUSAND_QUOTE,
};
use crate::math::helpers::get_proportion_u128;
use crate::math::safe_math::SafeMath;

use crate::state::state::{FeeStructure, FeeTier, OrderFillerRewardStructure};
use crate::state::user::{MarketType, UserStats};

use crate::FEE_ADJUSTMENT_MAX;
use solana_program::msg;

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
) -> DriftResult<FillFees> {
    let fee_tier = determine_user_fee_tier(user_stats, fee_structure, &MarketType::Perp)?;

    // if there was a quote_asset_amount_surplus, the order was a maker order and fee_to_market comes from surplus
    if is_post_only {
        let fee = quote_asset_amount_surplus.cast::<u64>().map_err(|e| {
            msg!("quote_asset_amount_surplus {}", quote_asset_amount_surplus);
            msg!("quote_asset_amount {}", quote_asset_amount);
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
            maker_rebate: 0,
            fee_to_market,
            fee_to_market_for_lp: 0,
            filler_reward,
            referrer_reward: 0,
            referee_discount: 0,
        })
    } else {
        let fee = calculate_taker_fee(quote_asset_amount, fee_tier, fee_adjustment)?;

        let (fee, referee_discount, referrer_reward) = if reward_referrer {
            calculate_referee_fee_and_referrer_reward(
                fee,
                fee_tier,
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
) -> DriftResult<FillFees> {
    let taker_fee_tier = determine_user_fee_tier(taker_stats, fee_structure, market_type)?;
    let maker_fee_tier = if let Some(maker_stats) = maker_stats {
        determine_user_fee_tier(maker_stats, fee_structure, market_type)?
    } else {
        determine_user_fee_tier(taker_stats, fee_structure, market_type)?
    };

    let taker_fee = calculate_taker_fee(quote_asset_amount, taker_fee_tier, fee_adjustment)?;

    let (taker_fee, referee_discount, referrer_reward) = if reward_referrer {
        calculate_referee_fee_and_referrer_reward(
            taker_fee,
            taker_fee_tier,
            fee_structure.referrer_reward_epoch_upper_bound,
            referrer_stats,
        )?
    } else {
        (taker_fee, 0, 0)
    };

    let maker_rebate = calculate_maker_rebate(quote_asset_amount, maker_fee_tier, fee_adjustment)?;

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
    let taker_fee_tier = determine_user_fee_tier(user_stats, fee_structure, &MarketType::Spot)?;

    let fee = calculate_taker_fee(quote_asset_amount, taker_fee_tier, fee_adjustment)?;

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
) -> DriftResult<&'a FeeTier> {
    match market_type {
        MarketType::Perp => determine_perp_fee_tier(user_stats, fee_structure),
        MarketType::Spot => determine_spot_fee_tier(user_stats, fee_structure),
    }
}

fn determine_perp_fee_tier<'a>(
    user_stats: &UserStats,
    fee_structure: &'a FeeStructure,
) -> DriftResult<&'a FeeTier> {
    let total_30d_volume = user_stats.get_total_30d_volume()?;
    let staked_quote_asset_amount = user_stats.if_staked_quote_asset_amount;

    if total_30d_volume >= ONE_HUNDRED_MILLION_QUOTE
        || staked_quote_asset_amount >= TEN_THOUSAND_QUOTE - 1
    {
        return Ok(&fee_structure.fee_tiers[5]);
    }

    if total_30d_volume >= FIFTY_MILLION_QUOTE
        || staked_quote_asset_amount >= ONE_THOUSAND_QUOTE * 5 - 1
    {
        return Ok(&fee_structure.fee_tiers[4]);
    }

    if total_30d_volume >= TEN_MILLION_QUOTE
        || staked_quote_asset_amount >= ONE_THOUSAND_QUOTE * 2 - 1
    {
        return Ok(&fee_structure.fee_tiers[3]);
    }

    if total_30d_volume >= FIVE_MILLION_QUOTE || staked_quote_asset_amount >= ONE_THOUSAND_QUOTE - 1
    {
        return Ok(&fee_structure.fee_tiers[2]);
    }

    if total_30d_volume >= ONE_MILLION_QUOTE
        || staked_quote_asset_amount >= ONE_THOUSAND_QUOTE / 2 - 1
    {
        return Ok(&fee_structure.fee_tiers[1]);
    }

    Ok(&fee_structure.fee_tiers[0])
}

fn determine_spot_fee_tier<'a>(
    _user_stats: &UserStats,
    fee_structure: &'a FeeStructure,
) -> DriftResult<&'a FeeTier> {
    Ok(&fee_structure.fee_tiers[0])
}
