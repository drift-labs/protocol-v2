use std::str::FromStr;

use crate::{
    controller::spot_balance::{execute_transfer_between_pools, update_spot_balances},
    math::{
        bn,
        constants::{
            AMM_RESERVE_PRECISION, MAX_CONCENTRATION_COEFFICIENT, MAX_SQRT_K, PRICE_PRECISION_I64,
            QUOTE_PRECISION, QUOTE_SPOT_MARKET_INDEX, SPOT_BALANCE_PRECISION,
            SPOT_CUMULATIVE_INTEREST_PRECISION,
        },
    },
    state::{
        events::TransferFeeAndPnlPoolDirection,
        oracle::OraclePriceData,
        paused_operations::PerpOperation,
        perp_market::{FeeLedger, InsuranceClaim, MarketConfigFlag, PerpMarket, PoolBalance},
        spot_market::SpotBalanceType,
        user::SpotPosition,
    },
    test_utils::create_account_info,
    vlp::amm::{
        controller::*,
        math::{amm, cp_curve, cp_curve::get_update_k_result},
        AMM,
    },
};

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

    assert!(market.amm.update_concentration_coef(0).is_err());

    let new_scale = 1;
    market.amm.update_concentration_coef(new_scale).unwrap();
    assert_eq!(market.amm.min_base_asset_reserve, 353556781219);
    assert_eq!(market.amm.max_base_asset_reserve, 707100000000);

    let (orig_open_bids, orig_open_asks) =
        amm::calculate_market_open_bids_asks(&market.amm).unwrap();
    assert_eq!(orig_open_bids, 158738300748);
    assert_eq!(orig_open_asks, -194804918033);

    let new_scale = 2;
    market.amm.update_concentration_coef(new_scale).unwrap();
    assert_eq!(market.amm.min_base_asset_reserve, 414215889321);
    assert_eq!(market.amm.max_base_asset_reserve, 603550000000);

    let new_scale = 5;
    market.amm.update_concentration_coef(new_scale).unwrap();
    assert_eq!(market.amm.min_base_asset_reserve, 461748734808);
    assert_eq!(market.amm.max_base_asset_reserve, 541420000000);
    let new_sqrt_k = market.amm.sqrt_k * new_scale;
    let update_k_result = get_update_k_result(
        &market.amm,
        market.status,
        bn::U192::from(new_sqrt_k),
        false,
    )
    .unwrap();
    let adjustment_cost = cp_curve::adjust_k_cost(&market.amm, &update_k_result).unwrap();
    assert_eq!(adjustment_cost, 11_575_563);

    market.amm.apply_k_update(&update_k_result).unwrap();
    assert_eq!(market.amm.sqrt_k, new_sqrt_k);

    let (open_bids, open_asks) = amm::calculate_market_open_bids_asks(&market.amm).unwrap();
    assert_eq!(open_bids, 207313827452);
    assert_eq!(open_asks, -198879016393);

    assert_eq!(orig_open_bids - open_bids, -48575526704);
    assert_eq!(orig_open_asks - open_asks, 4074098360);

    let new_scale = 100; // moves boundary to prevent base_asset_amount_with_amm to close
    assert!(market.amm.update_concentration_coef(new_scale).is_err());

    // different default market

    let mut market_balanced = PerpMarket::default_test();
    assert_eq!(market_balanced.amm.base_asset_amount_with_amm, 0);
    assert_eq!(market_balanced.amm.sqrt_k, 100000000000);

    let new_scale = 20;
    market_balanced
        .amm
        .update_concentration_coef(new_scale)
        .unwrap();
    assert_eq!(market_balanced.amm.min_base_asset_reserve, 97971020172);
    assert_eq!(market_balanced.amm.max_base_asset_reserve, 102071000000);

    let new_scale = AMM_RESERVE_PRECISION; // too large, err
    assert!(market_balanced
        .amm
        .update_concentration_coef(new_scale)
        .is_err());
    assert_eq!(market_balanced.amm.min_base_asset_reserve, 97971020172);
    assert_eq!(market_balanced.amm.max_base_asset_reserve, 102071000000);

    let new_scale = 140000; // near limit, very little liquidity
    market_balanced
        .amm
        .update_concentration_coef(new_scale)
        .unwrap();
    assert_eq!(market_balanced.amm.min_base_asset_reserve, 99999800000);
    assert_eq!(market_balanced.amm.max_base_asset_reserve, 100000200000);

    let new_sqrt_k = market_balanced.amm.sqrt_k * new_scale;
    let update_k_result = get_update_k_result(
        &market_balanced.amm,
        market_balanced.status,
        bn::U192::from(new_sqrt_k),
        false,
    )
    .unwrap();
    let adjustment_cost = cp_curve::adjust_k_cost(&market_balanced.amm, &update_k_result).unwrap();
    assert_eq!(adjustment_cost, 0);

    market_balanced
        .amm
        .apply_k_update(&update_k_result)
        .unwrap();
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
        0,
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
        0,
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
        0,
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
        0,
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
        0,
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
        0,
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
        0,
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
        0,
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
        0,
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
        0,
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
fn update_pool_balances_pending_fee_drain_test() {
    // explicit IF/protocol/AMM carveouts accrued at fill time are drained
    // from the PNL pool (where fee value lands as fills settle) into
    // revenue_pool / protocol_fee_pool / amm.fee_pool. The protocol drain is
    // exempt from the retention buffer (it reserves only max(net_user_pnl, 0)
    // and runs first); the IF and provision drains leave
    // max(net_user_pnl, 0) + buffer behind. The AMM's books are never
    // touched by the sweep.
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 5122950819670000,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000,
            base_asset_amount_with_amm: -122950819670000,

            total_fee: 10 * QUOTE_PRECISION as i128,
            total_mm_fee: 990 * QUOTE_PRECISION as i128,
            total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
            net_revenue_since_last_funding: 10000 * QUOTE_PRECISION as i64,
            curve_update_intensity: 100,

            fee_pool: PoolBalance {
                scaled_balance: 0,
                market_index: QUOTE_SPOT_MARKET_INDEX,
                ..PoolBalance::default()
            },
            ..AMM::default()
        },
        pnl_pool: PoolBalance {
            scaled_balance: 4 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        fee_ledger: FeeLedger {
            pending_protocol_fee: 3 * QUOTE_PRECISION,
            pending_if_fee: 2 * QUOTE_PRECISION,
            pending_amm_provision: QUOTE_PRECISION,
            amm_protocol_fees_received: QUOTE_PRECISION,
            ..FeeLedger::default()
        },
        fee_pool_buffer_target: 5 * QUOTE_PRECISION as u64,
        ..PerpMarket::default()
    };
    let now = 33928058;

    let mut spot_market = SpotMarket {
        // large enough to cover the pnl pool after it is topped up below
        // (pool balances are counted inside deposit_balance)
        deposit_balance: 400 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        revenue_pool: PoolBalance::default(),
        ..SpotMarket::default()
    };

    // pnl pool (4 QUOTE) is under the 5-QUOTE retention buffer: the
    // buffer-exempt protocol drain still takes its full 3 QUOTE, the
    // buffered IF/provision drains wait
    let spot_position = SpotPosition::default();
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        0,
        now,
    )
    .unwrap();

    assert_eq!(market.pnl_pool.scaled_balance, 1000000000000000); // 4 - 3 QUOTE
    assert_eq!(spot_market.revenue_pool.scaled_balance, 0);
    assert_eq!(market.protocol_fee_pool.scaled_balance, 3000000000000000); // 3 QUOTE
    assert_eq!(market.amm.fee_pool.scaled_balance, 0);
    assert_eq!(market.fee_ledger.pending_protocol_fee, 0);
    assert_eq!(market.fee_ledger.pending_if_fee, 2 * QUOTE_PRECISION);
    assert_eq!(market.fee_ledger.pending_amm_provision, QUOTE_PRECISION);

    // top up the pnl pool above buffer + pendings: the rest drains in full
    market.pnl_pool.scaled_balance = 50 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION;
    let tfmd_before = market.amm.total_fee_minus_distributions;
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        0,
        now,
    )
    .unwrap();

    assert_eq!(spot_market.revenue_pool.scaled_balance, 2000000000000000); // 2 QUOTE
    assert_eq!(market.protocol_fee_pool.scaled_balance, 3000000000000000); // unchanged
    assert_eq!(market.amm.fee_pool.scaled_balance, 1000000000000000); // 1 QUOTE tokenized
    assert_eq!(market.pnl_pool.scaled_balance, 47000000000000000); // 50 - 3 QUOTE
    assert_eq!(market.fee_ledger.pending_protocol_fee, 0);
    assert_eq!(market.fee_ledger.pending_if_fee, 0);
    assert_eq!(market.fee_ledger.pending_amm_provision, 0);
    // the sweep never touches the AMM's books: the provision was booked at
    // fill, tokenization is a pure token transfer; the clawback cap stays
    assert_eq!(market.amm.total_fee_minus_distributions, tfmd_before);
    assert_eq!(market.amm.total_fee_withdrawn, 0);
    assert_eq!(
        market.fee_ledger.amm_protocol_fees_received,
        QUOTE_PRECISION
    );

    // nothing pending: idempotent
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        0,
        now,
    )
    .unwrap();
    assert_eq!(market.protocol_fee_pool.scaled_balance, 3000000000000000);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 2000000000000000);
    assert_eq!(market.amm.fee_pool.scaled_balance, 1000000000000000);

    // positive net user pnl reserves pool tokens for user claims: with
    // 47 QUOTE in the pool and 38 QUOTE of net user claims, the buffer-exempt
    // protocol drain takes its full 2 QUOTE from the 9 QUOTE of headroom;
    // the buffered IF drain then sees 7 - 5 = 2 QUOTE and partially drains
    market.fee_ledger.pending_if_fee = 4 * QUOTE_PRECISION;
    market.fee_ledger.pending_protocol_fee = 2 * QUOTE_PRECISION;
    let net_user_pnl = (38 * QUOTE_PRECISION).cast::<i128>().unwrap();
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        net_user_pnl,
        now,
    )
    .unwrap();
    assert_eq!(spot_market.revenue_pool.scaled_balance, 4000000000000000); // 2 + 2 QUOTE
    assert_eq!(market.protocol_fee_pool.scaled_balance, 5000000000000000); // 3 + 2 QUOTE
    assert_eq!(market.pnl_pool.scaled_balance, 43000000000000000); // 47 - 4 QUOTE
    assert_eq!(market.fee_ledger.pending_if_fee, 2 * QUOTE_PRECISION);
    assert_eq!(market.fee_ledger.pending_protocol_fee, 0);
}

#[test]
fn amm_isolation_balance_sheet_identity_test() {
    // the balance-sheet identity the summary-stats recompute relies on —
    //   tfmd == (pnl_pool + fee_pool) − net_user_pnl − pending_protocol − pending_if
    // — holds exactly through fill accrual, loser settle, and the sweep
    // (no integer drift in this construction). `pending_amm_provision` is
    // NOT subtracted: the provision is booked into tfmd at fill while its
    // token backing (counted in the pools) waits in the pnl pool.
    let oracle_price = PRICE_PRECISION_I64;

    let mut market = PerpMarket {
        // no base position: net_user_pnl == quote_asset_amount
        quote_asset_amount: 0,
        pnl_pool: PoolBalance {
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        fee_pool_buffer_target: 0,
        ..PerpMarket::default()
    };
    market.amm.fee_pool.market_index = QUOTE_SPOT_MARKET_INDEX;

    let mut spot_market = SpotMarket {
        deposit_balance: 400 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        ..SpotMarket::default()
    };

    let identity = |market: &PerpMarket, spot_market: &SpotMarket| {
        crate::vlp::amm::controller::calculate_perp_market_amm_summary_stats(
            market,
            spot_market,
            oracle_price,
        )
        .unwrap()
    };

    // 1. fill: taker pays a 10-QUOTE fee, split amm 1 / if 5 / protocol 4.
    //    The taker's position is debited (net_user_pnl falls), the AMM books
    //    only its provision, the ledger accrues all three carveouts.
    let (gross, amm_fee, if_fee, protocol_fee) = (10u64, 1u64, 5u64, 4u64);
    market.quote_asset_amount = -(gross as i128) * QUOTE_PRECISION as i128;
    market
        .fee_ledger
        .accrue_fill_fees(
            gross * QUOTE_PRECISION as u64,
            protocol_fee * QUOTE_PRECISION as u64,
            if_fee * QUOTE_PRECISION as u64,
            amm_fee * QUOTE_PRECISION as u64,
        )
        .unwrap();
    use crate::vlp::amm::quoter::AmmContract;
    market
        .amm
        .record_amm_pnl((amm_fee as i128) * QUOTE_PRECISION as i128)
        .unwrap();
    assert_eq!(
        identity(&market, &spot_market),
        market.amm.total_fee_minus_distributions
    );

    // 2. the loser settles: tokens land in the pnl pool, claims shrink
    market.pnl_pool.scaled_balance = 10 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION;
    market.quote_asset_amount = 0;
    assert_eq!(
        identity(&market, &spot_market),
        market.amm.total_fee_minus_distributions
    );

    // 3. sweep: pendings materialize, provision tokenizes — identity holds
    //    and the AMM's books are untouched
    let tfmd_before = market.amm.total_fee_minus_distributions;
    let (if_swept, protocol_swept, provision_tokenized) =
        sweep_market_fees(&mut market, &mut spot_market, 0, 0, false).unwrap();
    assert_eq!(if_swept, 5 * QUOTE_PRECISION);
    assert_eq!(protocol_swept, 4 * QUOTE_PRECISION);
    assert_eq!(provision_tokenized, QUOTE_PRECISION);
    assert_eq!(market.amm.total_fee_minus_distributions, tfmd_before);
    assert_eq!(
        market.amm.fee_pool.scaled_balance,
        QUOTE_PRECISION * SPOT_BALANCE_PRECISION
    );
    assert_eq!(
        identity(&market, &spot_market),
        market.amm.total_fee_minus_distributions
    );

    // invariant: the provision queue never exceeds the clawback cap
    assert!(
        market.fee_ledger.pending_amm_provision <= market.fee_ledger.amm_protocol_fees_received
    );
    assert_eq!(
        market.fee_ledger.amm_protocol_fees_received,
        QUOTE_PRECISION
    );
}

#[test]
fn update_pool_balances_pending_fee_drain_capped_test() {
    // the buffer-exempt protocol drain runs first and is capped only by the
    // pool's surplus over user claims; the IF and provision drains are then
    // capped by what remains above the retention buffer. The un-drained
    // remainder stays pending for the next sweep
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 5122950819670000,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000,
            base_asset_amount_with_amm: -122950819670000,

            total_fee: 10 * QUOTE_PRECISION as i128,
            total_mm_fee: 990 * QUOTE_PRECISION as i128,
            total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
            net_revenue_since_last_funding: QUOTE_PRECISION as i64,
            curve_update_intensity: 100,

            fee_pool: PoolBalance {
                scaled_balance: 0,
                market_index: QUOTE_SPOT_MARKET_INDEX,
                ..PoolBalance::default()
            },
            ..AMM::default()
        },
        pnl_pool: PoolBalance {
            scaled_balance: (5 + 10) * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        fee_ledger: FeeLedger {
            pending_protocol_fee: 7 * QUOTE_PRECISION,
            pending_if_fee: 8 * QUOTE_PRECISION,
            pending_amm_provision: 6 * QUOTE_PRECISION,
            amm_protocol_fees_received: 6 * QUOTE_PRECISION,
            ..FeeLedger::default()
        },
        fee_pool_buffer_target: 5 * QUOTE_PRECISION as u64,
        ..PerpMarket::default()
    };
    let now = 33928058;

    let mut spot_market = SpotMarket {
        deposit_balance: 400 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        revenue_pool: PoolBalance::default(),
        ..SpotMarket::default()
    };

    // the buffer-exempt protocol drain takes its full 7 QUOTE first; that
    // leaves 8 QUOTE, only 3 of which sit above the 5-QUOTE buffer — the IF
    // partially drains, the AMM provision waits
    let spot_position = SpotPosition::default();
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        0,
        now,
    )
    .unwrap();

    assert_eq!(spot_market.revenue_pool.scaled_balance, 3000000000000000); // 3 QUOTE
    assert_eq!(market.protocol_fee_pool.scaled_balance, 7000000000000000); // 7 QUOTE
    assert_eq!(market.amm.fee_pool.scaled_balance, 0);
    assert_eq!(
        market.pnl_pool.scaled_balance,
        5 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION
    );
    assert_eq!(market.fee_ledger.pending_if_fee, 5 * QUOTE_PRECISION);
    assert_eq!(market.fee_ledger.pending_protocol_fee, 0);
    assert_eq!(market.fee_ledger.pending_amm_provision, 6 * QUOTE_PRECISION);

    // top the pnl pool back up: the remaining IF fee + provision drain
    market.pnl_pool.scaled_balance = (5 + 50) * QUOTE_PRECISION * SPOT_BALANCE_PRECISION;
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        0,
        now,
    )
    .unwrap();
    assert_eq!(spot_market.revenue_pool.scaled_balance, 8000000000000000); // 3 + 5 QUOTE
    assert_eq!(market.protocol_fee_pool.scaled_balance, 7000000000000000); // unchanged
    assert_eq!(market.amm.fee_pool.scaled_balance, 6000000000000000); // 6 QUOTE
    assert_eq!(market.fee_ledger.pending_if_fee, 0);
    assert_eq!(market.fee_ledger.pending_protocol_fee, 0);
    assert_eq!(market.fee_ledger.pending_amm_provision, 0);
    // tokenization is balance-only: the books were credited at fill
    assert_eq!(
        market.amm.total_fee_minus_distributions,
        1000 * QUOTE_PRECISION as i128
    );

    // a paused market never drains
    let mut paused_market = PerpMarket {
        pnl_pool: PoolBalance {
            scaled_balance: 100 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        fee_ledger: FeeLedger {
            pending_protocol_fee: QUOTE_PRECISION,
            pending_if_fee: QUOTE_PRECISION,
            ..FeeLedger::default()
        },
        paused_operations: PerpOperation::SettleRevPool as u8,
        ..PerpMarket::default()
    };
    let user_quote_token_amount = spot_position.get_signed_token_amount(&spot_market).unwrap();
    update_pool_balances(
        &mut paused_market,
        &mut spot_market,
        user_quote_token_amount,
        0,
        0,
        now,
    )
    .unwrap();
    assert_eq!(paused_market.protocol_fee_pool.scaled_balance, 0);
    assert_eq!(
        paused_market.fee_ledger.pending_protocol_fee,
        QUOTE_PRECISION
    );
    assert_eq!(paused_market.fee_ledger.pending_if_fee, QUOTE_PRECISION);
}

#[test]
fn sweep_market_fees_force_overrides_settle_rev_pool_pause() {
    // A SettleRevPool-paused market early-returns from the streaming sweep
    // (covered above). The final delisting sweep passes force=true and must
    // drain regardless, so the protocol carveout lands in protocol_fee_pool
    // instead of being dumped wholesale into the revenue pool / IF.
    let mut spot_market = SpotMarket {
        deposit_balance: 400 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        revenue_pool: PoolBalance::default(),
        ..SpotMarket::default()
    };

    let mut market = PerpMarket {
        pnl_pool: PoolBalance {
            scaled_balance: 100 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION,
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        fee_ledger: FeeLedger {
            pending_protocol_fee: 7 * QUOTE_PRECISION,
            pending_if_fee: 8 * QUOTE_PRECISION,
            ..FeeLedger::default()
        },
        paused_operations: PerpOperation::SettleRevPool as u8,
        ..PerpMarket::default()
    };

    let now = 33928058;

    // force = false: the pause holds and nothing drains.
    let (if_swept, protocol_swept, _) =
        sweep_market_fees(&mut market, &mut spot_market, 0, now, false).unwrap();
    assert_eq!(if_swept, 0);
    assert_eq!(protocol_swept, 0);
    assert_eq!(market.protocol_fee_pool.scaled_balance, 0);
    assert_eq!(market.fee_ledger.pending_protocol_fee, 7 * QUOTE_PRECISION);

    // force = true: the pause is overridden and the waterfall runs. With
    // net_user_pnl = 0 and a zero buffer target, both the protocol and IF cuts
    // drain in full — the protocol cut to the withdrawable protocol_fee_pool.
    let (if_swept, protocol_swept, _) =
        sweep_market_fees(&mut market, &mut spot_market, 0, now, true).unwrap();
    assert_eq!(protocol_swept, 7 * QUOTE_PRECISION);
    assert_eq!(if_swept, 8 * QUOTE_PRECISION);
    assert_eq!(
        market.protocol_fee_pool.scaled_balance,
        7 * QUOTE_PRECISION * SPOT_BALANCE_PRECISION
    );
    assert_eq!(market.fee_ledger.pending_protocol_fee, 0);
    assert_eq!(market.fee_ledger.pending_if_fee, 0);
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

            total_fee: 130757047337,
            total_mm_fee: 112696236155,
            total_fee_minus_distributions: 338762376993,
            total_fee_withdrawn: 161959731500,
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
        quote_asset_amount: -90559143969,
        fee_ledger: FeeLedger {
            total_exchange_fee: 18223810834,
            total_liquidation_fee: 152847899222,
            ..FeeLedger::default()
        },
        total_social_loss: 74768391959,
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

            total_fee: 26000,
            total_mm_fee: 0,
            total_fee_minus_distributions: 26000,
            total_fee_withdrawn: 0,
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
        quote_asset_amount: 0,
        fee_ledger: FeeLedger {
            total_exchange_fee: 26000,
            total_liquidation_fee: 0,
            ..FeeLedger::default()
        },
        total_social_loss: 0,
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

#[test]
pub fn perp_market_transfer_fee_and_pnl_pool() {
    let key = Pubkey::default();
    let owner = Pubkey::from_str("vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P").unwrap();
    let mut lamports = 0;

    // SOL (as of slot 409451609)
    let sol_perp_market_str = String::from("Ct8MLGv1N/dvAH3EF67yBqaUQerctpm4yqpK+QNSrXCQz76p+B+kawA9XbpHcQEAAAAAAAAAAACAu7hCQY7+////////////1R97W70CAAAAAAAAAAAAAGat7M1w1/////////////+SMT48ViwAAAAAAAAAAAAAfYgvvOLX/////////////0+x5G+hKwAAAAAAAAAAAAAAAI1J/RoHAAAAAAAAAAAAwbj5DAEAAAAAAAAAAAAAAA93sVcKAAAAAAAAAAAAAACUG2dLCgAAAAAAAAAAAAAAs/F3GBYQAAAAAAAAAAAAABdPYMUUBQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKQNiJx5MO2nHtSkF9z+iP64YQbCGshSPNHiJ8f6VL+H74hTvGU8WAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFNPTC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAB8K+v////8A4fUFAAAAAAAQpdToAAAAsnK2MSwAAAAC7cdpAAAAABx79P//////HHv0//////8ce/T///////Hsx2kAAAAAm1av///////Eu/QEAAAAAICWmAAAAAAAZAAAAAAAAABAQg8AAAAAAAAAAAAAAAAAAAAAAAAAAABNyPgAAAAAAPFzAAAAAAAAMgAAAAAAAABMHQAATB0AAPQBAAAsAQAAAAAAABAnAABuDQAAqAkAAAAAAQABAAAAAAAAAAAAAABCAAAABAEAAhFe9wQAAAAAAQz/FAAAAADwZvQEAAAAAAYF9gQAAAAA2u7HaQAAAABSefMEAAAAAI5U9QQAAAAAncQCAAAAAAA+lwIAAAAAAIEAAAAAAAAA04ppTjoWAAAmbBjfewAAALWEqk9HAAAAsu7HaQAAAACxVPz//////xAOAAAAAAAAgJaYAAAAAABRU/cEAAAAACLAZxgAAAAAULdE/RZOBgAkg/cEAAAAAHD+//8BAAAAAAAAAAAAAAAkg/cEAAAAAAAAAAAAAAAAAAAAAAAAAAAW7PQEAAAAAJZx9gQAAAAA2u7HaQAAAAAAAAAAAAAAAC2sCLqnSyIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiLvIqRxgkwAAAAAAAAAAAFayR7AfX5MAAAAAAAAAAABuUg8AAAAAAAAAAAAAAAAAvETQFAbEkgAAAAAAAAAAAGkF5Tzq+5MAAAAAAAAAAAAb79Esnl+TAAAAAAAAAAAAqov3BAAAAAAAAAAAAAAAAEmLxbKWX5MAAAAAAAAAAACA+BX9iP//////////////i4bjah0aAAAAAAAAAAAAAFe2ZGUrCgAAAAAAAAAAAAAmzXDeFw0AAAAAAAAAAAAAtsCc654HAAAAAAAAAAAAAPy/ZxgAAAAAklyKBwAAAAAAAAAAAAAAAAAAAAAAAAAAyAAAACBOAACoYTIAaGRi7AAAAAAAAAAAAAAAAAAAAAA=");

    let mut sol_perp_decoded = unsafe {
        crate::test_utils::aligned_account_bytes_from_b64::<PerpMarket>(&sol_perp_market_str)
    };
    let sol_perp_account_info =
        create_account_info(&key, true, &mut lamports, &mut sol_perp_decoded, &owner);

    let sol_perp_market = *AccountLoader::<PerpMarket>::try_from(&sol_perp_account_info)
        .unwrap()
        .load_mut()
        .unwrap();

    // ETH (as of slot 409497574)
    let eth_perp_market_str = String::from("Ct8MLGv1N/cP8V8Fb1epGNxhYovgt6QslGhUT6HV1zTpfCkrkbwLkoAAnOeOAwAAAAAAAAAAAAAA7WOEb/z/////////////lv7XDHMBAAAAAAAAAAAAADCpXUuQ9/////////////8h8QjUrgkAAAAAAAAAAAAAVKXVKYz3/////////////0AW/aXJCQAAAAAAAAAAAAAAID2IeS0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADmMX2gSAQAAAAAAAAAAAABN5WMHEgEAAAAAAAAAAAAA5S0lzhECAAAAAAAAAAAAAMCrPYJDAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAd3DH2Q4dNNF2yrr6HjJmXJlYvanqTxxULDNngUZsJSq8iOMa/PEDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEVUSC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAA4fUFAAAAAP8PpdToAAAAFhrxGBIAAACkdwppAAAAACRtOQEAAAAAJG05AQAAAABd4jgBAAAAAE0zyGkAAAAA9Eg59wEAAAAI12J4AAAAAEBCDwAAAAAAECcAAAAAAAAA4fUFAAAAAAAAAAAAAAAAAAAAAAAAAAArwFwAAAAAAJZwAAAAAAAA+gAAAAAAAACIEwAATB0AAPQBAADIAAAAAAAAABAnAADaAgAA/AIAAAIAAQABgAAAAAAAAAAAAABCAAAAAAAAAICBe3gAAAAAAAz/FAAAAACKjGR4AAAAAEGbXXgAAAAAqDPIaQAAAADXfEh4AAAAAD6cgHgAAAAAO/0dAAAAAACvUhsAAAAAAD4AAAAAAAAAutxz8+ACAAAX36EsBwAAAEKKf3wDAAAAqDPIaQAAAAAg0XQAAAAAABAOAAAAAAAAQEIPAAAAAABXZXV4AAAAAOZvaBgAAAAAAA5nFhtOBgBQ8HZ4AAAAAMT///8BAAAAAAAAAAAAAABcZXV4AAAAAAAAAAAAAAAAAQAAAAAAAAD9JGN4AAAAAKGdW3gAAAAAqDPIaQAAAAAAAAAAAAAAAKH7hNupQQMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAirqG22EUAAAAAAAAAAAAAEzdpbNeFAAAAAAAAAAAAABXSg8AAAAAAAAAAAAAAAAA8gmyf1UUAAAAAAAAAAAAAEl4EhVrFAAAAAAAAAAAAAAKqIZHYBQAAAAAAAAAAAAA2HbdeAAAAAAAAAAAAAAAAAqohkdgFAAAAAAAAAAAAACA7f9r/v//////////////OU1nlgUFAAAAAAAAAAAAADTFXgv5AgAAAAAAAAAAAAA5SOd/xQAAAAAAAAAAAAAA89kg4EsBAAAAAAAAAAAAAOBvaBgAAAAA98MBAAAAAAAAAAAAAAAAAAAAAAAAAAAArwAAABAnAAAgTjIAZQAAzgUAAAAAAAAAAAAAAAAAAAA=");

    let mut eth_perp_decoded = unsafe {
        crate::test_utils::aligned_account_bytes_from_b64::<PerpMarket>(&eth_perp_market_str)
    };
    let sol_perp_account_info =
        create_account_info(&key, true, &mut lamports, &mut eth_perp_decoded, &owner);

    let eth_perp_market = *AccountLoader::<PerpMarket>::try_from(&sol_perp_account_info)
        .unwrap()
        .load_mut()
        .unwrap();

    // USDC (as of slot 409451751)
    let usdc_spot_market_str = String::from("ZLEIa6hBQSdUX6MOo7w/PClm2otsPf7406t9pXygIypU5KAmT//Dwn4XAskDe6KnOB2fuc5t8V0PxU10u3MRn4rxLxkMDhW+xvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWHmsHZFgFFAI49uEcLfeyYJqqXqJL+++g9w+I4yK2cfD1VTREMgICAgICAgICAgICAgICAgICAgICAgICAgICAgEeQyJ9kZP4WsuF8p8cVq/vGj3k+tUwDvAx8T7OdXugO6UrKSjQMAAAAAAAAAAAAAvVeoEjMCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAIxEAAAAAAG3hx2kAAAAAEA4AAAAAAACghgEAXMEAAAAAAAAAAAAAAAAAAAAAAAB+S/WO/sleAQAAAAAAAAAAl91BvhcIrwAAAAAAAAAAABf+dcwCAAAAAAAAAAAAAACmoX9BAwAAAAAAAAAAAAAAbyFoxQAAAAAAAAAAAAAAAA6CaMUAAAAAAAAAAAAAAACsh0+IwQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAukEPAAAAAAAtAAAAAAAAAB0AAAAAAAAA50EPAAAAAAC8QQ8AAAAAAGrtx2kAAAAAQEIPAAAAAABAQg8AAAAAAEBCDwAAAAAAQEIPAAAAAAAAAAAAAAAAAACQHsS8FgAAAEBjUr/GAQAD+2y4l20AAIjoICZnPgAAiNwIAAAAAACL7cdpAAAAAIvtx2kAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAFNDCAAAAAAAQJwAAECcAABAnAAAQJwAAAAAAAAAAAACIEwAAADUMABTNAACguw0ABgAAAAAAAA8BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACjBcBAAAAAAAA6UHMawEAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");

    let mut usdc_spot_decoded = unsafe {
        crate::test_utils::aligned_account_bytes_from_b64::<SpotMarket>(&usdc_spot_market_str)
    };
    let usdc_spot_account_info =
        create_account_info(&key, true, &mut lamports, &mut usdc_spot_decoded, &owner);

    let usdc_spot_market = *AccountLoader::<SpotMarket>::try_from(&usdc_spot_account_info)
        .unwrap()
        .load_mut()
        .unwrap();

    // Case 1: No revert, transfer 100% pnl -> fee pool
    {
        let mut case_market = sol_perp_market;
        let mut case_spot_market = usdc_spot_market;

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

        update_pool_balances(&mut case_market, &mut case_spot_market, 0, 0, 0, 0).unwrap();

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
        let mut case_market = sol_perp_market;
        let mut case_spot_market = usdc_spot_market;

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

        update_pool_balances(&mut case_market, &mut case_spot_market, 0, 0, 0, now).unwrap();

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
        let mut case_sol_market = sol_perp_market;
        let mut case_eth_market = eth_perp_market;
        let mut case_spot_market = usdc_spot_market;

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

        update_pool_balances(&mut case_sol_market, &mut case_spot_market, 0, 0, 0, now).unwrap();
        update_pool_balances(&mut case_eth_market, &mut case_spot_market, 0, 0, 0, now).unwrap();

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
