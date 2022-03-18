use crate::error::*;
use crate::math::casting::cast_to_u128;
use crate::math_error;
use crate::state::order_state::OrderFillerRewardStructure;
use crate::state::state::{DiscountTokenTier, FeeStructure};
use crate::state::user::User;
use crate::state::user_orders::OrderDiscountTier;
use anchor_lang::Account;
use num_integer::Roots;
use solana_program::msg;
use spl_token::state::Account as TokenAccount;
use std::cmp::{max, min};

pub fn calculate_fee_for_trade(
    quote_asset_amount: u128,
    fee_structure: &FeeStructure,
    discount_token: Option<TokenAccount>,
    referrer: &Option<Account<User>>,
) -> ClearingHouseResult<(u128, u128, u128, u128, u128)> {
    let fee = quote_asset_amount
        .checked_mul(fee_structure.fee_numerator)
        .ok_or_else(math_error!())?
        .checked_div(fee_structure.fee_denominator)
        .ok_or_else(math_error!())?;

    let token_discount = calculate_token_discount(fee, fee_structure, discount_token);

    let (referrer_reward, referee_discount) =
        calculate_referral_reward_and_referee_discount(fee, fee_structure, referrer)?;

    let user_fee = fee
        .checked_sub(token_discount)
        .ok_or_else(math_error!())?
        .checked_sub(referee_discount)
        .ok_or_else(math_error!())?;

    let fee_to_market = user_fee
        .checked_sub(referrer_reward)
        .ok_or_else(math_error!())?;

    Ok((
        user_fee,
        fee_to_market,
        token_discount,
        referrer_reward,
        referee_discount,
    ))
}

fn calculate_token_discount(
    fee: u128,
    fee_structure: &FeeStructure,
    discount_token: Option<TokenAccount>,
) -> u128 {
    if discount_token.is_none() {
        return 0;
    }

    let discount_token = discount_token.unwrap();

    if let Some(discount) = try_to_calculate_token_discount_for_tier(
        fee,
        &fee_structure.discount_token_tiers.first_tier,
        discount_token,
    ) {
        return discount;
    }

    if let Some(discount) = try_to_calculate_token_discount_for_tier(
        fee,
        &fee_structure.discount_token_tiers.second_tier,
        discount_token,
    ) {
        return discount;
    }

    if let Some(discount) = try_to_calculate_token_discount_for_tier(
        fee,
        &fee_structure.discount_token_tiers.third_tier,
        discount_token,
    ) {
        return discount;
    }

    if let Some(discount) = try_to_calculate_token_discount_for_tier(
        fee,
        &fee_structure.discount_token_tiers.fourth_tier,
        discount_token,
    ) {
        return discount;
    }

    0
}

fn try_to_calculate_token_discount_for_tier(
    fee: u128,
    tier: &DiscountTokenTier,
    discount_token: TokenAccount,
) -> Option<u128> {
    if belongs_to_tier(tier, discount_token) {
        return calculate_token_discount_for_tier(fee, tier);
    }
    None
}

fn calculate_token_discount_for_tier(fee: u128, tier: &DiscountTokenTier) -> Option<u128> {
    fee.checked_mul(tier.discount_numerator)?
        .checked_div(tier.discount_denominator)
}

fn belongs_to_tier(tier: &DiscountTokenTier, discount_token: TokenAccount) -> bool {
    discount_token.amount >= tier.minimum_balance
}

fn calculate_referral_reward_and_referee_discount(
    fee: u128,
    fee_structure: &FeeStructure,
    referrer: &Option<Account<User>>,
) -> ClearingHouseResult<(u128, u128)> {
    if referrer.is_none() {
        return Ok((0, 0));
    }

    let referrer_reward = fee
        .checked_mul(fee_structure.referral_discount.referrer_reward_numerator)
        .ok_or_else(math_error!())?
        .checked_div(fee_structure.referral_discount.referrer_reward_denominator)
        .ok_or_else(math_error!())?;

    let referee_discount = fee
        .checked_mul(fee_structure.referral_discount.referee_discount_numerator)
        .ok_or_else(math_error!())?
        .checked_div(fee_structure.referral_discount.referee_discount_denominator)
        .ok_or_else(math_error!())?;

    Ok((referrer_reward, referee_discount))
}

pub fn calculate_order_fee_tier(
    fee_structure: &FeeStructure,
    discount_token: Option<TokenAccount>,
) -> ClearingHouseResult<OrderDiscountTier> {
    if discount_token.is_none() {
        return Ok(OrderDiscountTier::None);
    }

    let discount_token = discount_token.unwrap();

    if belongs_to_tier(
        &fee_structure.discount_token_tiers.first_tier,
        discount_token,
    ) {
        return Ok(OrderDiscountTier::First);
    }

    if belongs_to_tier(
        &fee_structure.discount_token_tiers.second_tier,
        discount_token,
    ) {
        return Ok(OrderDiscountTier::Second);
    }

    if belongs_to_tier(
        &fee_structure.discount_token_tiers.third_tier,
        discount_token,
    ) {
        return Ok(OrderDiscountTier::Third);
    }

    if belongs_to_tier(
        &fee_structure.discount_token_tiers.fourth_tier,
        discount_token,
    ) {
        return Ok(OrderDiscountTier::Fourth);
    }

    Ok(OrderDiscountTier::None)
}

pub fn calculate_fee_for_order(
    quote_asset_amount: u128,
    fee_structure: &FeeStructure,
    filler_reward_structure: &OrderFillerRewardStructure,
    order_fee_tier: &OrderDiscountTier,
    order_ts: i64,
    now: i64,
    referrer: &Option<Account<User>>,
    filler_is_user: bool,
    quote_asset_amount_surplus: u128,
) -> ClearingHouseResult<(u128, u128, u128, u128, u128, u128)> {
    // if there was a quote_asset_amount_surplus, the order was a maker order and fee_to_market comes from surplus
    if quote_asset_amount_surplus != 0 {
        let fee = quote_asset_amount_surplus;
        let filler_reward: u128 = if filler_is_user {
            0
        } else {
            calculate_filler_reward(fee, order_ts, now, filler_reward_structure)?
        };
        let fee_to_market = fee.checked_sub(filler_reward).ok_or_else(math_error!())?;

        Ok((0, fee_to_market, 0, filler_reward, 0, 0))
    } else {
        let fee = quote_asset_amount
            .checked_mul(fee_structure.fee_numerator)
            .ok_or_else(math_error!())?
            .checked_div(fee_structure.fee_denominator)
            .ok_or_else(math_error!())?;

        let token_discount =
            calculate_token_discount_for_limit_order(fee, fee_structure, order_fee_tier)?;

        let (referrer_reward, referee_discount) =
            calculate_referral_reward_and_referee_discount(fee, fee_structure, referrer)?;

        let user_fee = fee
            .checked_sub(referee_discount)
            .ok_or_else(math_error!())?
            .checked_sub(token_discount)
            .ok_or_else(math_error!())?;

        let filler_reward: u128 = if filler_is_user {
            0
        } else {
            calculate_filler_reward(user_fee, order_ts, now, filler_reward_structure)?
        };

        let fee_to_market = user_fee
            .checked_sub(filler_reward)
            .ok_or_else(math_error!())?
            .checked_sub(referrer_reward)
            .ok_or_else(math_error!())?;

        Ok((
            user_fee,
            fee_to_market,
            token_discount,
            filler_reward,
            referrer_reward,
            referee_discount,
        ))
    }
}

fn calculate_token_discount_for_limit_order(
    fee: u128,
    fee_structure: &FeeStructure,
    order_discount_tier: &OrderDiscountTier,
) -> ClearingHouseResult<u128> {
    match order_discount_tier {
        OrderDiscountTier::None => Ok(0),
        OrderDiscountTier::First => {
            calculate_token_discount_for_tier(fee, &fee_structure.discount_token_tiers.first_tier)
                .ok_or_else(math_error!())
        }
        OrderDiscountTier::Second => {
            calculate_token_discount_for_tier(fee, &fee_structure.discount_token_tiers.second_tier)
                .ok_or_else(math_error!())
        }
        OrderDiscountTier::Third => {
            calculate_token_discount_for_tier(fee, &fee_structure.discount_token_tiers.third_tier)
                .ok_or_else(math_error!())
        }
        OrderDiscountTier::Fourth => {
            calculate_token_discount_for_tier(fee, &fee_structure.discount_token_tiers.fourth_tier)
                .ok_or_else(math_error!())
        }
    }
}

fn calculate_filler_reward(
    fee: u128,
    order_ts: i64,
    now: i64,
    filler_reward_structure: &OrderFillerRewardStructure,
) -> ClearingHouseResult<u128> {
    // incentivize keepers to prioritize filling older orders (rather than just largest orders)
    // for sufficiently small-sized order, reward based on fraction of fee paid

    let size_filler_reward = fee
        .checked_mul(filler_reward_structure.reward_numerator)
        .ok_or_else(math_error!())?
        .checked_div(filler_reward_structure.reward_denominator)
        .ok_or_else(math_error!())?;

    let min_time_filler_reward = filler_reward_structure.time_based_reward_lower_bound;
    let time_since_order = max(
        1,
        cast_to_u128(now.checked_sub(order_ts).ok_or_else(math_error!())?)?,
    );
    let time_filler_reward = time_since_order
        .checked_mul(100_000_000) // 1e8
        .ok_or_else(math_error!())?
        .nth_root(4)
        .checked_mul(min_time_filler_reward)
        .ok_or_else(math_error!())?
        .checked_div(100) // 1e2 = sqrt(sqrt(1e8))
        .ok_or_else(math_error!())?;

    // lesser of size-based and time-based reward
    let fee = min(size_filler_reward, time_filler_reward);

    Ok(fee)
}
