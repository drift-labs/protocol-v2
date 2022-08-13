use crate::error::ClearingHouseResult;
use crate::math::casting::cast_to_i128;
use crate::math::constants::AMM_RESERVE_PRECISION;
use crate::math::constants::AMM_RESERVE_PRECISION_I128;
use crate::math::orders::standardize_base_asset_amount_with_remainder_i128;
use crate::math_error;
use crate::state::market::Market;
use crate::state::market::AMM;
use crate::state::user::MarketPosition;
use solana_program::msg;

#[derive(Debug)]
pub struct LPMetrics {
    pub base_asset_amount: i128,
    pub quote_asset_amount: i128,
    pub remainder_base_asset_amount: i128,
    pub remainder_quote_asset_amount: i128,
}

pub fn compute_settle_lp_metrics(
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

    let _min_qaa = amm.minimum_quote_asset_trade_size; // todo: uses reserve precision -- see note:
    let min_baa = amm.base_asset_amount_step_size;

    // note: since pnl may go into the qaa of a position its not really fair to ensure qaa >= min_qaa
    let (remainder_base_asset_amount, remainder_quote_asset_amount) =
        if standardized_base_asset_amount.unsigned_abs() >= min_baa {
            // compute quote amount in remainder
            let remainder_ratio = cast_to_i128(
                remainder_base_asset_amount
                    .unsigned_abs()
                    .checked_mul(AMM_RESERVE_PRECISION)
                    .ok_or_else(math_error!())?
                    .checked_div(base_asset_amount.unsigned_abs())
                    .ok_or_else(math_error!())?,
            )?;

            // let remainder_quote_asset_amount =
            //     quote_asset_amount
            //     .checked_mul(remainder_ratio)
            //     .ok_or_else(math_error!())?
            //     .checked_div(AMM_RESERVE_PRECISION_I128)
            //     .ok_or_else(math_error!())?;

            (remainder_base_asset_amount, 0)
        } else {
            (base_asset_amount, 0)
        };

    let standardized_base_asset_amount = base_asset_amount
        .checked_sub(remainder_base_asset_amount)
        .ok_or_else(math_error!())?;

    let standardized_quote_asset_amount = quote_asset_amount
        .checked_sub(remainder_quote_asset_amount)
        .ok_or_else(math_error!())?;

    let lp_metrics = LPMetrics {
        base_asset_amount: standardized_base_asset_amount,
        quote_asset_amount: standardized_quote_asset_amount,
        remainder_base_asset_amount,
        remainder_quote_asset_amount,
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

pub fn get_lp_open_bids_asks(
    market_position: &MarketPosition,
    market: &Market,
) -> ClearingHouseResult<(i128, i128)> {
    // TODO: make this a constant?
    let sqrt_2_percision = 10_000_u128;
    let sqrt_2 = 14142;
    let total_lp_shares = market.amm.sqrt_k;
    let lp_shares = market_position.lp_shares;

    // worse case if all asks are filled
    let ask_bounded_k = market
        .amm
        .sqrt_k
        .checked_mul(sqrt_2)
        .ok_or_else(math_error!())?
        .checked_div(sqrt_2_percision)
        .ok_or_else(math_error!())?;

    let max_asks = if ask_bounded_k > market.amm.base_asset_reserve {
        ask_bounded_k
            .checked_sub(market.amm.base_asset_reserve)
            .ok_or_else(math_error!())?
    } else {
        0
    };

    let open_asks = cast_to_i128(get_proportion_u128(max_asks, lp_shares, total_lp_shares)?)?;

    // worst case if all bids are filled (lp is now long)
    let bids_bounded_k = market
        .amm
        .sqrt_k
        .checked_mul(sqrt_2_percision)
        .ok_or_else(math_error!())?
        .checked_div(sqrt_2)
        .ok_or_else(math_error!())?;

    let max_bids = if bids_bounded_k < market.amm.base_asset_reserve {
        market
            .amm
            .base_asset_reserve
            .checked_sub(bids_bounded_k)
            .ok_or_else(math_error!())?
    } else {
        0
    };

    let open_bids = cast_to_i128(get_proportion_u128(max_bids, lp_shares, total_lp_shares)?)?;

    Ok((open_bids, open_asks))
}

pub fn get_proportion_i128(
    value: i128,
    numerator: u128,
    denominator: u128,
) -> ClearingHouseResult<i128> {
    let proportional_value = cast_to_i128(
        value
            .unsigned_abs()
            .checked_mul(numerator)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?,
    )?
    .checked_mul(value.signum())
    .ok_or_else(math_error!())?;
    Ok(proportional_value)
}

pub fn get_proportion_u128(
    value: u128,
    numerator: u128,
    denominator: u128,
) -> ClearingHouseResult<u128> {
    let proportional_value = value
        .checked_mul(numerator)
        .ok_or_else(math_error!())?
        .checked_div(denominator)
        .ok_or_else(math_error!())?;
    Ok(proportional_value)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::state::user::MarketPosition;

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

    mod compute_settle_lp_metrics {
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

            let lp_metrics = compute_settle_lp_metrics(&amm, &position).unwrap();

            assert_eq!(lp_metrics.base_asset_amount, 10 * 100);
            assert_eq!(lp_metrics.quote_asset_amount, -10 * 100);
            assert_eq!(lp_metrics.remainder_quote_asset_amount, 0);
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

            let lp_metrics = compute_settle_lp_metrics(&amm, &position).unwrap();

            assert_eq!(lp_metrics.base_asset_amount, 0);
            assert_eq!(lp_metrics.quote_asset_amount, 0);
            assert_eq!(lp_metrics.remainder_base_asset_amount, 10 * 100);
            assert_eq!(lp_metrics.remainder_quote_asset_amount, -10 * 100);
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

            let lp_metrics = compute_settle_lp_metrics(&amm, &position).unwrap();

            assert_eq!(lp_metrics.base_asset_amount, 9);
            assert_eq!(lp_metrics.quote_asset_amount, -9);
            assert_eq!(lp_metrics.remainder_base_asset_amount, 1);
            assert_eq!(lp_metrics.remainder_quote_asset_amount, -1);
        }
    }
}

//     #[test]
//     fn test_margin_requirements_user_long() {
//         let position = MarketPosition {
//             lp_shares: 300_000 * AMM_RESERVE_PRECISION,
//             ..MarketPosition::default()
//         };

//         // 500_000 * 1e13
//         let init_reserves: u128 = 5000000000000000000;
//         let amm = AMM {
//             // balanced market
//             base_asset_reserve: init_reserves,
//             quote_asset_reserve: init_reserves,
//             sqrt_k: init_reserves,
//             user_lp_shares: position.lp_shares,
//             peg_multiplier: 53000,
//             ..AMM::default_test()
//         };
//         let mut market = Market {
//             amm,
//             ..Market::default()
//         };

//         let market_position = get_lp_market_position_margin(&position, &market).unwrap();
//         let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount().unwrap();
//         let balanced_position_base_asset_value =
//             calculate_base_asset_value(worst_case_base_asset_amount, &market.amm, false).unwrap();

//         // make the market unbalanced
//         let trade_size = 2_000 * AMM_RESERVE_PRECISION;
//         let (new_qar, new_bar) = calculate_swap_output(
//             trade_size,
//             amm.base_asset_reserve,
//             SwapDirection::Remove, // user longs
//             amm.sqrt_k,
//         )
//         .unwrap();
//         market.amm.quote_asset_reserve = new_qar;
//         market.amm.base_asset_reserve = new_bar;
//         market.amm.user_lp_shares = position.lp_shares;

//         // recompute margin requirements
//         let market_position = get_lp_market_position_margin(&position, &market).unwrap();
//         let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount().unwrap();
//         let unbalanced_position_base_asset_value =
//             calculate_base_asset_value(worst_case_base_asset_amount, &market.amm, false).unwrap();

//         println!(
//             "base v: {} {}",
//             balanced_position_base_asset_value, unbalanced_position_base_asset_value,
//         );

//         assert!(unbalanced_position_base_asset_value > balanced_position_base_asset_value);
//     }

//     #[test]
//     fn test_lp_margin_requirements_limits() {
//         let position = MarketPosition {
//             lp_shares: 100 * AMM_RESERVE_PRECISION,
//             ..MarketPosition::default()
//         };

//         // 500_000 * 1e13
//         let init_reserves: u128 = 5000000000000000000;

//         // lp is 0.02% (100/500_000)
//         let amm = AMM {
//             // balanced market
//             base_asset_reserve: init_reserves,
//             quote_asset_reserve: init_reserves,
//             sqrt_k: init_reserves,
//             user_lp_shares: position.lp_shares,
//             peg_multiplier: 53000,
//             ..AMM::default_test()
//         };
//         let mut market = Market {
//             amm,
//             ..Market::default()
//         };

//         assert_eq!(position.open_asks, 0);
//         assert_eq!(position.open_bids, 0);
//         assert_eq!(position.open_orders, 0);
//         let market_position = get_lp_market_position_margin(&position, &market).unwrap();
//         assert_eq!(market_position.open_asks, 414200000000000);
//         assert_eq!(market_position.open_bids, 292886437561872);
//         assert_eq!(market_position.open_orders, 0); // todo?

//         let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount().unwrap();
//         let balanced_position_base_asset_value =
//             calculate_base_asset_value(worst_case_base_asset_amount, &market.amm, false).unwrap();

//         // (500000*1e13 * 14142 / 10000 - 500000*1e13)/1e13 * .0002 = 41.42
//         assert_eq!(worst_case_base_asset_amount, 414200000000000);
//         assert_eq!(balanced_position_base_asset_value, 2195078159); //$2195.078159

//         // make the market unbalanced
//         let trade_size = 229_000 * AMM_RESERVE_PRECISION;
//         let (new_qar, new_bar) = calculate_swap_output(
//             trade_size,
//             amm.base_asset_reserve,
//             SwapDirection::Remove, // user longs
//             amm.sqrt_k,
//         )
//         .unwrap();
//         market.amm.quote_asset_reserve = new_qar;
//         market.amm.base_asset_reserve = new_bar;
//         market.amm.user_lp_shares = position.lp_shares;

//         // recompute margin requirements
//         assert_eq!(position.open_asks, 0);
//         assert_eq!(position.open_bids, 0);
//         assert_eq!(position.open_orders, 0);

//         let market_position = get_lp_market_position_margin(&position, &market).unwrap();
//         let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount().unwrap();
//         let unbalanced_position_base_asset_value =
//             calculate_base_asset_value(worst_case_base_asset_amount, &market.amm, false).unwrap();

//         assert_eq!(market_position.open_asks, 872200000000000); //87.22
//         assert_eq!(market_position.open_bids, 0);
//         assert_eq!(market_position.open_orders, 0); // todo?

//         assert_eq!(worst_case_base_asset_amount, 872200000000000);
//         assert_eq!(unbalanced_position_base_asset_value, 15730902011);

//         println!(
//             "base v: {} {}",
//             balanced_position_base_asset_value, unbalanced_position_base_asset_value,
//         );

//         assert!(unbalanced_position_base_asset_value > balanced_position_base_asset_value);
//     }

// unsure how to write this - the margin risk of the shorts are always larger than the
// amount of longs even if longs >> shorts
// #[test]
// fn test_margin_requirements_user_short() {
//     let position = MarketPosition {
//         lp_shares: 300_000 * AMM_RESERVE_PRECISION,
//         ..MarketPosition::default()
//     };

//     // 500_000 * 1e13
//     let init_reserves: u128 = 5000000000000000000;
//     let amm = AMM {
//         // balanced market
//         base_asset_reserve: init_reserves,
//         quote_asset_reserve: init_reserves,
//         sqrt_k: init_reserves,
//         peg_multiplier: 53000,
//         ..AMM::default_test()
//     };
//     let mut market = Market {
//         amm,
//         ..Market::default()
//     };

//     let market_position= get_lp_market_position_margin(&position, &market).unwrap();
//     let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount().unwrap();
//     let balanced_position_base_asset_value =
//         calculate_base_asset_value(worst_case_base_asset_amount, &market.amm, false).unwrap();

//     // make the market unbalanced
//     // note we gotta short a lot more bc theres more risk to lps going short than long
//     let trade_size = 200_000 * AMM_RESERVE_PRECISION;
//     let (new_qar, new_bar) = calculate_swap_output(
//         trade_size,
//         amm.base_asset_reserve,
//         SwapDirection::Add, // user shorts
//         amm.sqrt_k,
//     )
//     .unwrap();
//     market.amm.quote_asset_reserve = new_qar;
//     market.amm.base_asset_reserve = new_bar;

//     // recompute margin requirements
//     let market_position= get_lp_market_position_margin(&position, &market).unwrap();
//     let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount().unwrap();
//     let unbalanced_position_base_asset_value =
//         calculate_base_asset_value(worst_case_base_asset_amount, &market.amm, false).unwrap();

//     println!(
//         "base v: {} {}",
//         balanced_position_base_asset_value,
//         unbalanced_position_base_asset_value,
//     );
//     assert!(unbalanced_position_base_asset_value > balanced_position_base_asset_value);
// }

//     #[test]
//     fn test_no_change_metrics() {
//         let position = MarketPosition {
//             lp_shares: 100,
//             last_net_base_asset_amount_per_lp: 100,
//             ..MarketPosition::default()
//         };
//         let per_lp_position = MarketPosition {
//             base_asset_amount: 100,
//             ..MarketPosition::default()
//         };
//         let amm = AMM {
//             market_position_per_lp: per_lp_position,
//             sqrt_k: 200,
//             ..AMM::default_test()
//         };

//         let metrics = get_lp_metrics(&position, &amm).unwrap();

//         assert_eq!(metrics.base_asset_amount, 0);
//         assert_eq!(metrics.unsettled_pnl, 0); // no neg upnl
//     }

//     #[test]
//     fn test_too_small_metrics() {
//         let position = MarketPosition {
//             lp_shares: 100 * AMM_RESERVE_PRECISION,
//             last_net_base_asset_amount_per_lp: 70 * AMM_RESERVE_PRECISION_I128,
//             ..MarketPosition::default()
//         };

//         let amm = AMM {
//             // cumulative_net_base_asset_amount_per_lp: 100 * AMM_RESERVE_PRECISION_I128,
//             net_base_asset_amount: 100 * AMM_RESERVE_PRECISION_I128, // users went long
//             market_position_per_lp: MarketPosition {
//                 base_asset_amount: 71 * AMM_RESERVE_PRECISION_I128, //todo
//                 quote_asset_amount: 0,
//                 ..MarketPosition::default()
//             },
//             peg_multiplier: 1,
//             sqrt_k: 900 * AMM_RESERVE_PRECISION,
//             base_asset_amount_step_size: 1000 * AMM_RESERVE_PRECISION, // min size is big
//             minimum_quote_asset_trade_size: 100 * AMM_RESERVE_PRECISION,
//             ..AMM::default_test()
//         };

//         let metrics = get_lp_metrics(&position, &amm).unwrap();

//         println!("{:#?}", metrics);
//         assert!(metrics.unsettled_pnl < 0);
//         assert_eq!(metrics.base_asset_amount, 0);
//     }

//     #[test]
//     fn test_simple_metrics() {
//         let position = MarketPosition {
//             lp_shares: 1000 * AMM_RESERVE_PRECISION,
//             last_net_base_asset_amount_per_lp: 0,
//             ..MarketPosition::default()
//         };
//         let init_reserves = 2000 * AMM_RESERVE_PRECISION;
//         let amm = AMM {
//             market_position_per_lp: MarketPosition {
//                 base_asset_amount: -100 * AMM_RESERVE_PRECISION_I128,
//                 quote_asset_amount: 100 * QUOTE_PRECISION,
//                 unsettled_pnl: 100,
//                 ..MarketPosition::default()
//             },
//             last_funding_rate_long: 100,
//             sqrt_k: init_reserves,
//             base_asset_reserve: init_reserves,
//             quote_asset_reserve: init_reserves,
//             peg_multiplier: PEG_PRECISION,
//             base_asset_amount_step_size: 1,
//             minimum_quote_asset_trade_size: 1,
//             ..AMM::default_test()
//         };

//         let metrics = get_lp_metrics(&position, &amm).unwrap();
//         println!("{:#?}", metrics);

//         // let shares_ = position.lp_shares as i128 / AMM_RESERVE_PRECISION_I128;
//         // assert_eq!(
//         //     metrics.base_asset_amount,
//         //     -100_i128 * position.lp_shares as i128
//         // );
//         // assert_eq!(
//         //     metrics.fee_payment,
//         //     (amm.cumulative_fee_per_lp as i128) * shares_
//         // );
//         // assert_eq!(
//         //     metrics.funding_payment,
//         //     amm.cumulative_funding_payment_per_lp * shares_
//         // );
//     }
// }
