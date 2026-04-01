use std::str::FromStr;

use crate::controller::amm::*;
use crate::controller::insurance::settle_revenue_to_insurance_fund;
use crate::controller::spot_balance::execute_transfer_between_pools;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, MAX_CONCENTRATION_COEFFICIENT, PRICE_PRECISION_I64, QUOTE_PRECISION,
    QUOTE_SPOT_MARKET_INDEX, SPOT_BALANCE_PRECISION, SPOT_CUMULATIVE_INTEREST_PRECISION,
};
use crate::state::events::TransferFeeAndPnlPoolDirection;
use crate::state::perp_market::{InsuranceClaim, PoolBalance};
use crate::state::user::SpotPosition;
use crate::test_utils::create_account_info;

#[test]
fn concentration_coef_tests() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            terminal_quote_asset_reserve: 500 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            base_asset_amount_with_amm: -12295081967,
            total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
            curve_update_intensity: 100,
            ..AMM::default()
        },
        ..PerpMarket::default()
    };

    assert!(update_concentration_coef(&mut market, 0).is_err());

    let new_scale = 1;
    update_concentration_coef(&mut market, new_scale).unwrap();
    assert_eq!(market.amm.min_base_asset_reserve, 353556781219);
    assert_eq!(market.amm.max_base_asset_reserve, 707100000000);

    let (orig_open_bids, orig_open_asks) =
        amm::calculate_market_open_bids_asks(&market.amm).unwrap();
    assert_eq!(orig_open_bids, 158738300748);
    assert_eq!(orig_open_asks, -194804918033);

    let new_scale = 2;
    update_concentration_coef(&mut market, new_scale).unwrap();
    assert_eq!(market.amm.min_base_asset_reserve, 414215889321);
    assert_eq!(market.amm.max_base_asset_reserve, 603550000000);

    let new_scale = 5;
    update_concentration_coef(&mut market, new_scale).unwrap();
    assert_eq!(market.amm.min_base_asset_reserve, 461748734808);
    assert_eq!(market.amm.max_base_asset_reserve, 541420000000);
    let new_sqrt_k = market.amm.sqrt_k * new_scale;
    let update_k_result = get_update_k_result(&market, bn::U192::from(new_sqrt_k), false).unwrap();
    let adjustment_cost = cp_curve::adjust_k_cost(&mut market, &update_k_result).unwrap();
    assert_eq!(adjustment_cost, 11_575_563);

    cp_curve::update_k(&mut market, &update_k_result).unwrap();
    assert_eq!(market.amm.sqrt_k, new_sqrt_k);

    let (open_bids, open_asks) = amm::calculate_market_open_bids_asks(&market.amm).unwrap();
    assert_eq!(open_bids, 207313827452);
    assert_eq!(open_asks, -198879016393);

    assert_eq!(orig_open_bids - open_bids, -48575526704);
    assert_eq!(orig_open_asks - open_asks, 4074098360);

    let new_scale = 100; // moves boundary to prevent base_asset_amount_with_amm to close
    assert!(update_concentration_coef(&mut market, new_scale).is_err());

    // different default market

    let mut market_balanced = PerpMarket::default_test();
    assert_eq!(market_balanced.amm.base_asset_amount_with_amm, 0);
    assert_eq!(market_balanced.amm.sqrt_k, 100000000000);

    let new_scale = 20;
    update_concentration_coef(&mut market_balanced, new_scale).unwrap();
    assert_eq!(market_balanced.amm.min_base_asset_reserve, 97971020172);
    assert_eq!(market_balanced.amm.max_base_asset_reserve, 102071000000);

    let new_scale = AMM_RESERVE_PRECISION; // too large, err
    assert!(update_concentration_coef(&mut market_balanced, new_scale).is_err());
    assert_eq!(market_balanced.amm.min_base_asset_reserve, 97971020172);
    assert_eq!(market_balanced.amm.max_base_asset_reserve, 102071000000);

    let new_scale = 140000; // near limit, very little liquidity
    update_concentration_coef(&mut market_balanced, new_scale).unwrap();
    assert_eq!(market_balanced.amm.min_base_asset_reserve, 99999800000);
    assert_eq!(market_balanced.amm.max_base_asset_reserve, 100000200000);

    let new_sqrt_k = market_balanced.amm.sqrt_k * new_scale;
    let update_k_result =
        get_update_k_result(&market_balanced, bn::U192::from(new_sqrt_k), false).unwrap();
    let adjustment_cost = cp_curve::adjust_k_cost(&mut market_balanced, &update_k_result).unwrap();
    assert_eq!(adjustment_cost, 0);

    cp_curve::update_k(&mut market_balanced, &update_k_result).unwrap();
    assert_eq!(market_balanced.amm.sqrt_k, new_sqrt_k);

    let (open_bids, open_asks) =
        amm::calculate_market_open_bids_asks(&market_balanced.amm).unwrap();
    assert_eq!(open_bids, 27999944001);
    assert_eq!(open_asks, -28000000000);
}

#[test]
fn formualic_k_tests() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            base_asset_amount_with_amm: -12295081967,
            total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
            curve_update_intensity: 100,
            ..AMM::default()
        },
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

    let prev_sqrt_k = market.amm.sqrt_k;

    // let reserve_price = market.amm.reserve_price().unwrap();
    let now = 10000;
    let oracle_price_data = OraclePriceData {
        price: 50 * PRICE_PRECISION_I64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };

    // zero funding cost
    let funding_cost: i128 = 0;
    formulaic_update_k(&mut market, &oracle_price_data, funding_cost, now).unwrap();
    assert_eq!(prev_sqrt_k, market.amm.sqrt_k);
    assert_eq!(
        market.amm.total_fee_minus_distributions,
        1000 * QUOTE_PRECISION as i128
    );

    // positive means amm supossedly paid $500 in funding payments for interval
    let funding_cost_2: i128 = (500 * QUOTE_PRECISION) as i128;
    formulaic_update_k(&mut market, &oracle_price_data, funding_cost_2, now).unwrap();
    assert_eq!(market.amm.sqrt_k, 499500000000); // max k decrease (.1%)
    assert!(prev_sqrt_k > market.amm.sqrt_k);
    assert_eq!(market.amm.total_fee_minus_distributions, 1000014768); //$.014768 acquired from slippage increase

    // negative means amm recieved $500 in funding payments for interval
    let funding_cost_2: i128 = -((500 * QUOTE_PRECISION) as i128);
    formulaic_update_k(&mut market, &oracle_price_data, funding_cost_2, now).unwrap();

    assert_eq!(market.amm.sqrt_k, 499999500000); // max k increase (.1%)
    assert_eq!(market.amm.total_fee_minus_distributions, 1000000013); //almost full spent from slippage decrease

    // negative means amm recieved $.001 in funding payments for interval
    let funding_cost_2: i128 = -((QUOTE_PRECISION / 1000) as i128);
    formulaic_update_k(&mut market, &oracle_price_data, funding_cost_2, now).unwrap();

    // new numbers bc of increased sqrt_k precision
    assert_eq!(market.amm.sqrt_k, 500015999983); // increase k by 1.000033x
    assert_eq!(market.amm.total_fee_minus_distributions - 1000000013, -486); // ~$0.000486 spent from slippage decrease
}

#[test]
fn formulaic_k_skip_with_market_config_flag() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            base_asset_amount_with_amm: -12295081967,
            total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
            curve_update_intensity: 100,
            ..AMM::default()
        },
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

    let prev_sqrt_k = market.amm.sqrt_k;

    // let reserve_price = market.amm.reserve_price().unwrap();
    let now = 10000;
    let oracle_price_data = OraclePriceData {
        price: 50 * PRICE_PRECISION_I64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };

    // zero funding cost
    let funding_cost: i128 = 0;
    formulaic_update_k(&mut market, &oracle_price_data, funding_cost, now).unwrap();
    assert_eq!(prev_sqrt_k, market.amm.sqrt_k);
    assert_eq!(
        market.amm.total_fee_minus_distributions,
        1000 * QUOTE_PRECISION as i128
    );

    // positive means amm supossedly paid $500 in funding payments for interval
    let funding_cost_2: i128 = (500 * QUOTE_PRECISION) as i128;

    // set bit flag to skip formulaic update
    market.market_config = MarketConfigFlag::DisableFormulaicKUpdate as u8;

    formulaic_update_k(&mut market, &oracle_price_data, funding_cost_2, now).unwrap();
    assert_eq!(prev_sqrt_k, market.amm.sqrt_k);

    // disable bit flag
    market.market_config = 0u8;

    formulaic_update_k(&mut market, &oracle_price_data, funding_cost_2, now).unwrap();
    assert!(prev_sqrt_k > market.amm.sqrt_k);
}

#[test]
fn iterative_bounds_formualic_k_tests() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            base_asset_amount_with_amm: -12295081967,
            total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
            curve_update_intensity: 100,
            ..AMM::default()
        },
        ..PerpMarket::default()
    };
    // let prev_sqrt_k = market.amm.sqrt_k;

    // let reserve_price = market.amm.reserve_price().unwrap();
    let now = 10000;
    let oracle_price_data = OraclePriceData {
        price: 50 * PRICE_PRECISION_I64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };

    // negative funding cost
    let mut count = 0;
    let mut prev_k = market.amm.sqrt_k;
    let mut new_k = 0;
    while prev_k != new_k && count < 10000 {
        let funding_cost = -(QUOTE_PRECISION as i128);
        prev_k = market.amm.sqrt_k;
        formulaic_update_k(&mut market, &oracle_price_data, funding_cost, now).unwrap();
        new_k = market.amm.sqrt_k;
        count += 1
    }

    assert_eq!(market.amm.base_asset_amount_with_amm, -12295081967);
    assert_eq!(market.amm.sqrt_k, 10958340658498292);
    assert_eq!(market.amm.total_fee_minus_distributions, 985_612_320);
}

#[test]
fn iterative_no_bounds_formualic_k_tests() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            base_asset_amount_with_amm: -12295081967,
            total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
            curve_update_intensity: 100,
            ..AMM::default()
        },
        ..PerpMarket::default()
    };
    // let prev_sqrt_k = market.amm.sqrt_k;

    // let reserve_price = market.amm.reserve_price().unwrap();
    let now = 10000;
    let oracle_price_data = OraclePriceData {
        price: 50 * PRICE_PRECISION_I64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };

    // negative funding cost
    let mut count = 0;
    let mut prev_k = market.amm.sqrt_k;
    let mut new_k = 0;
    while prev_k != new_k && count < 100000 && prev_k < MAX_SQRT_K * 99 / 100 {
        let funding_cost = -((QUOTE_PRECISION * 100000) as i128);
        prev_k = market.amm.sqrt_k;
        formulaic_update_k(&mut market, &oracle_price_data, funding_cost, now).unwrap();
        new_k = market.amm.sqrt_k;
        count += 1
    }

    assert_eq!(market.amm.base_asset_amount_with_amm, -12295081967);
    assert_eq!(market.amm.sqrt_k, 991917456633894384209); // below MAX_SQRT_K
    assert_eq!(market.amm.total_fee_minus_distributions, 985625029);
}

#[test]
fn update_pool_balances_test_high_util_borrow() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 5122950819670000,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000,
            base_asset_amount_with_amm: -122950819670000,
            total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
            curve_update_intensity: 100,
            ..AMM::default()
        },
        ..PerpMarket::default()
    };
    let now = 33928058;

    let mut spot_market = SpotMarket {
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        ..SpotMarket::default()
    };
    // 100% util
    spot_market.deposit_balance = 10_u128.pow(19_u32);
    spot_market.borrow_balance = 10_u128.pow(19_u32);
    spot_market.deposit_token_twap = 10_u64.pow(16_u32);

    // would lead to a borrow
    let mut spot_position = SpotPosition::default();

    let unsettled_pnl = -100;
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    let to_settle_with_user = update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        unsettled_pnl,
        now,
    )
    .unwrap();
    assert_eq!(to_settle_with_user, 0);

    // util is low => neg settle ok
    spot_market.borrow_balance = 0;
    let unsettled_pnl = -100;
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    let to_settle_with_user = update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        unsettled_pnl,
        now,
    )
    .unwrap();
    assert_eq!(to_settle_with_user, unsettled_pnl);

    // util is high
    spot_market.borrow_balance = 10_u128.pow(19_u32);
    // user has a little bit deposited => settle how much they have deposited
    update_spot_balances(
        50,
        &SpotBalanceType::Deposit,
        &mut spot_market,
        &mut spot_position,
        false,
    )
    .unwrap();

    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    let to_settle_with_user = update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        unsettled_pnl,
        now,
    )
    .unwrap();
    assert_eq!(to_settle_with_user, -50);

    // user has a lot deposited => settle full pnl
    update_spot_balances(
        500,
        &SpotBalanceType::Deposit,
        &mut spot_market,
        &mut spot_position,
        false,
    )
    .unwrap();

    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    let to_settle_with_user = update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        unsettled_pnl,
        now,
    )
    .unwrap();
    assert_eq!(to_settle_with_user, -100);
}

#[test]
fn update_pool_balances_test() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 5122950819670000,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000,
            base_asset_amount_with_amm: -122950819670000,
            total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
            curve_update_intensity: 100,
            ..AMM::default()
        },
        ..PerpMarket::default()
    };
    let now = 33928058;

    let mut spot_market = SpotMarket {
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        ..SpotMarket::default()
    };
    spot_market.deposit_balance = 10_u128.pow(19_u32);
    spot_market.deposit_token_twap = 10_u64.pow(16_u32);

    let spot_position = SpotPosition::default();

    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    let to_settle_with_user = update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        100,
        now,
    )
    .unwrap();
    assert_eq!(to_settle_with_user, 0);

    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    let to_settle_with_user = update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        -100,
        now,
    )
    .unwrap();
    assert_eq!(to_settle_with_user, -100);
    assert_eq!(market.amm.fee_pool.balance(), 0);

    let amm_fee_pool_token_amount = get_token_amount(
        market.amm.fee_pool.balance(),
        &spot_market,
        market.amm.fee_pool.balance_type(),
    )
    .unwrap();
    let pnl_pool_token_amount = get_token_amount(
        market.pnl_pool.balance(),
        &spot_market,
        market.pnl_pool.balance_type(),
    )
    .unwrap();
    assert_eq!(pnl_pool_token_amount, 100); // Removed fractional top up from user settle
    assert_eq!(amm_fee_pool_token_amount, 0);

    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    let to_settle_with_user = update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        100,
        now,
    )
    .unwrap();
    assert_eq!(to_settle_with_user, 100);
    assert_eq!(pnl_pool_token_amount, 100);
    assert_eq!(amm_fee_pool_token_amount, 0);

    let amm_fee_pool_token_amount = get_token_amount(
        market.amm.fee_pool.balance(),
        &spot_market,
        market.amm.fee_pool.balance_type(),
    )
    .unwrap();
    let pnl_pool_token_amount = get_token_amount(
        market.pnl_pool.balance(),
        &spot_market,
        market.pnl_pool.balance_type(),
    )
    .unwrap();
    assert_eq!(pnl_pool_token_amount, 0);
    assert_eq!(amm_fee_pool_token_amount, 0);

    market.amm.total_fee_minus_distributions = 0;
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        -1,
        now,
    )
    .unwrap();
    let amm_fee_pool_token_amount = get_token_amount(
        market.amm.fee_pool.balance(),
        &spot_market,
        market.amm.fee_pool.balance_type(),
    )
    .unwrap();
    let pnl_pool_token_amount = get_token_amount(
        market.pnl_pool.balance(),
        &spot_market,
        market.pnl_pool.balance_type(),
    )
    .unwrap();
    assert_eq!(pnl_pool_token_amount, 1);
    assert_eq!(amm_fee_pool_token_amount, 0);

    market.amm.total_fee_minus_distributions = 90_000 * QUOTE_PRECISION as i128;
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        -(100_000 * QUOTE_PRECISION as i128),
        now,
    )
    .unwrap();
    let amm_fee_pool_token_amount = get_token_amount(
        market.amm.fee_pool.balance(),
        &spot_market,
        market.amm.fee_pool.balance_type(),
    )
    .unwrap();
    let pnl_pool_token_amount = get_token_amount(
        market.pnl_pool.balance(),
        &spot_market,
        market.pnl_pool.balance_type(),
    )
    .unwrap();
    assert_eq!(pnl_pool_token_amount, 3333333334);
    assert_eq!(amm_fee_pool_token_amount, 0);

    // negative fee pool
    market.amm.total_fee_minus_distributions = -8_008_123_456;

    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        1_000_987_789,
        now,
    )
    .unwrap();
    let amm_fee_pool_token_amount = get_token_amount(
        market.amm.fee_pool.balance(),
        &spot_market,
        market.amm.fee_pool.balance_type(),
    )
    .unwrap();
    let pnl_pool_token_amount = get_token_amount(
        market.pnl_pool.balance(),
        &spot_market,
        market.pnl_pool.balance_type(),
    )
    .unwrap();
    assert_eq!(pnl_pool_token_amount, 2332345545);
    assert_eq!(amm_fee_pool_token_amount, 0);
}

#[test]
fn update_pool_balances_fee_to_revenue_test() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 5122950819670000,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000,
            base_asset_amount_with_amm: -122950819670000,

            total_exchange_fee: 10 * QUOTE_PRECISION,
            total_fee: 10 * QUOTE_PRECISION as i128,
            total_mm_fee: 990 * QUOTE_PRECISION as i128,
            total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
            total_liquidation_fee: QUOTE_PRECISION,
            net_revenue_since_last_funding: 10000 * QUOTE_PRECISION as i64,
            curve_update_intensity: 100,

            fee_pool: PoolBalance {
                scaled_balance: 50 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
                market_index: QUOTE_SPOT_MARKET_INDEX,
                ..PoolBalance::default()
            },
            ..AMM::default()
        },
        pnl_pool: PoolBalance {
            scaled_balance: 50 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        insurance_claim: InsuranceClaim {
            quote_max_insurance: 0, // no liq fees for revenue pool
            max_revenue_withdraw_per_period: 1000 * QUOTE_PRECISION as u64,
            ..InsuranceClaim::default()
        },
        ..PerpMarket::default()
    };
    let now = 33928058;

    let mut spot_market = SpotMarket {
        deposit_balance: 100 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        revenue_pool: PoolBalance::default(),
        ..SpotMarket::default()
    };

    let prev_fee_pool = market.amm.fee_pool.scaled_balance;
    let prev_pnl_pool = market.amm.fee_pool.scaled_balance;
    let prev_rev_pool = spot_market.revenue_pool.scaled_balance;

    assert_eq!(market.amm.total_fee_withdrawn, 0);

    assert_eq!(
        get_token_amount(
            market.amm.fee_pool.balance(),
            &spot_market,
            &SpotBalanceType::Deposit
        )
        .unwrap(),
        50 * QUOTE_PRECISION
    );

    assert_eq!(
        get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit
        )
        .unwrap(),
        100 * QUOTE_PRECISION
    );

    let spot_position = SpotPosition::default();
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        now,
    )
    .unwrap();

    assert_eq!(market.amm.fee_pool.scaled_balance, 50000000000000000); // under FEE_POOL_TO_REVENUE_POOL_THRESHOLD
    assert_eq!(market.pnl_pool.scaled_balance, 50000000000000000);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 0);
    assert_eq!(market.amm.total_fee_withdrawn, 0);

    assert!(market.amm.fee_pool.scaled_balance == prev_fee_pool);
    assert_eq!(market.pnl_pool.scaled_balance, prev_pnl_pool);
    assert!(spot_market.revenue_pool.scaled_balance == prev_rev_pool);

    // add FEE_POOL_TO_REVENUE_POOL_THRESHOLD
    let prev_fee_pool_2 =
        (FEE_POOL_TO_REVENUE_POOL_THRESHOLD + 50 * QUOTE_PRECISION) * SPOT_BALANCE_PRECISION;
    market.amm.fee_pool.scaled_balance = prev_fee_pool_2;
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        now,
    )
    .unwrap();

    assert_eq!(market.pnl_pool.scaled_balance, 50000000000000000);
    assert_eq!(market.amm.total_fee_withdrawn, 5000000);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 5000000000000000);
    assert_eq!(market.amm.fee_pool.scaled_balance, 295000000000000000); // > FEE_POOL_TO_REVENUE_POOL_THRESHOLD

    assert!(market.amm.fee_pool.scaled_balance < prev_fee_pool_2);
    assert_eq!(market.pnl_pool.scaled_balance, prev_pnl_pool);
    assert!(spot_market.revenue_pool.scaled_balance > prev_rev_pool);

    market.insurance_claim.quote_max_insurance = 1; // add min insurance
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        now,
    )
    .unwrap();
    assert_eq!(market.amm.total_fee_withdrawn, 5000001);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 5000001000000000);

    market.insurance_claim.quote_max_insurance = 100000000; // add lots of insurance
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        now,
    )
    .unwrap();
    assert_eq!(market.amm.total_fee_withdrawn, 6000000);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 6000000000000000);
}

#[test]
fn update_pool_balances_fee_to_revenue_low_amm_revenue_test() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 5122950819670000,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000,
            base_asset_amount_with_amm: -122950819670000,

            total_exchange_fee: 10 * QUOTE_PRECISION,
            total_fee: 10 * QUOTE_PRECISION as i128,
            total_mm_fee: 990 * QUOTE_PRECISION as i128,
            total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
            total_liquidation_fee: QUOTE_PRECISION,
            net_revenue_since_last_funding: QUOTE_PRECISION as i64,
            curve_update_intensity: 100,

            fee_pool: PoolBalance {
                scaled_balance: 50 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
                market_index: QUOTE_SPOT_MARKET_INDEX,
                ..PoolBalance::default()
            },
            ..AMM::default()
        },
        pnl_pool: PoolBalance {
            scaled_balance: 50 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        insurance_claim: InsuranceClaim {
            quote_max_insurance: 0, // no liq fees for revenue pool
            max_revenue_withdraw_per_period: 1000 * QUOTE_PRECISION as u64,
            ..InsuranceClaim::default()
        },
        ..PerpMarket::default()
    };
    let now = 33928058;

    let mut spot_market = SpotMarket {
        deposit_balance: 100 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        revenue_pool: PoolBalance::default(),
        ..SpotMarket::default()
    };

    let prev_fee_pool = market.amm.fee_pool.scaled_balance;
    let prev_pnl_pool = market.amm.fee_pool.scaled_balance;
    let prev_rev_pool = spot_market.revenue_pool.scaled_balance;

    assert_eq!(market.amm.total_fee_withdrawn, 0);

    assert_eq!(
        get_token_amount(
            market.amm.fee_pool.balance(),
            &spot_market,
            &SpotBalanceType::Deposit
        )
        .unwrap(),
        50 * QUOTE_PRECISION
    );

    assert_eq!(
        get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit
        )
        .unwrap(),
        100 * QUOTE_PRECISION
    );

    let spot_position = SpotPosition::default();
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        now,
    )
    .unwrap();

    assert_eq!(market.amm.fee_pool.scaled_balance, 50000000000000000); // under FEE_POOL_TO_REVENUE_POOL_THRESHOLD
    assert_eq!(market.pnl_pool.scaled_balance, 50000000000000000);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 0);
    assert_eq!(market.amm.total_fee_withdrawn, 0);

    assert!(market.amm.fee_pool.scaled_balance == prev_fee_pool);
    assert_eq!(market.pnl_pool.scaled_balance, prev_pnl_pool);
    assert!(spot_market.revenue_pool.scaled_balance == prev_rev_pool);

    // add FEE_POOL_TO_REVENUE_POOL_THRESHOLD
    let prev_fee_pool_2 =
        (FEE_POOL_TO_REVENUE_POOL_THRESHOLD + 50 * QUOTE_PRECISION) * SPOT_BALANCE_PRECISION;
    market.amm.fee_pool.scaled_balance = prev_fee_pool_2;
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        now,
    )
    .unwrap();

    assert_eq!(market.pnl_pool.scaled_balance, 50000000000000000);
    assert_eq!(market.amm.total_fee_withdrawn, 1000000);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 1000000000000000);
    assert_eq!(market.amm.fee_pool.scaled_balance, 299000000000000000); // > FEE_POOL_TO_REVENUE_POOL_THRESHOLD

    assert!(market.amm.fee_pool.scaled_balance < prev_fee_pool_2);
    assert_eq!(market.pnl_pool.scaled_balance, prev_pnl_pool);
    assert!(spot_market.revenue_pool.scaled_balance > prev_rev_pool);

    market.insurance_claim.quote_max_insurance = 1; // add min insurance
    market.amm.net_revenue_since_last_funding = 1;

    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        now,
    )
    .unwrap();
    assert_eq!(market.amm.total_fee_withdrawn, 1000001);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 1000001000000000);

    market.insurance_claim.quote_max_insurance = 100000000; // add lots of insurance
    market.amm.net_revenue_since_last_funding = 100000000;

    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        now,
    )
    .unwrap();
    assert_eq!(market.amm.total_fee_withdrawn, 6000000);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 6000000000000000);
}

#[test]
fn update_pool_balances_revenue_to_fee_devnet_state_test() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 916769960813655,
            quote_asset_reserve: 932609131198775,
            sqrt_k: 924655631391254,
            peg_multiplier: 20242531,
            base_asset_amount_with_amm: 7563264495267,

            quote_asset_amount: -90559143969,

            total_exchange_fee: 18223810834,
            total_fee: 130757047337,
            total_mm_fee: 112696236155,
            total_fee_minus_distributions: 338762376993,
            total_fee_withdrawn: 161959731500,
            total_liquidation_fee: 152847899222,
            total_social_loss: 74768391959,
            curve_update_intensity: 100,

            net_revenue_since_last_funding: 229827181,
            fee_pool: PoolBalance {
                scaled_balance: 1821 * SPOT_BALANCE_PRECISION,
                market_index: QUOTE_SPOT_MARKET_INDEX,
                ..PoolBalance::default()
            },

            ..AMM::default()
        },
        pnl_pool: PoolBalance {
            scaled_balance: 381047 * SPOT_BALANCE_PRECISION,
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        insurance_claim: InsuranceClaim {
            quote_max_insurance: 300000 * QUOTE_PRECISION as u64, // no liq fees for revenue pool
            max_revenue_withdraw_per_period: 1000 * QUOTE_PRECISION as u64,
            ..InsuranceClaim::default()
        },
        ..PerpMarket::default()
    };
    let now = 33928058;

    let mut spot_market = SpotMarket {
        deposit_balance: 200 * SPOT_BALANCE_PRECISION,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        revenue_pool: PoolBalance {
            market_index: 0,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION,
            ..PoolBalance::default()
        },
        decimals: 6,
        ..SpotMarket::default()
    };
    let spot_position = SpotPosition::default();

    let prev_fee_pool = market.amm.fee_pool.scaled_balance;
    let prev_pnl_pool = market.amm.fee_pool.scaled_balance;
    let prev_rev_pool = spot_market.revenue_pool.scaled_balance;
    let prev_tfmd = market.amm.total_fee_minus_distributions;

    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        now,
    )
    .unwrap();

    assert_eq!(market.amm.fee_pool.scaled_balance, 1821000000000);
    assert_eq!(market.pnl_pool.scaled_balance, 381047000000000);
    assert_eq!(
        spot_market.revenue_pool.scaled_balance,
        100 * SPOT_BALANCE_PRECISION
    );
    assert_eq!(market.amm.total_fee_withdrawn, 161959731500);
    assert_eq!(market.amm.total_fee_minus_distributions, prev_tfmd);

    assert_eq!(market.amm.fee_pool.scaled_balance, prev_fee_pool);
    assert_eq!(market.pnl_pool.scaled_balance > prev_pnl_pool, true);
    assert_eq!(
        spot_market.revenue_pool.scaled_balance == prev_rev_pool,
        true
    );
    assert_eq!(market.insurance_claim.revenue_withdraw_since_last_settle, 0);
    assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 0);

    market.insurance_claim.max_revenue_withdraw_per_period = 100000000 * 2;
    assert_eq!(spot_market.deposit_balance, 200 * SPOT_BALANCE_PRECISION);
    assert_eq!(
        spot_market.revenue_pool.scaled_balance,
        100 * SPOT_BALANCE_PRECISION
    );
}

#[test]
fn update_pool_balances_revenue_to_fee_new_market() {
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 6165301473685,
            quote_asset_reserve: 6165301473685,
            sqrt_k: 6165301473685,
            peg_multiplier: 324000000,
            base_asset_amount_with_amm: 0,

            quote_asset_amount: 0,

            total_exchange_fee: 26000,
            total_fee: 26000,
            total_mm_fee: 0,
            total_fee_minus_distributions: 26000,
            total_fee_withdrawn: 0,
            total_liquidation_fee: 0,
            total_social_loss: 0,
            curve_update_intensity: 100,

            net_revenue_since_last_funding: 0,
            fee_pool: PoolBalance {
                scaled_balance: 0,
                market_index: QUOTE_SPOT_MARKET_INDEX,
                ..PoolBalance::default()
            },

            ..AMM::default()
        },
        pnl_pool: PoolBalance {
            scaled_balance: 0,
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        insurance_claim: InsuranceClaim {
            quote_max_insurance: 5000 * QUOTE_PRECISION as u64, // no liq fees for revenue pool
            max_revenue_withdraw_per_period: 50 * QUOTE_PRECISION as u64,
            ..InsuranceClaim::default()
        },
        ..PerpMarket::default()
    };
    let now = 33928058;

    let mut spot_market = SpotMarket {
        deposit_balance: 200 * SPOT_BALANCE_PRECISION,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        revenue_pool: PoolBalance {
            market_index: 0,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION,
            ..PoolBalance::default()
        },
        decimals: 6,
        ..SpotMarket::default()
    };
    let spot_position = SpotPosition::default();

    // let prev_fee_pool = market.amm.fee_pool.scaled_balance;
    let prev_pnl_pool = market.amm.fee_pool.scaled_balance;
    let prev_rev_pool = spot_market.revenue_pool.scaled_balance;
    // let prev_tfmd = market.amm.total_fee_minus_distributions;

    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        now,
    )
    .unwrap();

    assert_eq!(market.amm.fee_pool.scaled_balance, 0); // no longer topped up from revenue pool
    assert_eq!(market.pnl_pool.scaled_balance, 0);
    assert_eq!(
        spot_market.revenue_pool.scaled_balance,
        100 * SPOT_BALANCE_PRECISION
    ); // unchanged
    assert_eq!(market.amm.total_fee_withdrawn, 0);
    assert_eq!(market.amm.total_fee_minus_distributions, 26000); // unchanged
    assert_eq!(market.pnl_pool.scaled_balance, prev_pnl_pool);
    assert_eq!(
        spot_market.revenue_pool.scaled_balance < prev_rev_pool,
        false
    ); // no longer less
    assert_eq!(market.insurance_claim.revenue_withdraw_since_last_settle, 0);
    assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 0);

    market.insurance_claim.max_revenue_withdraw_per_period = 100000000 * 2;
    assert_eq!(spot_market.deposit_balance, 200 * SPOT_BALANCE_PRECISION);
    assert_eq!(
        spot_market.revenue_pool.scaled_balance,
        100 * SPOT_BALANCE_PRECISION
    );
}

#[cfg(test)]
mod revenue_pool_transfer_tests {
    use crate::controller::amm::*;
    use crate::math::constants::{
        QUOTE_PRECISION, QUOTE_PRECISION_I128, QUOTE_PRECISION_I64, QUOTE_PRECISION_U64,
        SPOT_BALANCE_PRECISION, SPOT_CUMULATIVE_INTEREST_PRECISION,
    };
    use crate::state::perp_market::{InsuranceClaim, PoolBalance};
    use crate::state::spot_market::InsuranceFund;
    use crate::state::user::SpotPosition;

    #[test]
    fn test_calculate_revenue_pool_transfer() {
        // Set up input parameters
        let mut market = PerpMarket {
            amm: AMM {
                total_social_loss: 0,
                total_liquidation_fee: 0,
                net_revenue_since_last_funding: 0,
                total_fee_withdrawn: 0,
                ..AMM::default()
            },
            insurance_claim: InsuranceClaim {
                max_revenue_withdraw_per_period: 0,
                revenue_withdraw_since_last_settle: 0,
                quote_settled_insurance: 0,
                quote_max_insurance: 0,
                ..InsuranceClaim::default()
            },
            ..PerpMarket::default()
        };
        let mut spot_market = SpotMarket {
            deposit_balance: 20020 * SPOT_BALANCE_PRECISION,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            revenue_pool: PoolBalance {
                market_index: 0,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION,
                ..PoolBalance::default()
            },
            decimals: 6,
            ..SpotMarket::default()
        };
        let amm_fee_pool_token_amount_after = 0;
        let terminal_state_surplus = 0;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        assert_eq!(result.unwrap(), 0);

        let amm_fee_pool_token_amount_after = 0;
        let terminal_state_surplus = 1;
        let result: std::result::Result<i128, crate::error::ErrorCode> =
            calculate_revenue_pool_transfer(
                &market,
                &spot_market,
                amm_fee_pool_token_amount_after,
                terminal_state_surplus,
            );
        assert_eq!(result.unwrap(), 0);

        market.insurance_claim.max_revenue_withdraw_per_period = QUOTE_PRECISION_U64;
        let result: std::result::Result<i128, crate::error::ErrorCode> =
            calculate_revenue_pool_transfer(
                &market,
                &spot_market,
                amm_fee_pool_token_amount_after,
                terminal_state_surplus,
            );
        assert_eq!(result.unwrap(), -1000000); // take whole pool

        market.insurance_claim.max_revenue_withdraw_per_period = 100 * QUOTE_PRECISION_U64;
        let result: std::result::Result<i128, crate::error::ErrorCode> =
            calculate_revenue_pool_transfer(
                &market,
                &spot_market,
                amm_fee_pool_token_amount_after,
                terminal_state_surplus,
            );
        assert_eq!(result.unwrap(), -100000000); // take whole pool

        market.insurance_claim.max_revenue_withdraw_per_period = 1000 * QUOTE_PRECISION_U64;
        let result: std::result::Result<i128, crate::error::ErrorCode> =
            calculate_revenue_pool_transfer(
                &market,
                &spot_market,
                amm_fee_pool_token_amount_after,
                terminal_state_surplus,
            );
        assert_eq!(result.unwrap(), -100000000); // take whole pool

        let terminal_state_surplus = 1000 * QUOTE_PRECISION_I128;
        let result: std::result::Result<i128, crate::error::ErrorCode> =
            calculate_revenue_pool_transfer(
                &market,
                &spot_market,
                amm_fee_pool_token_amount_after,
                terminal_state_surplus,
            );
        assert_eq!(result.unwrap(), 0); // take none

        // Test case 2: When amm_budget_surplus is greater than zero and max_revenue_to_settle is greater than zero, revenue_pool_transfer should be greater than zero
        market.amm.net_revenue_since_last_funding = 1000 * QUOTE_PRECISION_I64;
        market.amm.total_fee_withdrawn = 500 * QUOTE_PRECISION;
        market.amm.total_liquidation_fee = 300 * QUOTE_PRECISION;
        market.insurance_claim.quote_max_insurance = 100 * QUOTE_PRECISION_U64;
        market.insurance_claim.quote_settled_insurance = 50 * QUOTE_PRECISION_U64;
        market.insurance_claim.revenue_withdraw_since_last_settle = 200 * QUOTE_PRECISION_I64;
        market.insurance_claim.max_revenue_withdraw_per_period = 500 * QUOTE_PRECISION_U64;
        let amm_fee_pool_token_amount_after = 300 * QUOTE_PRECISION;
        let terminal_state_surplus = 1000 * QUOTE_PRECISION_I128;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        assert_eq!(result.unwrap(), 0); //todo?

        let amm_fee_pool_token_amount_after = 300 * QUOTE_PRECISION;
        let terminal_state_surplus = -500 * QUOTE_PRECISION_I128;
        market.insurance_claim.max_revenue_withdraw_per_period = 20 * QUOTE_PRECISION_U64;
        market.insurance_claim.revenue_withdraw_since_last_settle = 0;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        assert_eq!(result.unwrap(), -20000000);

        // Test case 3: When amm_budget_surplus is less than zero and max_revenue_withdraw_allowed is equal to zero, revenue_pool_transfer should be zero.
        let amm_fee_pool_token_amount_after = 300 * QUOTE_PRECISION;
        let terminal_state_surplus = -500 * QUOTE_PRECISION_I128;
        market.insurance_claim.max_revenue_withdraw_per_period = 0;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        assert_eq!(result.unwrap(), 0);

        // Test case 4: When amm_budget_surplus is greater than zero and fee_pool_threshold is greater than max_revenue_to_settle, revenue_pool_transfer should be equal to max_revenue_to_settle.
        let amm_fee_pool_token_amount_after = 500 * QUOTE_PRECISION;
        let terminal_state_surplus = 1000 * QUOTE_PRECISION_I128;
        market.insurance_claim.max_revenue_withdraw_per_period = 20 * QUOTE_PRECISION_U64;
        market.amm.total_social_loss = 100 * QUOTE_PRECISION;
        market.amm.total_exchange_fee = 3000 * QUOTE_PRECISION;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        assert_eq!(result.unwrap(), 20000000);

        //Test case 5: When amm_budget_surplus is greater than zero and fee_pool_threshold is less than max_revenue_to_settle, revenue_pool_transfer should be equal to fee_pool_threshold.
        let amm_fee_pool_token_amount_after = 500 * QUOTE_PRECISION;
        let terminal_state_surplus = 1000 * QUOTE_PRECISION_I128;
        market.insurance_claim.max_revenue_withdraw_per_period = 1000 * QUOTE_PRECISION_U64;
        market.amm.total_social_loss = 100 * QUOTE_PRECISION;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        assert_eq!(result.unwrap(), 150000000);

        //Test case 6: When total_liq_fees_for_revenue_pool is greater than total_fee_for_if, revenue_pool_transfer should be greater than zero.
        let amm_fee_pool_token_amount_after = 500 * QUOTE_PRECISION;
        let terminal_state_surplus = 1000 * QUOTE_PRECISION_I128;
        market.insurance_claim.max_revenue_withdraw_per_period = 1000 * QUOTE_PRECISION_U64;
        market.amm.total_social_loss = 100 * QUOTE_PRECISION;
        market.amm.total_liquidation_fee = 800 * QUOTE_PRECISION;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        assert!(result.unwrap() > 0);

        //Test case 7: When total_liq_fees_for_revenue_pool is less than total_fee_for_if, revenue_pool_transfer should be less than or equal to zero.
        let amm_fee_pool_token_amount_after = 500 * QUOTE_PRECISION;
        let terminal_state_surplus = 1000 * QUOTE_PRECISION_I128;
        market.insurance_claim.max_revenue_withdraw_per_period = 1000 * QUOTE_PRECISION_U64;
        market.amm.total_social_loss = 100 * QUOTE_PRECISION;
        market.amm.total_liquidation_fee = 200 * QUOTE_PRECISION;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        let expected_result: i128 = (amm_fee_pool_token_amount_after
            - market.amm.total_social_loss
            - FEE_POOL_TO_REVENUE_POOL_THRESHOLD) as i128;
        assert_eq!(result.unwrap(), expected_result);

        //Test case 8: When total_social_loss is greater than fee_pool_threshold, revenue_pool_transfer should be zero.
        let amm_fee_pool_token_amount_after = 500 * QUOTE_PRECISION;
        let terminal_state_surplus = 1000 * QUOTE_PRECISION_I128;
        market.insurance_claim.max_revenue_withdraw_per_period = 1000 * QUOTE_PRECISION_U64;
        market.amm.total_social_loss = 600 * QUOTE_PRECISION;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        assert_eq!(result.unwrap(), 0);

        //Test case 9: When total_social_loss is less than fee_pool_threshold and max_revenue_to_settle is less than fee_pool_threshold, revenue_pool_transfer should be equal to max_revenue_to_settle.
        let amm_fee_pool_token_amount_after: u128 = 500 * QUOTE_PRECISION;
        let terminal_state_surplus = 1000 * QUOTE_PRECISION_I128;
        market.insurance_claim.max_revenue_withdraw_per_period = 40 * QUOTE_PRECISION_U64;
        market.amm.total_social_loss = 100 * QUOTE_PRECISION;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        assert_eq!(result.unwrap(), 40000000);

        //Test case 10: When total_social_loss is less than fee_pool_threshold and max_revenue_to_settle is greater than fee_pool_threshold, revenue_pool_transfer should be equal to fee_pool_threshold.
        let amm_fee_pool_token_amount_after = 500 * QUOTE_PRECISION;
        let terminal_state_surplus = 1000 * QUOTE_PRECISION_I128;
        market.insurance_claim.max_revenue_withdraw_per_period = 1000 * QUOTE_PRECISION_U64;
        market.amm.total_social_loss = 100 * QUOTE_PRECISION;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        assert_eq!(result.unwrap(), 150000000);

        spot_market.revenue_pool.scaled_balance = 15000 * SPOT_BALANCE_PRECISION;

        //Test case 11: claim max_revenue_withdraw_per_period
        let amm_fee_pool_token_amount_after = 500 * QUOTE_PRECISION;
        let terminal_state_surplus = -1000 * QUOTE_PRECISION_I128;
        market.insurance_claim.max_revenue_withdraw_per_period = 1000 * QUOTE_PRECISION_U64;
        market.amm.total_social_loss = 100 * QUOTE_PRECISION;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        assert_eq!(result.unwrap(), -1000000000);

        //Test case 12: claim back up to FEE_POOL_TO_REVENUE_POOL_THRESHOLD
        let amm_fee_pool_token_amount_after = 500 * QUOTE_PRECISION;
        let terminal_state_surplus = -1000 * QUOTE_PRECISION_I128;
        market.insurance_claim.max_revenue_withdraw_per_period = 2000 * QUOTE_PRECISION_U64;
        market.amm.total_social_loss = 100 * QUOTE_PRECISION;
        let result = calculate_revenue_pool_transfer(
            &market,
            &spot_market,
            amm_fee_pool_token_amount_after,
            terminal_state_surplus,
        );
        assert_eq!(result.unwrap(), -1250000000);
    }

    #[test]
    fn test_update_postive_last_revenue_withdraw_ts() {
        // Set up input parameters
        let mut market = PerpMarket {
            amm: AMM {
                total_social_loss: 0,
                total_liquidation_fee: 0,
                total_fee_withdrawn: 0,
                net_revenue_since_last_funding: 169 * QUOTE_PRECISION_I64,
                total_fee_minus_distributions: 1420420420420,
                total_exchange_fee: 420420420420,
                fee_pool: PoolBalance {
                    scaled_balance: 81000 * SPOT_BALANCE_PRECISION,
                    ..PoolBalance::default()
                },
                ..AMM::default()
            },
            pnl_pool: PoolBalance {
                scaled_balance: 10000 * SPOT_BALANCE_PRECISION,
                ..PoolBalance::default()
            },
            insurance_claim: InsuranceClaim {
                max_revenue_withdraw_per_period: 65000000,
                revenue_withdraw_since_last_settle: 0,
                quote_settled_insurance: 0,
                quote_max_insurance: 1000,
                ..InsuranceClaim::default()
            },
            ..PerpMarket::default()
        };
        let mut spot_market = SpotMarket {
            deposit_balance: 20020 * SPOT_BALANCE_PRECISION,
            deposit_token_twap: 20020 * QUOTE_PRECISION_U64,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            revenue_pool: PoolBalance {
                market_index: 0,
                scaled_balance: 10000 * SPOT_BALANCE_PRECISION,
                ..PoolBalance::default()
            },
            insurance_fund: InsuranceFund {
                revenue_settle_period: 3600,
                ..InsuranceFund::default()
            },
            decimals: 6,
            ..SpotMarket::default()
        };

        // would lead to a borrow
        let spot_position = SpotPosition::default();
        let unsettled_pnl = -100;
        let now = 100;
        let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
        let to_settle_with_user = update_pool_balances(
            &mut market,
            &mut spot_market,
            user_quote_token_amount,
            unsettled_pnl,
            now,
        )
        .unwrap();

        assert_eq!(to_settle_with_user, -100);
        assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 100);
        assert_eq!(spot_market.revenue_pool.scaled_balance, 10065000000000);

        // revenue pool not yet settled
        let now = 10000;
        let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
        let to_settle_with_user = update_pool_balances(
            &mut market,
            &mut spot_market,
            user_quote_token_amount,
            unsettled_pnl,
            now,
        )
        .unwrap();

        assert_eq!(to_settle_with_user, -100);
        assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 100);
        assert_eq!(spot_market.revenue_pool.scaled_balance, 10065000000000);

        // revenue pool settled but negative revenue for hour
        spot_market.insurance_fund.last_revenue_settle_ts = 3600 + 100;
        market.amm.net_revenue_since_last_funding = -169;

        let now = 10000;
        let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
        let to_settle_with_user = update_pool_balances(
            &mut market,
            &mut spot_market,
            user_quote_token_amount,
            unsettled_pnl,
            now,
        )
        .unwrap();

        assert_eq!(to_settle_with_user, -100);
        assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 100);
        assert_eq!(spot_market.revenue_pool.scaled_balance, 10065000000000);

        // revenue pool settled and positive revenue for hour
        spot_market.insurance_fund.last_revenue_settle_ts = 3600 + 100;
        market.amm.net_revenue_since_last_funding = 169;

        let now = 10000;
        let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
        let to_settle_with_user = update_pool_balances(
            &mut market,
            &mut spot_market,
            user_quote_token_amount,
            unsettled_pnl,
            now,
        )
        .unwrap();

        assert_eq!(to_settle_with_user, -100);
        assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 10000);
        assert_eq!(spot_market.revenue_pool.scaled_balance, 10065000169000);
    }

    #[test]
    fn test_update_negative_last_revenue_withdraw_ts() {
        // Set up input parameters
        let mut market = PerpMarket {
            amm: AMM {
                total_social_loss: 0,
                total_liquidation_fee: 0,
                total_fee_withdrawn: 0,
                net_revenue_since_last_funding: 169 * QUOTE_PRECISION_I64,
                total_fee_minus_distributions: -6969696969,
                total_exchange_fee: 420420420420,
                fee_pool: PoolBalance {
                    scaled_balance: 81000 * SPOT_BALANCE_PRECISION,
                    ..PoolBalance::default()
                },
                ..AMM::default()
            },
            pnl_pool: PoolBalance {
                scaled_balance: 10000 * SPOT_BALANCE_PRECISION,
                ..PoolBalance::default()
            },
            insurance_claim: InsuranceClaim {
                max_revenue_withdraw_per_period: 65000000,
                revenue_withdraw_since_last_settle: 0,
                quote_settled_insurance: 0,
                quote_max_insurance: 1000,
                ..InsuranceClaim::default()
            },
            ..PerpMarket::default()
        };
        let mut spot_market = SpotMarket {
            deposit_balance: 20020000 * SPOT_BALANCE_PRECISION,
            deposit_token_twap: 20020000 * QUOTE_PRECISION_U64,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            revenue_pool: PoolBalance {
                market_index: 0,
                scaled_balance: 10000 * SPOT_BALANCE_PRECISION,
                ..PoolBalance::default()
            },
            insurance_fund: InsuranceFund {
                revenue_settle_period: 3600,
                ..InsuranceFund::default()
            },
            decimals: 6,
            ..SpotMarket::default()
        };

        // would lead to a borrow
        let spot_position = SpotPosition::default();
        let unsettled_pnl = -100;
        let now = 100;
        let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
        let to_settle_with_user = update_pool_balances(
            &mut market,
            &mut spot_market,
            user_quote_token_amount,
            unsettled_pnl,
            now,
        )
        .unwrap();

        assert_eq!(to_settle_with_user, -100);
        assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 0); // No longer updated
        assert_eq!(spot_market.revenue_pool.scaled_balance, 10000000000000);

        // revenue pool not yet settled
        let now = 10000;
        let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
        let to_settle_with_user = update_pool_balances(
            &mut market,
            &mut spot_market,
            user_quote_token_amount,
            unsettled_pnl,
            now,
        )
        .unwrap();

        assert_eq!(to_settle_with_user, -100);
        assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 0); // No longer updated
        assert_eq!(spot_market.revenue_pool.scaled_balance, 10000000000000);

        // revenue pool settled and negative/positive revenue for hour irrelevant for withdraw
        spot_market.insurance_fund.last_revenue_settle_ts = 3600 + 100;
        market.amm.net_revenue_since_last_funding = -169;

        let now = 10000;
        let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
        let to_settle_with_user = update_pool_balances(
            &mut market,
            &mut spot_market,
            user_quote_token_amount,
            unsettled_pnl,
            now,
        )
        .unwrap();

        assert_eq!(to_settle_with_user, -100);
        assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 0); // No longer updated
        assert_eq!(spot_market.revenue_pool.scaled_balance, 10000000000000);
    }
}

#[test]
pub fn perp_market_transfer_fee_and_pnl_pool() {
    let key = Pubkey::default();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;

    // SOL (as of slot 409451609)
    let sol_perp_market_str = String::from("Ct8MLGv1N/dvAH3EF67yBqaUQerctpm4yqpK+QNSrXCQz76p+B+kaykDYiceTDtpx7UpBfc/oj+uGEGwhrIUjzR4ifH+lS/hJIP3BAAAAAAAAAAAAAAAAAAAAAAAAAAAFuz0BAAAAACWcfYEAAAAANrux2kAAAAAp70SNM7//////////////2sMl0Xy//////////////8trAi6p0siAAAAAAAAAAAAAAAAAAAAAACIu8ipHGCTAAAAAAAAAAAAVrJHsB9fkwAAAAAAAAAAAG5SDwAAAAAAAAAAAAAAAAC8RNAUBsSSAAAAAAAAAAAAaQXlPOr7kwAAAAAAAAAAABvv0SyeX5MAAAAAAAAAAACqi/cEAAAAAAAAAAAAAAAASYvFspZfkwAAAAAAAAAAAAA9XbpHcQEAAAAAAAAAAACAu7hCQY7+////////////gPgV/Yj//////////////wAAAAAAAAAAAAAAAAAAAAAAAI1J/RoHAAAAAAAAAAAA+T41l9cCAAAAAAAAAAAAAGat7M1w1/////////////+SMT48ViwAAAAAAAAAAAAAfYgvvOLX/////////////0+x5G+hKwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHHv0//////8ce/T//////xx79P//////sVT8//////+LhuNqHRoAAAAAAAAAAAAAV7ZkZSsKAAAAAAAAAAAAALPxdxgWEAAAAAAAAAAAAAAmzXDeFw0AAAAAAAAAAAAAtsCc654HAAAAAAAAAAAAABdPYMUUBQAAAAAAAAAAAAAPd7FXCgAAAAAAAAAAAAAAlBtnSwoAAAAAAAAAAAAAAMG4+QwBAAAAAAAAAAAAAACjWX5b7GOTAAAAAAAAAAAASJ5XHlBbkwAAAAAAAAAAAMnRdxl0bJMAAAAAAAAAAABf/UNeyVKTAAAAAAAAAAAAJIP3BAAAAAAAAAAAAAAAAFJ58wQAAAAAjlT1BAAAAADwZvQEAAAAAAYF9gQAAAAA/L9nGAAAAACBAAAAAAAAAJJcigcAAAAA8ezHaQAAAAAQDgAAAAAAAICWmAAAAAAAZAAAAAAAAACAlpgAAAAAACLAZxgAAAAA04ppTjoWAAAmbBjfewAAALWEqk9HAAAAsu7HaQAAAACdxAIAAAAAAD6XAgAAAAAA2u7HaQAAAADIAAAAIE4AAMYAAAD+AAAAUVP3BAAAAACoYTIAaGQMAcDIUt4DFGL/ULdE/RZOBgCbVq///////9zgRcTl////cP7//+wAAADEu/QEAAAAAPviFO8ZTxYAAAAAAAAAAAAAAAAAAAAAAFNPTC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAB8K+v////8A4fUFAAAAAAAQpdToAAAAsnK2MSwAAAAC7cdpAAAAAEBCDwAAAAAAAAAAAAAAAAAAAAAAAAAAAE3I+AAAAAAA8XMAAAAAAADREwAAAAAAADIAAAAAAAAATB0AAEwdAAD0AQAALAEAAAAAAAAQJwAAbg0AAKgJAAAAAAEAAQAAAAAAAAAAAGMAQgAAAAQBAAIRXvcEAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");

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

    // ETH (as of slot 409497574)
    let eth_perp_market_str = String::from("Ct8MLGv1N/cP8V8Fb1epGNxhYovgt6QslGhUT6HV1zTpfCkrkbwLkndwx9kOHTTRdsq6+h4yZlyZWL2p6k8cVCwzZ4FGbCUqXGV1eAAAAAAAAAAAAAAAAAEAAAAAAAAA/SRjeAAAAAChnVt4AAAAAKgzyGkAAAAAK2l1AgAAAAAAAAAAAAAAAA9wrAoAAAAAAAAAAAAAAACh+4TbqUEDAAAAAAAAAAAAAAAAAAAAAACKuobbYRQAAAAAAAAAAAAATN2ls14UAAAAAAAAAAAAAFdKDwAAAAAAAAAAAAAAAADyCbJ/VRQAAAAAAAAAAAAASXgSFWsUAAAAAAAAAAAAAAqohkdgFAAAAAAAAAAAAADYdt14AAAAAAAAAAAAAAAACqiGR2AUAAAAAAAAAAAAAIAAnOeOAwAAAAAAAAAAAAAA7WOEb/z/////////////gO3/a/7//////////////wAAAAAAAAAAAAAAAAAAAAAAID2IeS0AAAAAAAAAAAAAHEI12XIBAAAAAAAAAAAAADCpXUuQ9/////////////8h8QjUrgkAAAAAAAAAAAAAVKXVKYz3/////////////0AW/aXJCQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJG05AQAAAAAkbTkBAAAAAF3iOAEAAAAAINF0AAAAAAA5TWeWBQUAAAAAAAAAAAAANMVeC/kCAAAAAAAAAAAAAOUtJc4RAgAAAAAAAAAAAAA5SOd/xQAAAAAAAAAAAAAA89kg4EsBAAAAAAAAAAAAAMCrPYJDAQAAAAAAAAAAAAA5jF9oEgEAAAAAAAAAAAAATeVjBxIBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABhrBaiYRQAAAAAAAAAAAAAm6gN7V4UAAAAAAAAAAAAAGouldVrFAAAAAAAAAAAAABA4gHAVBQAAAAAAAAAAAAAUPB2eAAAAADICgAAAAAAANd8SHgAAAAAPpyAeAAAAACKjGR4AAAAAEGbXXgAAAAA4G9oGAAAAAA+AAAAAAAAAPfDAQAAAAAATTPIaQAAAAAQDgAAAAAAAEBCDwAAAAAAECcAAAAAAABAQg8AAAAAAOZvaBgAAAAAutxz8+ACAAAX36EsBwAAAEKKf3wDAAAAqDPIaQAAAAA7/R0AAAAAAK9SGwAAAAAAqDPIaQAAAACvAAAAECcAAJMAAACrDgAAV2V1eAAAAAAgTjIAZQAMAcCmjPgAFAD/AA5nFhtOBgD0SDn3AQAAAHq8ojMAAAAAxP///84FAAAI12J4AAAAALyI4xr88QMAAAAAAAAAAAAAAAAAAAAAAEVUSC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAA4fUFAAAAAP8PpdToAAAAFhrxGBIAAACkdwppAAAAAADh9QUAAAAAAAAAAAAAAAAAAAAAAAAAACvAXAAAAAAAlnAAAAAAAABuEAAAAAAAAPoAAAAAAAAAiBMAAEwdAAD0AQAAyAAAAAAAAAAQJwAA2gIAAPwCAAACAAEAAYAAAAAAAAAAAGMAQgAAAAAAAACAgXt4AAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");

    let mut eth_perp_decoded = base64::decode(eth_perp_market_str).unwrap();
    let sol_perp_account_info = create_account_info(
        &key,
        true,
        &mut lamports,
        eth_perp_decoded.as_mut_slice(),
        &owner,
    );

    let eth_perp_market = *AccountLoader::<PerpMarket>::try_from(&sol_perp_account_info)
        .unwrap()
        .load_mut()
        .unwrap();

    // USDC (as of slot 409451751)
    let usdc_spot_market_str = String::from("ZLEIa6hBQSdUX6MOo7w/PClm2otsPf7406t9pXygIypU5KAmT//Dwn4XAskDe6KnOB2fuc5t8V0PxU10u3MRn4rxLxkMDhW+xvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWHmsHZFgFFAI49uEcLfeyYJqqXqJL+++g9w+I4yK2cfD1VTREMgICAgICAgICAgICAgICAgICAgICAgICAgICAgukEPAAAAAAAtAAAAAAAAAB0AAAAAAAAA50EPAAAAAAC8QQ8AAAAAAGrtx2kAAAAAQEIPAAAAAABAQg8AAAAAAEBCDwAAAAAAQEIPAAAAAAAAAAAAAAAAAKyHT4jBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHkMifZGT+FrLhfKfHFav7xo95PrVMA7wMfE+znV7oDulKyko0DAAAAAAAAAAAAAL1XqBIzAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgCMRAAAAAABt4cdpAAAAABAOAAAAAAAAoIYBAFzBAAAAAAAAAAAAAAAAAAAAAAAAfkv1jv7JXgEAAAAAAAAAAJfdQb4XCK8AAAAAAAAAAAAX/nXMAgAAAAAAAAAAAAAApqF/QQMAAAAAAAAAAAAAAG8haMUAAAAAAAAAAAAAAAAOgmjFAAAAAAAAAAAAAAAAAJAexLwWAAAAQGNSv8YBAAP7bLiXbQAAiOggJmc+AACI3AgAAAAAAIvtx2kAAAAAi+3HaQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAU0MIAAAAAABAnAAAQJwAAECcAABAnAAAAAAAAAAAAAIgTAAAANQwAFM0AAKC7DQAGAAAAAAAADwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKMFwEAAAAAAADpQcxrAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

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

    // Case 1: No revert, transfer 100% pnl -> fee pool
    {
        let mut case_market = sol_perp_market.clone();
        let mut case_spot_market = usdc_spot_market.clone();

        let fee_pool_amount_before_transfer = get_token_amount(
            case_market.amm.fee_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let pnl_pool_amount_before_transfer = get_token_amount(
            case_market.pnl_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        // transfer entire pnl pool into fee pool to overfill it
        let transfer_amount = pnl_pool_amount_before_transfer as u64;

        let fee_pool = &mut case_market.amm.fee_pool as *mut PoolBalance;
        let pnl_pool = &mut case_market.pnl_pool as *mut PoolBalance;

        execute_transfer_between_pools(
            transfer_amount,
            &mut case_spot_market,
            unsafe { &mut *fee_pool },
            unsafe { &mut *pnl_pool },
            case_market.market_index,
            case_market.market_index,
            TransferFeeAndPnlPoolDirection::PnlToFeePool,
        )
        .unwrap();

        let fee_pool_amount_after_transfer = get_token_amount(
            case_market.amm.fee_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let pnl_pool_amount_after_transfer = get_token_amount(
            case_market.pnl_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(
            fee_pool_amount_before_transfer.saturating_add(transfer_amount as u128),
            fee_pool_amount_after_transfer
        );

        assert_eq!(
            pnl_pool_amount_before_transfer.saturating_sub(transfer_amount as u128),
            pnl_pool_amount_after_transfer
        );

        case_market.amm.total_fee_minus_distributions = case_market
            .amm
            .total_fee_minus_distributions
            .safe_add(transfer_amount.cast().unwrap())
            .unwrap();

        update_pool_balances(&mut case_market, &mut case_spot_market, 0, 0, 0).unwrap();

        let fee_pool_amount_after_update = get_token_amount(
            case_market.amm.fee_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let pnl_pool_amount_after_update = get_token_amount(
            case_market.pnl_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(fee_pool_amount_after_update, fee_pool_amount_after_transfer);
        assert_eq!(pnl_pool_amount_after_update, pnl_pool_amount_after_transfer);
    }

    // Case 2: Expect no top up, fee -> pnl, transfer 100% of fee pool for SOL
    {
        let mut case_market = sol_perp_market.clone();
        let mut case_spot_market = usdc_spot_market.clone();

        let fee_pool_amount_before_transfer = get_token_amount(
            case_market.amm.fee_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let pnl_pool_amount_before_transfer = get_token_amount(
            case_market.pnl_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let transfer_amount = fee_pool_amount_before_transfer as u64;

        let fee_pool = &mut case_market.amm.fee_pool as *mut PoolBalance;
        let pnl_pool = &mut case_market.pnl_pool as *mut PoolBalance;

        execute_transfer_between_pools(
            transfer_amount,
            &mut case_spot_market,
            unsafe { &mut *fee_pool },
            unsafe { &mut *pnl_pool },
            case_market.market_index,
            case_market.market_index,
            TransferFeeAndPnlPoolDirection::FeeToPnlPool,
        )
        .unwrap();

        let fee_pool_amount_after_transfer = get_token_amount(
            case_market.amm.fee_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let pnl_pool_amount_after_transfer = get_token_amount(
            case_market.pnl_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(
            fee_pool_amount_before_transfer.saturating_sub(transfer_amount as u128),
            fee_pool_amount_after_transfer
        );

        assert_eq!(
            pnl_pool_amount_before_transfer.saturating_add(transfer_amount as u128),
            pnl_pool_amount_after_transfer
        );

        case_market.amm.total_fee_minus_distributions = case_market
            .amm
            .total_fee_minus_distributions
            .safe_sub(transfer_amount.cast().unwrap())
            .unwrap();

        let now = 0_i64;

        update_pool_balances(&mut case_market, &mut case_spot_market, 0, 0, now).unwrap();

        let fee_pool_amount_after_update = get_token_amount(
            case_market.amm.fee_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let pnl_pool_amount_after_update = get_token_amount(
            case_market.pnl_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(fee_pool_amount_after_update, fee_pool_amount_after_transfer);
        assert_eq!(pnl_pool_amount_after_update, pnl_pool_amount_after_transfer);
    }

    // Case 3: SOL fee -> ETH pnl pool
    {
        let mut case_sol_market = sol_perp_market.clone();
        let mut case_eth_market = eth_perp_market.clone();
        let mut case_spot_market = usdc_spot_market.clone();

        let sol_fee_pool_amount_before_transfer = get_token_amount(
            case_sol_market.amm.fee_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let eth_pnl_pool_amount_before_transfer = get_token_amount(
            case_eth_market.pnl_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let transfer_amount = (sol_fee_pool_amount_before_transfer / 2) as u64;

        let fee_pool = &mut case_sol_market.amm.fee_pool as *mut PoolBalance;
        let pnl_pool = &mut case_eth_market.pnl_pool as *mut PoolBalance;

        execute_transfer_between_pools(
            transfer_amount,
            &mut case_spot_market,
            unsafe { &mut *fee_pool },
            unsafe { &mut *pnl_pool },
            case_sol_market.market_index,
            case_eth_market.market_index,
            TransferFeeAndPnlPoolDirection::FeeToPnlPool,
        )
        .unwrap();

        let sol_fee_pool_amount_after_transfer = get_token_amount(
            case_sol_market.amm.fee_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let eth_pnl_pool_amount_after_transfer = get_token_amount(
            case_eth_market.pnl_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(
            sol_fee_pool_amount_before_transfer.saturating_sub(transfer_amount as u128),
            sol_fee_pool_amount_after_transfer
        );

        assert_eq!(
            eth_pnl_pool_amount_before_transfer.saturating_add(transfer_amount as u128),
            eth_pnl_pool_amount_after_transfer
        );

        case_sol_market.amm.total_fee_minus_distributions = case_sol_market
            .amm
            .total_fee_minus_distributions
            .safe_sub(transfer_amount.cast().unwrap())
            .unwrap();

        // To skip BlockchainClockInconsistency
        case_eth_market.insurance_claim.last_revenue_withdraw_ts = 0;
        case_spot_market.insurance_fund.last_revenue_settle_ts = 0;

        let now = 0_i64;

        update_pool_balances(&mut case_sol_market, &mut case_spot_market, 0, 0, now).unwrap();
        update_pool_balances(&mut case_eth_market, &mut case_spot_market, 0, 0, now).unwrap();

        let sol_fee_pool_amount_after_update = get_token_amount(
            case_sol_market.amm.fee_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let eth_pnl_pool_amount_after_update = get_token_amount(
            case_eth_market.pnl_pool.scaled_balance,
            &case_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(
            sol_fee_pool_amount_after_update,
            sol_fee_pool_amount_after_transfer
        );

        assert_eq!(
            eth_pnl_pool_amount_after_update,
            eth_pnl_pool_amount_after_transfer
        );
    }
}
