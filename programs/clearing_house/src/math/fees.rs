use std::cmp::{max, min};

use num_integer::Roots;
use solana_program::msg;

use crate::error::ClearingHouseResult;
use crate::math::casting::cast_to_u128;
use crate::math::constants::{
    FIFTY_MILLION_QUOTE, FIVE_MILLION_QUOTE, ONE_HUNDRED_MILLION_QUOTE, ONE_HUNDRED_THOUSAND_QUOTE,
    ONE_MILLION_QUOTE, ONE_THOUSAND_QUOTE, TEN_MILLION_QUOTE, TEN_THOUSAND_QUOTE,
    TWENTY_FIVE_THOUSAND_QUOTE, TWO_HUNDRED_FIFTY_THOUSAND_QUOTE,
};
use crate::math::helpers::get_proportion_u128;
use crate::math_error;
use crate::state::state::{FeeStructure, FeeTier, OrderFillerRewardStructure};
use crate::state::user::{MarketType, UserStats};

use super::casting::cast_to_i128;

pub struct FillFees {
    pub user_fee: u128,
    pub maker_rebate: u128,
    pub fee_to_market: i128,
    pub fee_to_market_for_lp: i128,
    pub filler_reward: u128,
    pub referrer_reward: u128,
    pub referee_discount: u128,
}

pub fn calculate_fee_for_fulfillment_with_amm(
    user_stats: &UserStats,
    quote_asset_amount: u128,
    fee_structure: &FeeStructure,
    order_ts: i64,
    now: i64,
    reward_filler: bool,
    reward_referrer: bool,
    referrer_stats: &Option<&mut UserStats>,
    quote_asset_amount_surplus: i128,
    is_post_only: bool,
) -> ClearingHouseResult<FillFees> {
    let fee_tier = determine_user_fee_tier(user_stats, fee_structure, &MarketType::Perp)?;

    // if there was a quote_asset_amount_surplus, the order was a maker order and fee_to_market comes from surplus
    if is_post_only {
        let fee = cast_to_u128(quote_asset_amount_surplus)?;
        let filler_reward: u128 = if !reward_filler {
            0
        } else {
            calculate_filler_reward(
                quote_asset_amount,
                order_ts,
                now,
                &fee_structure.filler_reward_structure,
            )?
        };
        let fee_to_market =
            cast_to_i128(fee.checked_sub(filler_reward).ok_or_else(math_error!())?)?;
        let user_fee = 0_u128;

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
        let fee = quote_asset_amount
            .checked_mul(fee_tier.fee_numerator as u128)
            .ok_or_else(math_error!())?
            .checked_div(fee_tier.fee_denominator as u128)
            .ok_or_else(math_error!())?;

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

        let filler_reward: u128 = if !reward_filler {
            0
        } else {
            calculate_filler_reward(fee, order_ts, now, &fee_structure.filler_reward_structure)?
        };

        let fee_to_market = cast_to_i128(
            fee.checked_sub(filler_reward)
                .ok_or_else(math_error!())?
                .checked_sub(referrer_reward)
                .ok_or_else(math_error!())?,
        )?
        .checked_add(quote_asset_amount_surplus)
        .ok_or_else(math_error!())?;

        let fee_to_market_for_lp = fee_to_market
            .checked_sub(quote_asset_amount_surplus)
            .ok_or_else(math_error!())?;

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

fn calculate_referee_fee_and_referrer_reward(
    fee: u128,
    fee_tier: &FeeTier,
    referrer_reward_epoch_upper_bound: u64,
    referrer_stats: &Option<&mut UserStats>,
) -> ClearingHouseResult<(u128, u128, u128)> {
    let referee_discount = get_proportion_u128(
        fee,
        fee_tier.referee_fee_numerator as u128,
        fee_tier.referee_fee_denominator as u128,
    )?;

    let max_referrer_reward_from_fee = get_proportion_u128(
        fee,
        fee_tier.referrer_reward_numerator as u128,
        fee_tier.referrer_reward_denominator as u128,
    )?;

    let referee_fee = fee
        .checked_sub(referee_discount)
        .ok_or_else(math_error!())?;

    let referrer_reward = match referrer_stats {
        Some(referrer_stats) => {
            let max_referrer_reward_in_epoch = cast_to_u128(
                referrer_reward_epoch_upper_bound
                    .saturating_sub(referrer_stats.current_epoch_referrer_reward),
            )?;
            max_referrer_reward_from_fee.min(max_referrer_reward_in_epoch)
        }
        None => max_referrer_reward_from_fee,
    };
    Ok((referee_fee, referee_discount, referrer_reward))
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
        .checked_mul(filler_reward_structure.reward_numerator as u128)
        .ok_or_else(math_error!())?
        .checked_div(filler_reward_structure.reward_denominator as u128)
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

pub fn calculate_fee_for_fulfillment_with_match(
    taker_stats: &UserStats,
    maker_stats: &UserStats,
    quote_asset_amount: u128,
    fee_structure: &FeeStructure,
    order_ts: i64,
    now: i64,
    reward_filler: bool,
    reward_referrer: bool,
    referrer_stats: &Option<&mut UserStats>,
    market_type: &MarketType,
) -> ClearingHouseResult<FillFees> {
    let taker_fee_tier = determine_user_fee_tier(taker_stats, fee_structure, market_type)?;
    let maker_fee_tier = determine_user_fee_tier(maker_stats, fee_structure, market_type)?;

    let taker_fee = quote_asset_amount
        .checked_mul(taker_fee_tier.fee_numerator as u128)
        .ok_or_else(math_error!())?
        .checked_div(taker_fee_tier.fee_denominator as u128)
        .ok_or_else(math_error!())?;

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

    let maker_rebate = quote_asset_amount
        .checked_mul(maker_fee_tier.maker_rebate_numerator as u128)
        .ok_or_else(math_error!())?
        .checked_div(maker_fee_tier.maker_rebate_denominator as u128)
        .ok_or_else(math_error!())?;

    let filler_reward: u128 = if !reward_filler {
        0
    } else {
        calculate_filler_reward(
            taker_fee,
            order_ts,
            now,
            &fee_structure.filler_reward_structure,
        )?
    };

    // must be non-negative
    let fee_to_market = cast_to_i128(
        taker_fee
            .checked_sub(filler_reward)
            .ok_or_else(math_error!())?
            .checked_sub(referrer_reward)
            .ok_or_else(math_error!())?
            .checked_sub(maker_rebate)
            .ok_or_else(math_error!())?,
    )?;

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

pub struct SerumFillFees {
    pub user_fee: u128,
    pub fee_to_market: u128,
    pub fee_pool_delta: i128,
    pub filler_reward: u128,
}

pub fn calculate_fee_for_fulfillment_with_serum(
    user_stats: &UserStats,
    quote_asset_amount: u128,
    fee_structure: &FeeStructure,
    order_ts: i64,
    now: i64,
    reward_filler: bool,
    serum_fee: u128,
    serum_referrer_rebate: u128,
    fee_pool_amount: u128,
) -> ClearingHouseResult<SerumFillFees> {
    let taker_fee_tier = determine_user_fee_tier(user_stats, fee_structure, &MarketType::Spot)?;

    let fee = quote_asset_amount
        .checked_mul(taker_fee_tier.fee_numerator as u128)
        .ok_or_else(math_error!())?
        .checked_div(taker_fee_tier.fee_denominator as u128)
        .ok_or_else(math_error!())?;

    let serum_fee_plus_referrer_rebate = serum_fee
        .checked_add(serum_referrer_rebate)
        .ok_or_else(math_error!())?;

    let user_fee = fee.max(serum_fee_plus_referrer_rebate);

    let filler_reward = if reward_filler {
        let immediately_available_fee = user_fee
            .checked_sub(serum_fee_plus_referrer_rebate)
            .ok_or_else(math_error!())?;

        let eventual_available_fee = user_fee.checked_sub(serum_fee).ok_or_else(math_error!())?;

        // can only pay the filler immediately if
        // 1. there are fees already in the fee pool
        // 2. the user_fee is greater than the serum_fee_plus_referrer_rebate
        let available_fee =
            eventual_available_fee.min(fee_pool_amount.max(immediately_available_fee));

        calculate_filler_reward(
            quote_asset_amount,
            order_ts,
            now,
            &fee_structure.filler_reward_structure,
        )?
        .min(available_fee)
    } else {
        0
    };

    let fee_to_market = user_fee
        .checked_sub(serum_fee)
        .ok_or_else(math_error!())?
        .checked_sub(filler_reward)
        .ok_or_else(math_error!())?;

    let fee_pool_delta = cast_to_i128(fee_to_market)?
        .checked_sub(cast_to_i128(serum_referrer_rebate)?)
        .ok_or_else(math_error!())?;

    Ok(SerumFillFees {
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
) -> ClearingHouseResult<&'a FeeTier> {
    match market_type {
        MarketType::Perp => determine_perp_fee_tier(user_stats, fee_structure),
        MarketType::Spot => determine_spot_fee_tier(user_stats, fee_structure),
    }
}

fn determine_perp_fee_tier<'a>(
    user_stats: &UserStats,
    fee_structure: &'a FeeStructure,
) -> ClearingHouseResult<&'a FeeTier> {
    let total_30d_volume = user_stats.get_total_30d_volume()?;
    let staked_quote_asset_amount = user_stats.staked_quote_asset_amount;

    if total_30d_volume >= ONE_HUNDRED_MILLION_QUOTE
        || staked_quote_asset_amount >= TWO_HUNDRED_FIFTY_THOUSAND_QUOTE
    {
        return Ok(&fee_structure.fee_tiers[5]);
    }

    if total_30d_volume >= FIFTY_MILLION_QUOTE
        || staked_quote_asset_amount >= ONE_HUNDRED_THOUSAND_QUOTE
    {
        return Ok(&fee_structure.fee_tiers[4]);
    }

    if total_30d_volume >= TEN_MILLION_QUOTE
        || staked_quote_asset_amount >= TWENTY_FIVE_THOUSAND_QUOTE
    {
        return Ok(&fee_structure.fee_tiers[3]);
    }

    if total_30d_volume >= FIVE_MILLION_QUOTE || staked_quote_asset_amount >= TEN_THOUSAND_QUOTE {
        return Ok(&fee_structure.fee_tiers[2]);
    }

    if total_30d_volume >= ONE_MILLION_QUOTE || staked_quote_asset_amount >= ONE_THOUSAND_QUOTE {
        return Ok(&fee_structure.fee_tiers[1]);
    }

    Ok(&fee_structure.fee_tiers[0])
}

fn determine_spot_fee_tier<'a>(
    _user_stats: &UserStats,
    fee_structure: &'a FeeStructure,
) -> ClearingHouseResult<&'a FeeTier> {
    Ok(&fee_structure.fee_tiers[0])
}

#[cfg(test)]
mod test {

    mod calculate_fee_for_taker_and_maker {
        use crate::math::constants::QUOTE_PRECISION;
        use crate::math::fees::{calculate_fee_for_fulfillment_with_match, FillFees};
        use crate::state::state::FeeStructure;
        use crate::state::user::{MarketType, UserStats};

        #[test]
        fn no_filler() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;
            let taker_stats = UserStats::default();
            let maker_stats = UserStats::default();

            let FillFees {
                user_fee: taker_fee,
                maker_rebate,
                fee_to_market,
                filler_reward,
                referee_discount,
                referrer_reward,
                ..
            } = calculate_fee_for_fulfillment_with_match(
                &taker_stats,
                &maker_stats,
                quote_asset_amount,
                &FeeStructure::test_default(),
                0,
                0,
                false,
                false,
                &None,
                &MarketType::Perp,
            )
            .unwrap();

            assert_eq!(taker_fee, 100000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 40000);
            assert_eq!(filler_reward, 0);
            assert_eq!(referrer_reward, 0);
            assert_eq!(referee_discount, 0);
        }

        #[test]
        fn filler_size_reward() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let taker_stats = UserStats::default();
            let maker_stats = UserStats::default();

            let mut fee_structure = FeeStructure::test_default();
            fee_structure
                .filler_reward_structure
                .time_based_reward_lower_bound = 10000000000000000; // big number

            let FillFees {
                user_fee: taker_fee,
                maker_rebate,
                fee_to_market,
                filler_reward,
                referee_discount,
                referrer_reward,
                ..
            } = calculate_fee_for_fulfillment_with_match(
                &taker_stats,
                &maker_stats,
                quote_asset_amount,
                &fee_structure,
                0,
                0,
                true,
                false,
                &None,
                &MarketType::Perp,
            )
            .unwrap();

            assert_eq!(taker_fee, 100000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 30000);
            assert_eq!(filler_reward, 10000);
            assert_eq!(referrer_reward, 0);
            assert_eq!(referee_discount, 0);
        }

        #[test]
        fn time_reward_no_time_passed() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let taker_stats = UserStats::default();
            let maker_stats = UserStats::default();

            let mut fee_structure = FeeStructure::test_default();
            fee_structure.filler_reward_structure.reward_numerator = 1; // will make size reward the whole fee
            fee_structure.filler_reward_structure.reward_denominator = 1;

            let FillFees {
                user_fee: taker_fee,
                maker_rebate,
                fee_to_market,
                filler_reward,
                referee_discount,
                referrer_reward,
                ..
            } = calculate_fee_for_fulfillment_with_match(
                &taker_stats,
                &maker_stats,
                quote_asset_amount,
                &fee_structure,
                0,
                0,
                true,
                false,
                &None,
                &MarketType::Perp,
            )
            .unwrap();

            assert_eq!(taker_fee, 100000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 30000);
            assert_eq!(filler_reward, 10000);
            assert_eq!(referrer_reward, 0);
            assert_eq!(referee_discount, 0);
        }

        #[test]
        fn time_reward_time_passed() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let taker_stats = UserStats::default();
            let maker_stats = UserStats::default();

            let mut fee_structure = FeeStructure::test_default();
            fee_structure.filler_reward_structure.reward_numerator = 1; // will make size reward the whole fee
            fee_structure.filler_reward_structure.reward_denominator = 1;

            let FillFees {
                user_fee: taker_fee,
                maker_rebate,
                fee_to_market,
                filler_reward,
                referee_discount,
                referrer_reward,
                ..
            } = calculate_fee_for_fulfillment_with_match(
                &taker_stats,
                &maker_stats,
                quote_asset_amount,
                &fee_structure,
                0,
                60,
                true,
                false,
                &None,
                &MarketType::Perp,
            )
            .unwrap();

            assert_eq!(taker_fee, 100000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 12200);
            assert_eq!(filler_reward, 27800);
            assert_eq!(referrer_reward, 0);
            assert_eq!(referee_discount, 0);
        }

        #[test]
        fn referrer() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let taker_stats = UserStats::default();
            let maker_stats = UserStats::default();

            let fee_structure = FeeStructure::test_default();

            let FillFees {
                user_fee: taker_fee,
                maker_rebate,
                fee_to_market,
                filler_reward,
                referee_discount,
                referrer_reward,
                ..
            } = calculate_fee_for_fulfillment_with_match(
                &taker_stats,
                &maker_stats,
                quote_asset_amount,
                &fee_structure,
                0,
                0,
                false,
                true,
                &None,
                &MarketType::Perp,
            )
            .unwrap();

            assert_eq!(taker_fee, 90000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 20000);
            assert_eq!(filler_reward, 0);
            assert_eq!(referrer_reward, 10000);
            assert_eq!(referee_discount, 10000);
        }
    }

    mod calculate_fee_for_order_fulfill_against_amm {
        use crate::math::constants::QUOTE_PRECISION;
        use crate::math::fees::{calculate_fee_for_fulfillment_with_amm, FillFees};
        use crate::state::state::FeeStructure;
        use crate::state::user::UserStats;

        #[test]
        fn referrer() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let taker_stats = UserStats::default();
            let fee_structure = FeeStructure::test_default();

            let FillFees {
                user_fee,
                fee_to_market,
                filler_reward,
                referee_discount,
                referrer_reward,
                ..
            } = calculate_fee_for_fulfillment_with_amm(
                &taker_stats,
                quote_asset_amount,
                &fee_structure,
                0,
                60,
                false,
                true,
                &None,
                0,
                false,
            )
            .unwrap();

            assert_eq!(user_fee, 90000);
            assert_eq!(fee_to_market, 80000);
            assert_eq!(filler_reward, 0);
            assert_eq!(referrer_reward, 10000);
            assert_eq!(referee_discount, 10000);
        }
    }

    mod calculate_fee_for_fulfillment_with_serum {
        use crate::math::constants::QUOTE_PRECISION;
        use crate::math::fees::{calculate_fee_for_fulfillment_with_serum, SerumFillFees};
        use crate::state::state::FeeStructure;
        use crate::state::user::UserStats;

        #[test]
        fn no_filler() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let serum_fee = 32000_u128; // 3.2 bps

            let serum_referrer_rebate = 8000_u128; // .8 bps

            let fee_pool_token_amount = 0_u128;

            let taker_stats = UserStats::default();
            let fee_structure = FeeStructure::test_default();

            let SerumFillFees {
                user_fee,
                fee_to_market,
                fee_pool_delta,
                filler_reward,
            } = calculate_fee_for_fulfillment_with_serum(
                &taker_stats,
                quote_asset_amount,
                &fee_structure,
                0,
                0,
                false,
                serum_fee,
                serum_referrer_rebate,
                fee_pool_token_amount,
            )
            .unwrap();

            assert_eq!(user_fee, 100000);
            assert_eq!(fee_to_market, 68000);
            assert_eq!(fee_pool_delta, 60000);
            assert_eq!(filler_reward, 0);
        }

        #[test]
        fn filler_reward_from_excess_user_fee() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let serum_fee = 32000_u128; // 3.2 bps

            let serum_referrer_rebate = 8000_u128; // .8 bps

            let fee_pool_token_amount = 0_u128;

            let taker_stats = UserStats::default();
            let fee_structure = FeeStructure::test_default();

            let SerumFillFees {
                user_fee,
                fee_to_market,
                fee_pool_delta,
                filler_reward,
            } = calculate_fee_for_fulfillment_with_serum(
                &taker_stats,
                quote_asset_amount,
                &fee_structure,
                0,
                0,
                true,
                serum_fee,
                serum_referrer_rebate,
                fee_pool_token_amount,
            )
            .unwrap();

            assert_eq!(user_fee, 100000);
            assert_eq!(fee_to_market, 58000);
            assert_eq!(fee_pool_delta, 50000);
            assert_eq!(filler_reward, 10000);
        }

        #[test]
        fn filler_reward_from_fee_pool() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let serum_fee = 32000_u128; // 3.2 bps

            let serum_referrer_rebate = 8000_u128; // .8 bps

            let fee_pool_token_amount = 10000_u128;

            let user_stats = UserStats::default();
            let mut fee_structure = FeeStructure::test_default();
            fee_structure.fee_tiers[0].fee_numerator = 4;

            let SerumFillFees {
                user_fee,
                fee_to_market,
                fee_pool_delta,
                filler_reward,
            } = calculate_fee_for_fulfillment_with_serum(
                &user_stats,
                quote_asset_amount,
                &fee_structure,
                0,
                0,
                true,
                serum_fee,
                serum_referrer_rebate,
                fee_pool_token_amount,
            )
            .unwrap();

            assert_eq!(user_fee, 40000);
            assert_eq!(fee_to_market, 0);
            assert_eq!(fee_pool_delta, -8000);
            assert_eq!(filler_reward, 8000);
        }

        #[test]
        fn filler_reward_from_smaller_fee_pool() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let serum_fee = 32000_u128; // 3.2 bps

            let serum_referrer_rebate = 8000_u128; // .8 bps

            let fee_pool_token_amount = 2000_u128;

            let user_stats = UserStats::default();
            let mut fee_structure = FeeStructure::test_default();
            fee_structure.fee_tiers[0].fee_numerator = 4;

            let SerumFillFees {
                user_fee,
                fee_to_market,
                fee_pool_delta,
                filler_reward,
            } = calculate_fee_for_fulfillment_with_serum(
                &user_stats,
                quote_asset_amount,
                &fee_structure,
                0,
                0,
                true,
                serum_fee,
                serum_referrer_rebate,
                fee_pool_token_amount,
            )
            .unwrap();

            assert_eq!(user_fee, 40000);
            assert_eq!(fee_to_market, 6000);
            assert_eq!(fee_pool_delta, -2000);
            assert_eq!(filler_reward, 2000);
        }
    }
}
