use solana_program::msg;

use crate::error::ClearingHouseResult;
use crate::math::amm::calculate_market_open_bids_asks;
use crate::math::casting::cast_to_i128;
use crate::math::constants::AMM_RESERVE_PRECISION_I128;
use crate::math::helpers;
use crate::math::orders::standardize_base_asset_amount_with_remainder_i128;
use crate::math_error;
use crate::state::market::Market;
use crate::state::market::AMM;
use crate::state::user::MarketPosition;

#[derive(Debug)]
pub struct LPMetrics {
    pub base_asset_amount: i128,
    pub quote_asset_amount: i128,
    pub remainder_base_asset_amount: i128,
}

pub fn calculate_settle_lp_metrics(
    amm: &AMM,
    position: &MarketPosition,
) -> ClearingHouseResult<LPMetrics> {
    let (base_asset_amount, quote_asset_amount) = calculate_settled_lp_base_quote(amm, position)?;

    // stepsize it
    let (standardized_base_asset_amount, remainder_base_asset_amount) =
        standardize_base_asset_amount_with_remainder_i128(
            base_asset_amount,
            amm.base_asset_amount_step_size,
        )?;

    let min_baa = amm.base_asset_amount_step_size;

    // note: since pnl may go into the qaa of a position its not really fair to ensure qaa >= min_qaa
    let remainder_base_asset_amount = if standardized_base_asset_amount.unsigned_abs() >= min_baa {
        remainder_base_asset_amount
    } else {
        base_asset_amount
    };

    let standardized_base_asset_amount = base_asset_amount
        .checked_sub(remainder_base_asset_amount)
        .ok_or_else(math_error!())?;

    let lp_metrics = LPMetrics {
        base_asset_amount: standardized_base_asset_amount,
        quote_asset_amount,
        remainder_base_asset_amount,
    };

    Ok(lp_metrics)
}

pub fn calculate_settled_lp_base_quote(
    amm: &AMM,
    position: &MarketPosition,
) -> ClearingHouseResult<(i128, i128)> {
    let n_shares = position.lp_shares;
    let n_shares_i128 = cast_to_i128(n_shares)?;

    // give them slice of the damm market position
    let amm_net_base_asset_amount_per_lp = amm
        .market_position_per_lp
        .base_asset_amount
        .checked_sub(position.last_net_base_asset_amount_per_lp)
        .ok_or_else(math_error!())?;

    let base_asset_amount = amm_net_base_asset_amount_per_lp
        .checked_mul(n_shares_i128)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION_I128)
        .ok_or_else(math_error!())?;

    let amm_net_quote_asset_amount_per_lp = amm
        .market_position_per_lp
        .quote_asset_amount
        .checked_sub(position.last_net_quote_asset_amount_per_lp)
        .ok_or_else(math_error!())?;

    let quote_asset_amount = amm_net_quote_asset_amount_per_lp
        .checked_mul(n_shares_i128)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION_I128)
        .ok_or_else(math_error!())?;

    Ok((base_asset_amount, quote_asset_amount))
}

pub fn calculate_lp_open_bids_asks(
    market_position: &MarketPosition,
    market: &Market,
) -> ClearingHouseResult<(i128, i128)> {
    let total_lp_shares = market.amm.sqrt_k;
    let lp_shares = market_position.lp_shares;

    let (max_bids, max_asks) = calculate_market_open_bids_asks(&market.amm)?;
    let open_asks = helpers::get_proportion_i128(max_asks, lp_shares, total_lp_shares)?;
    let open_bids = helpers::get_proportion_i128(max_bids, lp_shares, total_lp_shares)?;

    Ok((open_bids, open_asks))
}

#[cfg(test)]
mod test {
    use crate::math::constants::AMM_RESERVE_PRECISION;
    use crate::state::user::MarketPosition;

    use super::*;

    mod calculate_get_proportion_u128 {
        use crate::math::helpers::get_proportion_u128;

        use super::*;

        pub fn get_proportion_u128_safe(
            value: u128,
            numerator: u128,
            denominator: u128,
        ) -> ClearingHouseResult<u128> {
            if numerator == 0 {
                return Ok(0);
            }

            let proportional_value = if numerator <= denominator {
                let ratio = denominator
                    .checked_mul(10000)
                    .ok_or_else(math_error!())?
                    .checked_div(numerator)
                    .ok_or_else(math_error!())?;
                value
                    .checked_mul(10000)
                    .ok_or_else(math_error!())?
                    .checked_div(ratio)
                    .ok_or_else(math_error!())?
            } else {
                value
                    .checked_mul(numerator)
                    .ok_or_else(math_error!())?
                    .checked_div(denominator)
                    .ok_or_else(math_error!())?
            };

            Ok(proportional_value)
        }

        #[test]
        fn test_safe() {
            let sqrt_k = AMM_RESERVE_PRECISION * 10_123;
            let max_reserve = sqrt_k * 14121 / 10000;
            let max_asks = max_reserve - sqrt_k;

            // let ans1 = get_proportion_u128_safe(max_asks, sqrt_k - sqrt_k / 100, sqrt_k).unwrap();
            // let ans2 = get_proportion_u128(max_asks, sqrt_k - sqrt_k / 100, sqrt_k).unwrap();
            // assert_eq!(ans1, ans2); //fails

            let ans1 = get_proportion_u128_safe(max_asks, sqrt_k / 2, sqrt_k).unwrap();
            let ans2 = get_proportion_u128(max_asks, sqrt_k / 2, sqrt_k).unwrap();
            assert_eq!(ans1, ans2);

            let ans1 = get_proportion_u128_safe(max_asks, AMM_RESERVE_PRECISION, sqrt_k).unwrap();
            let ans2 = get_proportion_u128(max_asks, AMM_RESERVE_PRECISION, sqrt_k).unwrap();
            assert_eq!(ans1, ans2);

            let ans1 = get_proportion_u128_safe(max_asks, 0, sqrt_k).unwrap();
            let ans2 = get_proportion_u128(max_asks, 0, sqrt_k).unwrap();
            assert_eq!(ans1, ans2);

            let ans1 = get_proportion_u128_safe(max_asks, 1325324, sqrt_k).unwrap();
            let ans2 = get_proportion_u128(max_asks, 1325324, sqrt_k).unwrap();
            assert_eq!(ans1, ans2);

            // let ans1 = get_proportion_u128(max_asks, sqrt_k, sqrt_k).unwrap();
            // assert_eq!(ans1, max_asks);
        }
    }

    mod calculate_lp_open_bids_asks {
        use super::*;

        #[test]
        fn test_simple_lp_bid_ask() {
            let position = MarketPosition {
                lp_shares: 100,
                ..MarketPosition::default()
            };

            let amm = AMM {
                base_asset_reserve: 10,
                max_base_asset_reserve: 100,
                min_base_asset_reserve: 0,
                sqrt_k: 200,
                ..AMM::default_test()
            };
            let market = Market {
                amm,
                ..Market::default_test()
            };

            let (open_bids, open_asks) = calculate_lp_open_bids_asks(&position, &market).unwrap();

            assert_eq!(open_bids, 10 * 100 / 200);
            assert_eq!(open_asks, -90 * 100 / 200);
        }

        #[test]
        fn test_max_ask() {
            let position = MarketPosition {
                lp_shares: 100,
                ..MarketPosition::default()
            };

            let amm = AMM {
                base_asset_reserve: 0,
                max_base_asset_reserve: 100,
                min_base_asset_reserve: 0,
                sqrt_k: 200,
                ..AMM::default_test()
            };
            let market = Market {
                amm,
                ..Market::default_test()
            };

            let (open_bids, open_asks) = calculate_lp_open_bids_asks(&position, &market).unwrap();

            assert_eq!(open_bids, 0); // wont go anymore short
            assert_eq!(open_asks, -100 * 100 / 200);
        }

        #[test]
        fn test_max_bid() {
            let position = MarketPosition {
                lp_shares: 100,
                ..MarketPosition::default()
            };

            let amm = AMM {
                base_asset_reserve: 10,
                max_base_asset_reserve: 10,
                min_base_asset_reserve: 0,
                sqrt_k: 200,
                ..AMM::default_test()
            };
            let market = Market {
                amm,
                ..Market::default_test()
            };

            let (open_bids, open_asks) = calculate_lp_open_bids_asks(&position, &market).unwrap();

            assert_eq!(open_bids, 10 * 100 / 200);
            assert_eq!(open_asks, 0); // no more long
        }
    }

    mod calculate_settled_lp_base_quote {
        use super::*;

        #[test]
        fn test_long_settle() {
            let position = MarketPosition {
                lp_shares: 100 * AMM_RESERVE_PRECISION,
                ..MarketPosition::default()
            };

            let amm = AMM {
                market_position_per_lp: MarketPosition {
                    base_asset_amount: 10,
                    quote_asset_amount: -10,
                    ..MarketPosition::default()
                },
                ..AMM::default_test()
            };

            let (baa, qaa) = calculate_settled_lp_base_quote(&amm, &position).unwrap();

            assert_eq!(baa, 10 * 100);
            assert_eq!(qaa, -10 * 100);
        }

        #[test]
        fn test_short_settle() {
            let position = MarketPosition {
                lp_shares: 100 * AMM_RESERVE_PRECISION,
                ..MarketPosition::default()
            };

            let amm = AMM {
                market_position_per_lp: MarketPosition {
                    base_asset_amount: -10,
                    quote_asset_amount: 10,
                    ..MarketPosition::default()
                },
                ..AMM::default_test()
            };

            let (baa, qaa) = calculate_settled_lp_base_quote(&amm, &position).unwrap();

            assert_eq!(baa, -10 * 100);
            assert_eq!(qaa, 10 * 100);
        }
    }

    mod calculate_settle_lp_metrics {
        use super::*;

        #[test]
        fn test_long_settle() {
            let position = MarketPosition {
                lp_shares: 100 * AMM_RESERVE_PRECISION,
                ..MarketPosition::default()
            };

            let amm = AMM {
                market_position_per_lp: MarketPosition {
                    base_asset_amount: 10,
                    quote_asset_amount: -10,
                    ..MarketPosition::default()
                },
                base_asset_amount_step_size: 1,
                ..AMM::default_test()
            };

            let lp_metrics = calculate_settle_lp_metrics(&amm, &position).unwrap();

            assert_eq!(lp_metrics.base_asset_amount, 10 * 100);
            assert_eq!(lp_metrics.quote_asset_amount, -10 * 100);
            assert_eq!(lp_metrics.remainder_base_asset_amount, 0);
        }

        #[test]
        fn test_all_remainder() {
            let position = MarketPosition {
                lp_shares: 100 * AMM_RESERVE_PRECISION,
                ..MarketPosition::default()
            };

            let amm = AMM {
                market_position_per_lp: MarketPosition {
                    base_asset_amount: 10,
                    quote_asset_amount: -10,
                    ..MarketPosition::default()
                },
                base_asset_amount_step_size: 50 * 100,
                ..AMM::default_test()
            };

            let lp_metrics = calculate_settle_lp_metrics(&amm, &position).unwrap();

            assert_eq!(lp_metrics.base_asset_amount, 0);
            assert_eq!(lp_metrics.quote_asset_amount, -10 * 100);
            assert_eq!(lp_metrics.remainder_base_asset_amount, 10 * 100);
        }

        #[test]
        fn test_portion_remainder() {
            let position = MarketPosition {
                lp_shares: AMM_RESERVE_PRECISION,
                ..MarketPosition::default()
            };

            let amm = AMM {
                market_position_per_lp: MarketPosition {
                    base_asset_amount: 10,
                    quote_asset_amount: -10,
                    ..MarketPosition::default()
                },
                base_asset_amount_step_size: 3,
                ..AMM::default_test()
            };

            let lp_metrics = calculate_settle_lp_metrics(&amm, &position).unwrap();

            assert_eq!(lp_metrics.base_asset_amount, 9);
            assert_eq!(lp_metrics.quote_asset_amount, -10);
            assert_eq!(lp_metrics.remainder_base_asset_amount, 1);
        }
    }
}
