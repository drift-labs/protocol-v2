use crate::controller::amm::*;
use crate::controller::insurance::settle_revenue_to_insurance_fund;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, MAX_CONCENTRATION_COEFFICIENT, PRICE_PRECISION, QUOTE_PRECISION,
    QUOTE_SPOT_MARKET_INDEX, SPOT_BALANCE_PRECISION, SPOT_CUMULATIVE_INTEREST_PRECISION,
};
use crate::state::perp_market::PoolBalance;

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

    assert!(update_concentration_coef(&mut market.amm, 0).is_err());

    let new_scale = 1;
    update_concentration_coef(&mut market.amm, new_scale).unwrap();
    assert_eq!(market.amm.min_base_asset_reserve, 353556781219);
    assert_eq!(market.amm.max_base_asset_reserve, 707100000000);

    let (orig_open_bids, orig_open_asks) =
        amm::calculate_market_open_bids_asks(&market.amm).unwrap();
    assert_eq!(orig_open_bids, 158738300748);
    assert_eq!(orig_open_asks, -194804918033);

    let new_scale = 2;
    update_concentration_coef(&mut market.amm, new_scale).unwrap();
    assert_eq!(market.amm.min_base_asset_reserve, 414215889321);
    assert_eq!(market.amm.max_base_asset_reserve, 603550000000);

    let new_scale = 5;
    update_concentration_coef(&mut market.amm, new_scale).unwrap();
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
    assert!(update_concentration_coef(&mut market.amm, new_scale).is_err());

    // different default market

    let mut market_balanced = PerpMarket::default_test();
    assert_eq!(market_balanced.amm.base_asset_amount_with_amm, 0);
    assert_eq!(market_balanced.amm.sqrt_k, 100000000000);

    let new_scale = 20;
    update_concentration_coef(&mut market_balanced.amm, new_scale).unwrap();
    assert_eq!(market_balanced.amm.min_base_asset_reserve, 97971020172);
    assert_eq!(market_balanced.amm.max_base_asset_reserve, 102071000000);

    let new_scale = AMM_RESERVE_PRECISION; // too large, err
    assert!(update_concentration_coef(&mut market_balanced.amm, new_scale).is_err());
    assert_eq!(market_balanced.amm.min_base_asset_reserve, 97971020172);
    assert_eq!(market_balanced.amm.max_base_asset_reserve, 102071000000);

    let new_scale = 140000; // near limit, very little liquidity
    update_concentration_coef(&mut market_balanced.amm, new_scale).unwrap();
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

    let prev_sqrt_k = market.amm.sqrt_k;

    // let reserve_price = market.amm.reserve_price().unwrap();
    let now = 10000;
    let oracle_price_data = OraclePriceData {
        price: (50 * PRICE_PRECISION) as i128,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
    };

    // zero funding cost
    let funding_cost: i128 = 0;
    formulaic_update_k(&mut market, &oracle_price_data, funding_cost, now).unwrap();
    assert_eq!(prev_sqrt_k, market.amm.sqrt_k);

    // positive means amm supossedly paid $500 in funding payments for interval
    let funding_cost_2: i128 = (500 * QUOTE_PRECISION) as i128;
    formulaic_update_k(&mut market, &oracle_price_data, funding_cost_2, now).unwrap();

    assert!(prev_sqrt_k > market.amm.sqrt_k);
    assert_eq!(market.amm.sqrt_k, 489000000000); // max k decrease (2.2%)
    assert_eq!(market.amm.total_fee_minus_distributions, 1000332074); //$.33 acquired from slippage increase

    // negative means amm recieved $500 in funding payments for interval
    let funding_cost_2: i128 = -((500 * QUOTE_PRECISION) as i128);
    formulaic_update_k(&mut market, &oracle_price_data, funding_cost_2, now).unwrap();

    assert_eq!(market.amm.sqrt_k, 489489000000); // max k increase (.1%)
    assert_eq!(market.amm.total_fee_minus_distributions, 1000316987); //$.33 acquired from slippage increase

    // negative means amm recieved $.001 in funding payments for interval
    let funding_cost_2: i128 = -((QUOTE_PRECISION / 1000) as i128);
    formulaic_update_k(&mut market, &oracle_price_data, funding_cost_2, now).unwrap();

    // new numbers bc of increased sqrt_k precision
    assert_eq!(market.amm.sqrt_k, 489505153137); // increase k by 1.00003314258x
    assert_eq!(market.amm.total_fee_minus_distributions, 1000316489); // ~$.005 spent from slippage decrease
                                                                      // todo: (316988-316491)/1e6 * 2 = 0.000994 < .001
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
    let to_settle_with_user =
        update_pool_balances(&mut market, &mut spot_market, 100, now).unwrap();
    assert_eq!(to_settle_with_user, 0);

    let to_settle_with_user =
        update_pool_balances(&mut market, &mut spot_market, -100, now).unwrap();
    assert_eq!(to_settle_with_user, -100);
    assert!(market.amm.fee_pool.balance() > 0);

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
    assert_eq!(pnl_pool_token_amount, 99);
    assert_eq!(amm_fee_pool_token_amount, 1);

    let to_settle_with_user =
        update_pool_balances(&mut market, &mut spot_market, 100, now).unwrap();
    assert_eq!(to_settle_with_user, 99);
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
    assert_eq!(amm_fee_pool_token_amount, 1);

    market.amm.total_fee_minus_distributions = 0;
    update_pool_balances(&mut market, &mut spot_market, -1, now).unwrap();
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
    assert_eq!(pnl_pool_token_amount, 2);
    assert_eq!(amm_fee_pool_token_amount, 0);

    market.amm.total_fee_minus_distributions = 90_000 * QUOTE_PRECISION as i128;
    update_pool_balances(
        &mut market,
        &mut spot_market,
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
    assert_eq!(pnl_pool_token_amount, 99_000_000_000 + 2);
    assert_eq!(amm_fee_pool_token_amount, (1_000 * QUOTE_PRECISION));

    // negative fee pool
    market.amm.total_fee_minus_distributions = -8_008_123_456;

    update_pool_balances(&mut market, &mut spot_market, 1_000_987_789, now).unwrap();
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
    assert_eq!(pnl_pool_token_amount, 99_000_000_000 + 2 - 987_789);
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

    update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();

    assert_eq!(market.amm.fee_pool.scaled_balance, 44000000000000000);
    assert_eq!(market.pnl_pool.scaled_balance, 50000000000000000);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 6000000000000000);
    assert_eq!(market.amm.total_fee_withdrawn, 6000000);

    assert!(market.amm.fee_pool.scaled_balance < prev_fee_pool);
    assert_eq!(market.pnl_pool.scaled_balance, prev_pnl_pool);
    assert!(spot_market.revenue_pool.scaled_balance > prev_rev_pool);
}

#[test]
fn update_pool_balances_revenue_to_fee_test() {
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
            total_fee_minus_distributions: -(10000 * QUOTE_PRECISION as i128),

            curve_update_intensity: 100,

            fee_pool: PoolBalance {
                scaled_balance: 50 * SPOT_BALANCE_PRECISION,
                market_index: QUOTE_SPOT_MARKET_INDEX,
                ..PoolBalance::default()
            },
            ..AMM::default()
        },
        pnl_pool: PoolBalance {
            scaled_balance: 50 * SPOT_BALANCE_PRECISION,
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
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

    let prev_fee_pool = market.amm.fee_pool.scaled_balance;
    let prev_pnl_pool = market.amm.fee_pool.scaled_balance;
    let prev_rev_pool = spot_market.revenue_pool.scaled_balance;
    let prev_tfmd = market.amm.total_fee_minus_distributions;

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
        200 * QUOTE_PRECISION
    );
    assert_eq!(
        spot_market.revenue_pool.scaled_balance,
        100 * SPOT_BALANCE_PRECISION
    );

    update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();

    assert_eq!(
        market.amm.fee_pool.scaled_balance,
        5 * SPOT_BALANCE_PRECISION
    );
    assert_eq!(market.pnl_pool.scaled_balance, 95 * SPOT_BALANCE_PRECISION);
    assert_eq!(
        spot_market.revenue_pool.scaled_balance,
        100 * SPOT_BALANCE_PRECISION
    );
    assert_eq!(market.amm.total_fee_withdrawn, 0);
    assert_eq!(market.amm.total_fee_minus_distributions, prev_tfmd);

    assert!(market.amm.fee_pool.scaled_balance < prev_fee_pool);
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

    update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();

    assert_eq!(
        market.amm.fee_pool.scaled_balance,
        105 * SPOT_BALANCE_PRECISION
    );
    assert_eq!(market.pnl_pool.scaled_balance, 95 * SPOT_BALANCE_PRECISION);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 0);
    assert_eq!(market.amm.total_fee_withdrawn, 0);
    assert_eq!(market.amm.total_fee_minus_distributions, -9900000000);
    assert_eq!(
        market.insurance_claim.revenue_withdraw_since_last_settle,
        100000000
    );
    assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 33928058);

    let spot_market_vault_amount = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap() as u64;
    assert_eq!(spot_market_vault_amount, 200000000); // total spot_market deposit balance unchanged during transfers

    // calling multiple times doesnt effect other than fee pool -> pnl pool
    update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();
    assert_eq!(
        market.amm.fee_pool.scaled_balance,
        5 * SPOT_BALANCE_PRECISION
    );
    assert_eq!(market.pnl_pool.scaled_balance, 195 * SPOT_BALANCE_PRECISION);
    assert_eq!(market.amm.total_fee_minus_distributions, -9900000000);
    assert_eq!(market.amm.total_fee_withdrawn, 0);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 0);

    update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();
    assert_eq!(
        market.amm.fee_pool.scaled_balance,
        5 * SPOT_BALANCE_PRECISION
    );
    assert_eq!(market.pnl_pool.scaled_balance, 195 * SPOT_BALANCE_PRECISION);
    assert_eq!(market.amm.total_fee_minus_distributions, -9900000000);
    assert_eq!(market.amm.total_fee_withdrawn, 0);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 0);

    // add deposits and revenue to pool
    assert_eq!(spot_market.deposit_balance, 200 * SPOT_BALANCE_PRECISION);
    spot_market.revenue_pool.scaled_balance = 9900000001000;

    let spot_market_backup = spot_market;
    let market_backup = market;
    assert!(update_pool_balances(&mut market, &mut spot_market, 0, now).is_err()); // assert is_err if any way has revenue pool above deposit balances
    spot_market = spot_market_backup;
    market = market_backup;
    spot_market.deposit_balance += 9900000001000;
    let spot_market_vault_amount = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap() as u64;
    assert_eq!(spot_market.deposit_balance, 10100000001000);
    assert_eq!(spot_market_vault_amount, 10100000001);

    update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();
    assert_eq!(spot_market.deposit_balance, 10100000001000);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 9800000001000);
    assert_eq!(market.amm.fee_pool.scaled_balance, 105000000000);
    assert_eq!(market.pnl_pool.scaled_balance, 195000000000);
    assert_eq!(market.amm.total_fee_minus_distributions, -9800000000);
    assert_eq!(market.amm.total_fee_withdrawn, 0);
    assert_eq!(
        market.insurance_claim.revenue_withdraw_since_last_settle,
        market.insurance_claim.max_revenue_withdraw_per_period
    );
    assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 33928058);

    // calling again only does fee -> pnl pool
    update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();
    assert_eq!(market.amm.fee_pool.scaled_balance, 5000000000);
    assert_eq!(market.pnl_pool.scaled_balance, 295000000000);
    assert_eq!(market.amm.total_fee_minus_distributions, -9800000000);
    assert_eq!(market.amm.total_fee_withdrawn, 0);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 9800000001000);
    assert_eq!(
        market.insurance_claim.revenue_withdraw_since_last_settle,
        market.insurance_claim.max_revenue_withdraw_per_period
    );
    assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 33928058);

    // calling again does nothing
    update_pool_balances(&mut market, &mut spot_market, 0, now).unwrap();
    assert_eq!(market.amm.fee_pool.scaled_balance, 5000000000);
    assert_eq!(market.pnl_pool.scaled_balance, 295000000000);
    assert_eq!(market.amm.total_fee_minus_distributions, -9800000000);
    assert_eq!(market.amm.total_fee_withdrawn, 0);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 9800000001000);
    assert_eq!(
        market.insurance_claim.revenue_withdraw_since_last_settle,
        market.insurance_claim.max_revenue_withdraw_per_period
    );
    assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 33928058);

    // do a revenue settlement to allow up to max again
    assert_eq!(spot_market.insurance_fund.last_revenue_settle_ts, 0);
    assert_eq!(spot_market.deposit_balance, 10100000001000);

    spot_market.insurance_fund.total_factor = 1;
    spot_market.insurance_fund.revenue_settle_period = 1;
    let res =
        settle_revenue_to_insurance_fund(spot_market_vault_amount, 0, &mut spot_market, now + 3600)
            .unwrap();
    assert_eq!(res, 9800000001);

    let spot_market_vault_amount = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap() as u64;

    assert_eq!(spot_market.deposit_balance, 300000000000); // 100000000 was added to market fee/pnl pool
    assert_eq!(spot_market.borrow_balance, 0);
    assert_eq!(spot_market_vault_amount, 300000000);

    assert_eq!(spot_market.revenue_pool.scaled_balance, 0);
    assert_eq!(
        spot_market.insurance_fund.last_revenue_settle_ts,
        now + 3600
    );

    // add deposits and revenue to pool
    spot_market.revenue_pool.scaled_balance = 9800000001000;
    let market_backup = market;
    let spot_market_backup = spot_market;
    assert!(update_pool_balances(&mut market, &mut spot_market, 0, now + 3600).is_err()); // assert is_err if any way has revenue pool above deposit balances
    market = market_backup;
    spot_market = spot_market_backup;
    spot_market.deposit_balance += 9800000000001;

    assert_eq!(market.amm.fee_pool.scaled_balance, 5000000000);
    assert_eq!(market.pnl_pool.scaled_balance, 295000000000);
    assert_eq!(market.amm.total_fee_minus_distributions, -9800000000);
    assert_eq!(market.amm.total_fee_withdrawn, 0);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 9800000001000);
    assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 33928058);
    assert_eq!(
        spot_market.insurance_fund.last_revenue_settle_ts,
        33928058 + 3600
    );

    assert!(update_pool_balances(&mut market, &mut spot_market, 0, now).is_err()); // now timestamp passed is wrong
    update_pool_balances(&mut market, &mut spot_market, 0, now + 3600).unwrap();

    assert_eq!(market.insurance_claim.last_revenue_withdraw_ts, 33931658);
    assert_eq!(spot_market.insurance_fund.last_revenue_settle_ts, 33931658);
    assert_eq!(market.amm.fee_pool.scaled_balance, 205000000000);
    assert_eq!(market.pnl_pool.scaled_balance, 295000000000);
    assert_eq!(market.amm.total_fee_minus_distributions, -9600000000);
    assert_eq!(market.amm.total_fee_withdrawn, 0);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 9600000001000);
    assert_eq!(
        market.insurance_claim.revenue_withdraw_since_last_settle,
        market.insurance_claim.max_revenue_withdraw_per_period
    );
}
