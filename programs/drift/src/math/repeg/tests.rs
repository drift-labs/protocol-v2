use crate::controller::amm::{calculate_perp_market_amm_summary_stats, SwapDirection};
use crate::math::constants::{
    AMM_RESERVE_PRECISION, MAX_CONCENTRATION_COEFFICIENT, PRICE_PRECISION, PRICE_PRECISION_U64,
    QUOTE_PRECISION,
};
use crate::math::repeg::*;
use crate::state::oracle::HistoricalOracleData;
use crate::state::spot_market::SpotMarket;
use crate::state::state::{PriceDivergenceGuardRails, State, ValidityGuardRails};
use crate::test_utils::create_account_info;
use anchor_lang::prelude::AccountLoader;
use solana_program::pubkey::Pubkey;
use std::str::FromStr;

#[test]
fn calc_peg_tests() {
    let qar = AMM_RESERVE_PRECISION;
    let bar = AMM_RESERVE_PRECISION;
    let px = 19401125456; // 19401.125

    let mut new_peg = calculate_peg_from_target_price(qar, bar, px).unwrap();
    assert_eq!(new_peg, 19401125456);
    new_peg = calculate_peg_from_target_price(qar - 10000, bar + 10000, px).unwrap();
    assert_eq!(new_peg, 19401513482);
    new_peg = calculate_peg_from_target_price(qar + 10000, bar - 10000, px).unwrap();
    assert_eq!(new_peg, 19400737437);
    new_peg = calculate_peg_from_target_price(qar / 2, bar * 2, px).unwrap();
    assert_eq!(new_peg, 77604501824);

    let px2 = PRICE_PRECISION_U64 + (PRICE_PRECISION_U64 / 10000) * 5;
    new_peg = calculate_peg_from_target_price(qar, bar, px2).unwrap();
    assert_eq!(new_peg, 1000500);
    new_peg = calculate_peg_from_target_price(qar, bar, px2 - 1).unwrap();
    assert_eq!(new_peg, 1000499);
}

#[test]
fn calculate_optimal_peg_and_budget_test() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 65 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 63015384615,
            terminal_quote_asset_reserve: 64 * AMM_RESERVE_PRECISION,
            sqrt_k: 64 * AMM_RESERVE_PRECISION,
            peg_multiplier: 19_400_000_000,
            base_asset_amount_with_amm: -(AMM_RESERVE_PRECISION as i128),
            mark_std: PRICE_PRECISION as u64,
            last_mark_price_twap_ts: 0,
            base_spread: 250,
            curve_update_intensity: 100,
            max_spread: 500 * 100,
            total_exchange_fee: QUOTE_PRECISION,
            total_fee_minus_distributions: (40 * QUOTE_PRECISION) as i128,
            ..AMM::default()
        },
        margin_ratio_initial: 500,

        ..PerpMarket::default()
    };

    let reserve_price = market.amm.reserve_price().unwrap();
    assert_eq!(reserve_price, 18807668638); //$ 18,807.6686390578

    // positive target_price_gap exceeding max_spread
    let oracle_price_data = OraclePriceData {
        price: (12_400 * PRICE_PRECISION) as i64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };
    let mm_oracle_price_data = MMOraclePriceData::new(
        oracle_price_data.price,
        oracle_price_data.delay + 1,
        0,
        OracleValidity::default(),
        oracle_price_data,
    )
    .unwrap();

    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &mm_oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 13110290527);
    assert_eq!(optimal_peg > oracle_price_data.price as u128, true);
    assert_eq!(budget, 6192944714);
    assert!(!check_lb);

    // positive target_price_gap within max_spread
    let oracle_price_data = OraclePriceData {
        price: (18_901 * PRICE_PRECISION) as i64,
        confidence: 167,
        delay: 21,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };
    let mm_oracle_price_data = MMOraclePriceData::new(
        oracle_price_data.price,
        oracle_price_data.delay + 1,
        0,
        OracleValidity::default(),
        oracle_price_data,
    )
    .unwrap();
    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &mm_oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 19496270752);
    assert_eq!(budget, 39500000);
    assert!(check_lb);

    // positive target_price_gap 2 within max_spread?
    let oracle_price_data = OraclePriceData {
        price: (18_601 * PRICE_PRECISION) as i64,
        confidence: 167,
        delay: 21,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };
    let mm_oracle_price_data = MMOraclePriceData::new(
        oracle_price_data.price,
        oracle_price_data.delay + 1,
        0,
        OracleValidity::default(),
        oracle_price_data,
    )
    .unwrap();
    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &mm_oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 19186822509);
    assert_eq!(budget, 39500000);
    assert!(check_lb);

    // negative target_price_gap within max_spread
    let oracle_price_data = OraclePriceData {
        price: (20_400 * PRICE_PRECISION) as i64,
        confidence: 1234567,
        delay: 21,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };
    let mm_oracle_price_data = MMOraclePriceData::new(
        oracle_price_data.price,
        oracle_price_data.delay + 1,
        0,
        OracleValidity::default(),
        oracle_price_data,
    )
    .unwrap();
    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &mm_oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 21042480468);
    assert_eq!(budget, 39500000);
    assert!(check_lb);

    // negative target_price_gap exceeding max_spread (in favor of vAMM)
    let oracle_price_data = OraclePriceData {
        price: (42_400 * PRICE_PRECISION) as i64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };
    let mm_oracle_price_data = MMOraclePriceData::new(
        oracle_price_data.price,
        oracle_price_data.delay + 1,
        0,
        OracleValidity::default(),
        oracle_price_data,
    )
    .unwrap();
    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &mm_oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 43735351562);
    assert_eq!(budget, 39500000);
    assert!(check_lb);

    market.amm.base_asset_amount_with_amm = AMM_RESERVE_PRECISION as i128;

    let swap_direction = if market.amm.base_asset_amount_with_amm > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (new_terminal_quote_reserve, _new_terminal_base_reserve) = amm::calculate_swap_output(
        market.amm.base_asset_amount_with_amm.unsigned_abs(),
        market.amm.base_asset_reserve,
        swap_direction,
        market.amm.sqrt_k,
    )
    .unwrap();

    market.amm.terminal_quote_asset_reserve = new_terminal_quote_reserve;

    // negative target_price_gap exceeding max_spread (not in favor of vAMM)
    let oracle_price_data = OraclePriceData {
        price: (42_400 * PRICE_PRECISION) as i64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };
    let mm_oracle_price_data = MMOraclePriceData::new(
        oracle_price_data.price,
        oracle_price_data.delay + 1,
        0,
        OracleValidity::default(),
        oracle_price_data,
    )
    .unwrap();
    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &mm_oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 42641967773);
    assert_eq!(budget, 22190932405); // $2219.032405
    assert!(!check_lb);
}

#[test]
fn calculate_optimal_peg_and_budget_2_test() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 2270516211133,
            quote_asset_reserve: 2270925669621,
            terminal_quote_asset_reserve: 2270688451627,
            sqrt_k: 2270720931148,
            peg_multiplier: 17723081263,
            base_asset_amount_with_amm: 237200000,
            mark_std: 43112524,
            last_mark_price_twap_ts: 0,
            base_spread: 250,
            curve_update_intensity: 100,
            max_spread: 500 * 100,
            total_exchange_fee: 298628987,
            total_fee_minus_distributions: -242668966,
            total_fee_withdrawn: 124247717,
            concentration_coef: 1020710,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: 17765940050,
                last_oracle_price_twap_5min: 17763317077,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 500,

        ..PerpMarket::default()
    };
    let (new_terminal_quote_reserve, new_terminal_base_reserve) =
        amm::calculate_terminal_reserves(&market.amm).unwrap();
    market.amm.terminal_quote_asset_reserve = new_terminal_quote_reserve;
    let (min_base_asset_reserve, max_base_asset_reserve) =
        amm::calculate_bid_ask_bounds(market.amm.concentration_coef, new_terminal_base_reserve)
            .unwrap();
    market.amm.min_base_asset_reserve = min_base_asset_reserve;
    market.amm.max_base_asset_reserve = max_base_asset_reserve;

    let oracle_price_data = OraclePriceData {
        price: (17_800 * PRICE_PRECISION) as i64,
        confidence: 10233,
        delay: 0,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };
    let mm_oracle_price_data = MMOraclePriceData::new(
        oracle_price_data.price,
        oracle_price_data.delay + 1,
        0,
        OracleValidity::default(),
        oracle_price_data,
    )
    .unwrap();

    let (optimal_peg, budget, check_lb) =
        calculate_optimal_peg_and_budget(&market, &mm_oracle_price_data).unwrap();

    assert_eq!(optimal_peg, 17796790576);
    assert_eq!(optimal_peg > oracle_price_data.price as u128, false);
    assert_eq!(budget, 0);
    assert_eq!(check_lb, false); // because market.amm.total_fee_minus_distributions < get_total_fee_lower_bound(market)?.cast()
    use crate::controller::repeg::*;

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_percent_divergence: 1,
                oracle_twap_5min_percent_divergence: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
        },
        ..State::default()
    };

    // test amm update
    assert_eq!(market.amm.last_update_slot, 0);
    let c = _update_amm(&mut market, &mm_oracle_price_data, &state, 1, 1337).unwrap();
    assert!(market.amm.is_recent_oracle_valid(1337).unwrap());
    assert!(!market.amm.is_recent_oracle_valid(1338).unwrap());
    assert!(!market.amm.is_recent_oracle_valid(1336).unwrap());

    assert_eq!(c, 442);
    assert_eq!(market.amm.last_update_slot, 1337);
}

#[test]
fn calc_adjust_amm_tests_repeg_in_favour() {
    // btc-esque market
    let market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 65 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 63015384615,
            terminal_quote_asset_reserve: 64 * AMM_RESERVE_PRECISION,
            sqrt_k: 64 * AMM_RESERVE_PRECISION,
            peg_multiplier: 19_400_000_000,
            base_asset_amount_with_amm: AMM_RESERVE_PRECISION as i128,
            mark_std: PRICE_PRECISION as u64,
            last_mark_price_twap_ts: 0,
            curve_update_intensity: 100,
            ..AMM::default()
        },
        ..PerpMarket::default()
    };

    let prev_price = market.amm.reserve_price().unwrap();

    let px = 20_401_125_456;
    let optimal_peg = calculate_peg_from_target_price(
        market.amm.quote_asset_reserve,
        market.amm.base_asset_reserve,
        px,
    )
    .unwrap();
    assert!(optimal_peg > market.amm.peg_multiplier);

    let (repegged_market, _amm_update_cost) = adjust_amm(&market, optimal_peg, 0, true).unwrap();
    assert_eq!(_amm_update_cost, -1618354580);
    assert_eq!(repegged_market.amm.peg_multiplier, optimal_peg);

    let post_price = repegged_market.amm.reserve_price().unwrap();
    assert_eq!(post_price - prev_price, 1593456817); // todo: (15934564582252/1e4 - 1615699103 is the slippage cost?)
}

#[test]
fn calc_adjust_amm_tests_sufficent_fee_for_repeg() {
    // btc-esque market
    let mut market = PerpMarket {
        amm: AMM {
            order_step_size: 1000,
            base_asset_reserve: 60437939720095,
            quote_asset_reserve: 60440212459368,
            terminal_quote_asset_reserve: 60439072663003,
            sqrt_k: 60439076079049,
            peg_multiplier: 34353000,
            base_asset_amount_with_amm: AMM_RESERVE_PRECISION as i128,
            last_mark_price_twap: 34128370,
            last_mark_price_twap_ts: 165705,
            curve_update_intensity: 100,
            base_spread: 1000,
            total_fee_minus_distributions: 304289,
            total_fee: 607476,
            total_exchange_fee: 0, // new fee pool lowerbound
            funding_period: 3600,
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,

            ..AMM::default()
        },
        next_curve_record_id: 1,
        next_fill_record_id: 4,
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,

        ..PerpMarket::default()
    };
    let (new_terminal_quote_reserve, new_terminal_base_reserve) =
        amm::calculate_terminal_reserves(&market.amm).unwrap();
    market.amm.terminal_quote_asset_reserve = new_terminal_quote_reserve;
    let (min_base_asset_reserve, max_base_asset_reserve) =
        amm::calculate_bid_ask_bounds(market.amm.concentration_coef, new_terminal_base_reserve)
            .unwrap();
    market.amm.min_base_asset_reserve = min_base_asset_reserve;
    market.amm.max_base_asset_reserve = max_base_asset_reserve;

    let px = 35768 * PRICE_PRECISION_U64 / 1000;
    let optimal_peg = calculate_peg_from_target_price(
        market.amm.quote_asset_reserve,
        market.amm.base_asset_reserve,
        px,
    )
    .unwrap();
    assert!(optimal_peg > market.amm.peg_multiplier);
    let fee_budget = calculate_fee_pool(&market).unwrap();
    assert!(fee_budget > 0);
    let (repegged_market, _amm_update_cost) =
        adjust_amm(&market, optimal_peg, fee_budget, true).unwrap();

    // insufficient fee to repeg
    let new_peg = repegged_market.amm.peg_multiplier;
    let old_peg = market.amm.peg_multiplier;
    assert!(new_peg > old_peg);
    assert_eq!(new_peg, 34657283);
    assert_eq!(_amm_update_cost, 304289);
}

#[test]
pub fn adjust_amm_with_market_config_flag_sol_perp() {
    let key = Pubkey::default();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;

    // SOL (as of slot 405286944)
    let sol_perp_market_str = String::from("Ct8MLGv1N/dvAH3EF67yBqaUQerctpm4yqpK+QNSrXCQz76p+B+kaykDYiceTDtpx7UpBfc/oj+uGEGwhrIUjzR4ifH+lS/hmz8RBQAAAAAAAAAAAAAAAAEAAAAAAAAA+qkRBQAAAABdsRIFAAAAAPXwrmkAAAAAp70SNM7//////////////2sMl0Xy//////////////+UyH9qzikiAAAAAAAAAAAAAAAAAAAAAADHNPWsFz2SAAAAAAAAAAAAhzHLjKM4kgAAAAAAAAAAAG5SDwAAAAAAAAAAAAAAAACLPpzseKCRAAAAAAAAAAAA97ORgfHVkgAAAAAAAAAAAIoIiZjdOpIAAAAAAAAAAAAdZxEFAAAAAAAAAAAAAAAAuEAQ2Nc6kgAAAAAAAAAAAICJC3h9gAEAAAAAAAAAAAAATAE0Tn3+////////////gNUMrMv9/////////////wAAAAAAAAAAAAAAAAAAAAAAAI1J/RoHAAAAAAAAAAAAfbeUXMsCAAAAAAAAAAAAALM6d4UT1f////////////9TaN/Uhi4AAAAAAAAAAAAAwJZAVILV/////////////1fY3ejmLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF+7w//////8X7vD//////xfu8P//////iZXt//////8BkLGF4hkAAAAAAAAAAAAA/9rK5xkKAAAAAAAAAAAAAIyTM6vsDwAAAAAAAAAAAAALZ/MIBA0AAAAAAAAAAAAAtl1xa5QHAAAAAAAAAAAAAAbyD4kRBQAAAAAAAAAAAADIlVF0CgAAAAAAAAAAAAAATToHaAoAAAAAAAAAAAAAAMG4+QwBAAAAAAAAAAAAAADp2do2nzOSAAAAAAAAAAAAn64XVhxCkgAAAAAAAAAAAF/j6uMubJIAAAAAAAAAAAAow4/pnAmSAAAAAAAAAAAAmz8RBQAAAAAAAAAAAAAAAGcrEAUAAAAATN0RBQAAAABZBBEFAAAAADzvEQUAAAAAAjAoGAAAAAC+AAAAAAAAAJAyDfn/////iO6uaQAAAAAQDgAAAAAAAICWmAAAAAAAZAAAAAAAAACAlpgAAAAAACAwKBgAAAAA8fLbFL0TAADvZhhOZwAAAFsXAa20AAAA6vCuaQAAAACvZAEAAAAAANR/AQAAAAAA9fCuaQAAAADIAAAAIE4AAIoDAABACAAAILEQBQAAAACoYTIAaGQMAcDIUt4DFGT/IBbypJlMBgCAL3r//////9zgRcTl////cP7//+wAAAAscxEFAAAAAHcZvwS/fRUAAAAAAAAAAAAAAAAAAAAAAFNPTC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAB8K+v////8A4fUFAAAAAAAQpdToAAAAdlCOnysAAAAy5K5pAAAAAEBCDwAAAAAAAAAAAAAAAAAAAAAAAAAAANY49gAAAAAAKnIAAAAAAAC4EwAAAAAAADIAAAAAAAAATB0AAEwdAAD0AQAALAEAAAAAAAAQJwAAcQ0AAKIJAAAAAAEAAQAAAAAAAAAAAGMAQgAAAAQBAALcbg8FAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");

    let mut sol_perp_decoded = base64::decode(sol_perp_market_str).unwrap();
    let sol_perp_account_info = create_account_info(
        &key,
        true,
        &mut lamports,
        sol_perp_decoded.as_mut_slice(),
        &owner,
    );

    let sol_perp_market = *AccountLoader::<PerpMarket>::try_from(&sol_perp_account_info)
        .unwrap()
        .load_mut()
        .unwrap();

    // USDC (as of slot 405455796)
    let usdc_spot_market_str = String::from("ZLEIa6hBQSdUX6MOo7w/PClm2otsPf7406t9pXygIypU5KAmT//Dwn4XAskDe6KnOB2fuc5t8V0PxU10u3MRn4rxLxkMDhW+xvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWHmsHZFgFFAI49uEcLfeyYJqqXqJL+++g9w+I4yK2cfD1VTREMgICAgICAgICAgICAgICAgICAgICAgICAgICAgQEIPAAAAAABQAAAAAAAAACgAAAAAAAAAQUIPAAAAAABBQg8AAAAAADDzr2kAAAAAQEIPAAAAAABAQg8AAAAAAEBCDwAAAAAAQEIPAAAAAAAAAAAAAAAAAH5LYAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHkMifZGT+FrLhfKfHFav7xo95PrVMA7wMfE+znV7oDvxI9yfADAAAAAAAAAAAAABzkytCYAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgCMRAAAAAAAs7q9pAAAAABAOAAAAAAAAoIYBAFzBAAAAAAAAAAAAAAAAAAAAAAAAGtFjnVNGqQEAAAAAAAAAAHqqtnneIb4AAAAAAAAAAAAHPuHLAgAAAAAAAAAAAAAAhpMOQAMAAAAAAAAAAAAAAO9sZsUAAAAAAAAAAAAAAACPzWbFAAAAAAAAAAAAAAAAAJAexLwWAAAAQGNSv8YBAHeum3PwggAAeGO/Fe5DAAC8+QcAAAAAAKH0r2kAAAAAofSvaQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAABZO8IAAAAAABAnAAAQJwAAECcAABAnAAAAAAAAAAAAAIgTAAAANQwAFM0AAKC7DQAGAAAAAAAADwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKMFwEAAAAAAADpQcxrAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

    let mut usdc_spot_decoded = base64::decode(usdc_spot_market_str).unwrap();
    let usdc_spot_account_info = create_account_info(
        &key,
        true,
        &mut lamports,
        usdc_spot_decoded.as_mut_slice(),
        &owner,
    );

    let usdc_spot_market = *AccountLoader::<SpotMarket>::try_from(&usdc_spot_account_info)
        .unwrap()
        .load_mut()
        .unwrap();

    let baseline_oracle_price_data = OraclePriceData {
        price: sol_perp_market.amm.historical_oracle_data.last_oracle_price,
        confidence: sol_perp_market.amm.historical_oracle_data.last_oracle_conf,
        ..OraclePriceData::default()
    };

    // Refresh to avoid any integer drift
    let prev_total_fee_minus_distributions = calculate_perp_market_amm_summary_stats(
        &sol_perp_market,
        &usdc_spot_market,
        baseline_oracle_price_data.price,
        true,
    )
    .unwrap();

    // Case 1: oracle/peg moves in direction of amm, no-op
    {
        let mut case_market = sol_perp_market.clone();
        let favorable_oracle_move_pct = 10; // When oracle moves favorably (reducing AMM exposure)
        let base_price = case_market.amm.historical_oracle_data.last_oracle_price;
        let price_extend = base_price * favorable_oracle_move_pct / 100;

        // Note: base_asset_amount_with_amm is from user's perspective, amm's inventory is opposite
        let new_oracle_price_data = if case_market.amm.base_asset_amount_with_amm >= 0 {
            OraclePriceData {
                price: base_price - price_extend,
                confidence: case_market.amm.historical_oracle_data.last_oracle_conf,
                ..OraclePriceData::default()
            }
        } else {
            OraclePriceData {
                price: base_price + price_extend,
                confidence: case_market.amm.historical_oracle_data.last_oracle_conf,
                ..OraclePriceData::default()
            }
        };

        let mm_oracle_price_data = MMOraclePriceData::new(
            new_oracle_price_data.price,
            new_oracle_price_data.delay,
            new_oracle_price_data.sequence_id.unwrap_or(0),
            OracleValidity::Valid,
            new_oracle_price_data,
        )
        .unwrap();

        let (optimal_peg, fee_budget, _) =
            calculate_optimal_peg_and_budget(&case_market, &mm_oracle_price_data).unwrap();

        // Ensure with/without flag has no effect
        let (adjusted_without_flag, _) =
            adjust_amm(&case_market, optimal_peg, fee_budget, true).unwrap();

        // With flag
        case_market.market_config = MarketConfigFlag::DisableFormulaicKUpdate as u8;
        let (adjusted_with_flag, _) =
            adjust_amm(&case_market, optimal_peg, fee_budget, true).unwrap();

        assert_eq!(adjusted_without_flag.amm.peg_multiplier, optimal_peg);
        assert_eq!(adjusted_with_flag.amm.peg_multiplier, optimal_peg);
        assert_eq!(
            adjusted_without_flag.amm.peg_multiplier,
            adjusted_with_flag.amm.peg_multiplier
        );
        assert_eq!(
            adjusted_without_flag.amm.sqrt_k,
            adjusted_with_flag.amm.sqrt_k
        );

        // Positive trade, expected increase in total_fee_minus_distributions
        let without_flag_new_total_fee_minus_distributions =
            calculate_perp_market_amm_summary_stats(
                &adjusted_without_flag,
                &usdc_spot_market,
                new_oracle_price_data.price,
                true,
            )
            .unwrap();

        let with_flag_new_total_fee_minus_distributions = calculate_perp_market_amm_summary_stats(
            &adjusted_with_flag,
            &usdc_spot_market,
            new_oracle_price_data.price,
            true,
        )
        .unwrap();

        assert!(
            prev_total_fee_minus_distributions < without_flag_new_total_fee_minus_distributions
        );
        assert!(prev_total_fee_minus_distributions < with_flag_new_total_fee_minus_distributions)
    }

    // Case 2: oracle/peg moves in opposite direction of amm
    {
        let case_market = sol_perp_market.clone();
        let adverse_oracle_move_pct = 50; // When oracle moves adversely (increasing AMM exposure)
        let base_price = case_market.amm.historical_oracle_data.last_oracle_price;
        let price_extend = base_price * adverse_oracle_move_pct / 100;

        // Inverse of Case 1
        let new_oracle_price_data = if case_market.amm.base_asset_amount_with_amm >= 0 {
            OraclePriceData {
                price: base_price + price_extend,
                confidence: case_market.amm.historical_oracle_data.last_oracle_conf,
                ..OraclePriceData::default()
            }
        } else {
            OraclePriceData {
                price: base_price - price_extend,
                confidence: case_market.amm.historical_oracle_data.last_oracle_conf,
                ..OraclePriceData::default()
            }
        };

        let mm_oracle_price_data = MMOraclePriceData::new(
            new_oracle_price_data.price,
            new_oracle_price_data.delay,
            new_oracle_price_data.sequence_id.unwrap_or(0),
            OracleValidity::Valid,
            new_oracle_price_data,
        )
        .unwrap();

        let (optimal_peg, fee_budget, _) =
            calculate_optimal_peg_and_budget(&case_market, &mm_oracle_price_data).unwrap();

        // Case 2a: zero budget, forces K shrink path
        {
            let mut case_market_2a = case_market.clone();
            let fee_budget_zero = 0_u128;

            let (adjusted_without_flag, _) =
                adjust_amm(&case_market_2a, optimal_peg, fee_budget_zero, true).unwrap();

            case_market_2a.market_config = MarketConfigFlag::DisableFormulaicKUpdate as u8;
            let (adjusted_with_flag, _) =
                adjust_amm(&case_market_2a, optimal_peg, fee_budget_zero, true).unwrap();

            assert!(adjusted_without_flag.amm.sqrt_k < case_market.amm.sqrt_k);
            assert_eq!(adjusted_with_flag.amm.sqrt_k, case_market.amm.sqrt_k);

            let without_flag_new_total_fee_minus_distributions =
                calculate_perp_market_amm_summary_stats(
                    &adjusted_without_flag,
                    &usdc_spot_market,
                    new_oracle_price_data.price,
                    true,
                )
                .unwrap();
            let with_flag_new_total_fee_minus_distributions =
                calculate_perp_market_amm_summary_stats(
                    &adjusted_with_flag,
                    &usdc_spot_market,
                    new_oracle_price_data.price,
                    true,
                )
                .unwrap();

            assert!(
                prev_total_fee_minus_distributions > without_flag_new_total_fee_minus_distributions
            );
            assert!(
                prev_total_fee_minus_distributions > with_flag_new_total_fee_minus_distributions
            );
        }

        // Case 2b: sufficient budget, use_optimal_peg = true
        {
            let mut case_market_2b = case_market.clone();

            // Budget from calculate_optimal_peg_and_budget is naturally sufficient for SOL

            let (adjusted_without_flag, _) =
                adjust_amm(&case_market_2b, optimal_peg, fee_budget, true).unwrap();

            case_market_2b.market_config = MarketConfigFlag::DisableFormulaicKUpdate as u8;
            let (adjusted_with_flag, _) =
                adjust_amm(&case_market_2b, optimal_peg, fee_budget, true).unwrap();

            assert_eq!(
                adjusted_without_flag.amm.sqrt_k,
                adjusted_with_flag.amm.sqrt_k
            );
            assert_eq!(
                adjusted_without_flag.amm.peg_multiplier,
                adjusted_with_flag.amm.peg_multiplier
            );
            assert_eq!(adjusted_without_flag.amm.peg_multiplier, optimal_peg);
            assert_eq!(adjusted_without_flag.amm.sqrt_k, case_market.amm.sqrt_k);
        }
    }
}

#[test]
pub fn adjust_amm_with_market_config_flag_eth_perp() {
    let key = Pubkey::default();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;

    // ETH (as of slot 405287065)
    let eth_perp_market_str = String::from("Ct8MLGv1N/cP8V8Fb1epGNxhYovgt6QslGhUT6HV1zTpfCkrkbwLkndwx9kOHTTRdsq6+h4yZlyZWL2p6k8cVCwzZ4FGbCUqC9queAAAAAAAAAAAAAAAAAEAAAAAAAAA69KGeAAAAADnxs14AAAAADDxrmkAAAAAK2l1AgAAAAAAAAAAAAAAAA9wrAoAAAAAAAAAAAAAAAB1c9e2AjADAAAAAAAAAAAAAAAAAAAAAAC6LBzhfxUAAAAAAAAAAAAAc+TW3n8VAAAAAAAAAAAAAFdKDwAAAAAAAAAAAAAAAAAlZfx/dBUAAAAAAAAAAAAACf3/RYsVAAAAAAAAAAAAAI+I+d9/FQAAAAAAAAAAAAAzYMt4AAAAAAAAAAAAAAAAJM/4338VAAAAAAAAAAAAAAApz9B+AwAAAAAAAAAAAABA7A4ugfz/////////////QBXe/v///////////////wAAAAAAAAAAAAAAAAAAAAAAID2IeS0AAAAAAAAAAAAA8dNzMyoBAAAAAAAAAAAAAB8eSrpw9/////////////+oR/DymgkAAAAAAAAAAAAAIKXbq2n3/////////////y0GotS3CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA86GD///////zoYP///////Ohg///////3Gp4//////95VwGwvAMAAAAAAAAAAAAAd+LVwbQBAAAAAAAAAAAAANZLJzENAgAAAAAAAAAAAAAHsDasfP//////////////89kg4EsBAAAAAAAAAAAAAJPpFitAAQAAAAAAAAAAAADZE9QXEwEAAAAAAAAAAAAACMDfthIBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACp3ewFfRUAAAAAAAAAAAAARxZnuoIVAAAAAAAAAAAAANkITkGgFQAAAAAAAAAAAABQfSCvXxUAAAAAAAAAAAAAKUqweAAAAACNAwAAAAAAAM5MWngAAAAA1k2feAAAAABSzXx4AAAAAAs3v3gAAAAAmTAoGAAAAAAABQAAAAAAAK83AwAAAAAAiO6uaQAAAAAQDgAAAAAAAEBCDwAAAAAAECcAAAAAAABAQg8AAAAAAJkwKBgAAAAALaRyN+oCAABDkJ5NDAAAAEpq/00GAAAAC/GuaQAAAACw8iQAAAAAAJGvKQAAAAAAMPGuaQAAAACvAAAAECcAAA8EAACOLQAA/DWveAAAAAAgTjIAZQAMAcCmjPgAFBv/gPvMp5lMBgBAfkf3AQAAAHq8ojMAAAAAAAAAAAAFAAAUhXh4AAAAANmaVjsbBwMAAAAAAAAAAAAAAAAAAAAAAEVUSC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAA4fUFAAAAAP8PpdToAAAAup58GBIAAACkdwppAAAAAADh9QUAAAAAAAAAAAAAAAAAAAAAAAAAAAtVXAAAAAAAym4AAAAAAABuEAAAAAAAAPoAAAAAAAAAiBMAAEwdAAD0AQAAyAAAAAAAAAAQJwAAwgIAAKoCAAACAAEAAYAAAAAAAAAAAGMAQgAAAAAAAADQ+rF4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");

    let mut eth_perp_decoded = base64::decode(eth_perp_market_str).unwrap();
    let eth_perp_account_info = create_account_info(
        &key,
        true,
        &mut lamports,
        eth_perp_decoded.as_mut_slice(),
        &owner,
    );

    let eth_perp_market = *AccountLoader::<PerpMarket>::try_from(&eth_perp_account_info)
        .unwrap()
        .load_mut()
        .unwrap();

    // USDC (as of slot 405455796)
    let usdc_spot_market_str = String::from("ZLEIa6hBQSdUX6MOo7w/PClm2otsPf7406t9pXygIypU5KAmT//Dwn4XAskDe6KnOB2fuc5t8V0PxU10u3MRn4rxLxkMDhW+xvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWHmsHZFgFFAI49uEcLfeyYJqqXqJL+++g9w+I4yK2cfD1VTREMgICAgICAgICAgICAgICAgICAgICAgICAgICAgQEIPAAAAAABQAAAAAAAAACgAAAAAAAAAQUIPAAAAAABBQg8AAAAAADDzr2kAAAAAQEIPAAAAAABAQg8AAAAAAEBCDwAAAAAAQEIPAAAAAAAAAAAAAAAAAH5LYAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHkMifZGT+FrLhfKfHFav7xo95PrVMA7wMfE+znV7oDvxI9yfADAAAAAAAAAAAAABzkytCYAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgCMRAAAAAAAs7q9pAAAAABAOAAAAAAAAoIYBAFzBAAAAAAAAAAAAAAAAAAAAAAAAGtFjnVNGqQEAAAAAAAAAAHqqtnneIb4AAAAAAAAAAAAHPuHLAgAAAAAAAAAAAAAAhpMOQAMAAAAAAAAAAAAAAO9sZsUAAAAAAAAAAAAAAACPzWbFAAAAAAAAAAAAAAAAAJAexLwWAAAAQGNSv8YBAHeum3PwggAAeGO/Fe5DAAC8+QcAAAAAAKH0r2kAAAAAofSvaQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAABZO8IAAAAAABAnAAAQJwAAECcAABAnAAAAAAAAAAAAAIgTAAAANQwAFM0AAKC7DQAGAAAAAAAADwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKMFwEAAAAAAADpQcxrAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

    let mut usdc_spot_decoded = base64::decode(usdc_spot_market_str).unwrap();
    let usdc_spot_account_info = create_account_info(
        &key,
        true,
        &mut lamports,
        usdc_spot_decoded.as_mut_slice(),
        &owner,
    );

    let usdc_spot_market = *AccountLoader::<SpotMarket>::try_from(&usdc_spot_account_info)
        .unwrap()
        .load_mut()
        .unwrap();

    let baseline_oracle_price_data = OraclePriceData {
        price: eth_perp_market.amm.historical_oracle_data.last_oracle_price,
        confidence: eth_perp_market.amm.historical_oracle_data.last_oracle_conf,
        ..OraclePriceData::default()
    };

    // Refresh to avoid any integer drift
    let prev_total_fee_minus_distributions = calculate_perp_market_amm_summary_stats(
        &eth_perp_market,
        &usdc_spot_market,
        baseline_oracle_price_data.price,
        true,
    )
    .unwrap();

    // Case 1: oracle/peg moves in direction of amm, no-op
    {
        let mut case_market = eth_perp_market.clone();
        let favorable_oracle_move_pct = 10; // When oracle moves favorably (reducing AMM exposure)
        let base_price = case_market.amm.historical_oracle_data.last_oracle_price;
        let price_extend = base_price * favorable_oracle_move_pct / 100;

        // Note: base_asset_amount_with_amm is from user's perspective, amm's inventory is opposite
        let new_oracle_price_data = if case_market.amm.base_asset_amount_with_amm >= 0 {
            OraclePriceData {
                price: base_price - price_extend,
                confidence: case_market.amm.historical_oracle_data.last_oracle_conf,
                ..OraclePriceData::default()
            }
        } else {
            OraclePriceData {
                price: base_price + price_extend,
                confidence: case_market.amm.historical_oracle_data.last_oracle_conf,
                ..OraclePriceData::default()
            }
        };

        let mm_oracle_price_data = MMOraclePriceData::new(
            new_oracle_price_data.price,
            new_oracle_price_data.delay,
            new_oracle_price_data.sequence_id.unwrap_or(0),
            OracleValidity::Valid,
            new_oracle_price_data,
        )
        .unwrap();

        let (optimal_peg, fee_budget, _) =
            calculate_optimal_peg_and_budget(&case_market, &mm_oracle_price_data).unwrap();

        // Ensure with/without flag has no effect
        let (adjusted_without_flag, _) =
            adjust_amm(&case_market, optimal_peg, fee_budget, true).unwrap();

        // With flag
        case_market.market_config = MarketConfigFlag::DisableFormulaicKUpdate as u8;
        let (adjusted_with_flag, _) =
            adjust_amm(&case_market, optimal_peg, fee_budget, true).unwrap();

        assert_eq!(adjusted_without_flag.amm.peg_multiplier, optimal_peg);
        assert_eq!(adjusted_with_flag.amm.peg_multiplier, optimal_peg);
        assert_eq!(
            adjusted_without_flag.amm.peg_multiplier,
            adjusted_with_flag.amm.peg_multiplier
        );
        assert_eq!(
            adjusted_without_flag.amm.sqrt_k,
            adjusted_with_flag.amm.sqrt_k
        );

        // Positive trade, expected increase in total_fee_minus_distributions
        let without_flag_new_total_fee_minus_distributions =
            calculate_perp_market_amm_summary_stats(
                &adjusted_without_flag,
                &usdc_spot_market,
                new_oracle_price_data.price,
                true,
            )
            .unwrap();

        let with_flag_new_total_fee_minus_distributions = calculate_perp_market_amm_summary_stats(
            &adjusted_with_flag,
            &usdc_spot_market,
            new_oracle_price_data.price,
            true,
        )
        .unwrap();

        assert!(
            prev_total_fee_minus_distributions < without_flag_new_total_fee_minus_distributions
        );
        assert!(prev_total_fee_minus_distributions < with_flag_new_total_fee_minus_distributions)
    }

    // Case 2: oracle/peg moves in opposite direction of amm
    {
        let case_market = eth_perp_market.clone();
        let adverse_oracle_move_pct = 50; // When oracle moves adversely (increasing AMM exposure)
        let base_price = case_market.amm.historical_oracle_data.last_oracle_price;
        let price_extend = base_price * adverse_oracle_move_pct / 100;

        // Inverse of Case 1
        let new_oracle_price_data = if case_market.amm.base_asset_amount_with_amm >= 0 {
            OraclePriceData {
                price: base_price + price_extend,
                confidence: case_market.amm.historical_oracle_data.last_oracle_conf,
                ..OraclePriceData::default()
            }
        } else {
            OraclePriceData {
                price: base_price - price_extend,
                confidence: case_market.amm.historical_oracle_data.last_oracle_conf,
                ..OraclePriceData::default()
            }
        };

        let mm_oracle_price_data = MMOraclePriceData::new(
            new_oracle_price_data.price,
            new_oracle_price_data.delay,
            new_oracle_price_data.sequence_id.unwrap_or(0),
            OracleValidity::Valid,
            new_oracle_price_data,
        )
        .unwrap();

        let (optimal_peg, fee_budget, _) =
            calculate_optimal_peg_and_budget(&case_market, &mm_oracle_price_data).unwrap();

        // Case 2a: zero budget, forces K shrink path
        {
            let mut case_market_2a = case_market.clone();
            let fee_budget_zero = 0_u128;

            let (adjusted_without_flag, _) =
                adjust_amm(&case_market_2a, optimal_peg, fee_budget_zero, true).unwrap();

            case_market_2a.market_config = MarketConfigFlag::DisableFormulaicKUpdate as u8;
            let (adjusted_with_flag, _) =
                adjust_amm(&case_market_2a, optimal_peg, fee_budget_zero, true).unwrap();

            assert!(adjusted_without_flag.amm.sqrt_k < case_market.amm.sqrt_k);
            assert_eq!(adjusted_with_flag.amm.sqrt_k, case_market.amm.sqrt_k);

            let without_flag_new_total_fee_minus_distributions =
                calculate_perp_market_amm_summary_stats(
                    &adjusted_without_flag,
                    &usdc_spot_market,
                    new_oracle_price_data.price,
                    true,
                )
                .unwrap();
            let with_flag_new_total_fee_minus_distributions =
                calculate_perp_market_amm_summary_stats(
                    &adjusted_with_flag,
                    &usdc_spot_market,
                    new_oracle_price_data.price,
                    true,
                )
                .unwrap();

            assert!(
                prev_total_fee_minus_distributions > without_flag_new_total_fee_minus_distributions
            );
            assert!(
                prev_total_fee_minus_distributions > with_flag_new_total_fee_minus_distributions
            );
        }

        // Case 2b: sufficient budget, use_optimal_peg = true
        {
            let mut case_market_2b = case_market.clone();

            // Market's fee budget is insufficient for use_optimal_peg = true
            // Inflate 100x to test that flag has no effect when budget covers the peg move
            let fee_budget_2b = fee_budget * 100;

            let (adjusted_without_flag, _) =
                adjust_amm(&case_market_2b, optimal_peg, fee_budget_2b, true).unwrap();

            case_market_2b.market_config = MarketConfigFlag::DisableFormulaicKUpdate as u8;
            let (adjusted_with_flag, _) =
                adjust_amm(&case_market_2b, optimal_peg, fee_budget_2b, true).unwrap();

            assert_eq!(
                adjusted_without_flag.amm.sqrt_k,
                adjusted_with_flag.amm.sqrt_k
            );
            assert_eq!(
                adjusted_without_flag.amm.peg_multiplier,
                adjusted_with_flag.amm.peg_multiplier
            );
            assert_eq!(adjusted_without_flag.amm.peg_multiplier, optimal_peg);
            assert_eq!(adjusted_without_flag.amm.sqrt_k, case_market.amm.sqrt_k);
        }
    }
}
