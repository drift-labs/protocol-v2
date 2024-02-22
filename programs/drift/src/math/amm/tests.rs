use crate::math::amm::*;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, PEG_PRECISION, PRICE_PRECISION, PRICE_PRECISION_I64,
    PRICE_PRECISION_U64, QUOTE_PRECISION,
};
use crate::state::oracle::HistoricalOracleData;
use crate::state::perp_market::PerpMarket;
use crate::state::user::PerpPosition;

#[test]
fn calculate_amm_available_guards() {
    let prev = 1656682258;
    let _now = prev + 2;

    // let px = 32 * PRICE_PRECISION;

    let mut market: PerpMarket = PerpMarket::default_btc_test();

    let _oracle_price_data = OraclePriceData {
        price: (34 * PRICE_PRECISION) as i64,
        confidence: PRICE_PRECISION_U64 / 100,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    assert_eq!(market.amm.net_revenue_since_last_funding, 0);
    assert_eq!(market.amm.total_fee_minus_distributions, 0);

    assert_eq!(!market.has_too_much_drawdown().unwrap(), true);

    market.amm.net_revenue_since_last_funding = -100_000_000_000;
    market.amm.total_fee_minus_distributions = 100_000_000_000;

    assert_eq!(!market.has_too_much_drawdown().unwrap(), false);

    market.amm.net_revenue_since_last_funding = -10_000_000_000;
    market.amm.total_fee_minus_distributions = 100_000_000_000;

    assert_eq!(!market.has_too_much_drawdown().unwrap(), false);

    market.amm.net_revenue_since_last_funding = -5_000_000_000;
    market.amm.total_fee_minus_distributions = 100_000_000_000;

    assert_eq!(!market.has_too_much_drawdown().unwrap(), false);

    market.amm.net_revenue_since_last_funding = -1_000_000_000;
    market.amm.total_fee_minus_distributions = 100_000_000_000;

    assert_eq!(!market.has_too_much_drawdown().unwrap(), true);

    market.amm.net_revenue_since_last_funding = -1_000_000_000;
    market.amm.total_fee_minus_distributions = 1_000_000;

    assert_eq!(!market.has_too_much_drawdown().unwrap(), true);

    market.amm.net_revenue_since_last_funding = -6_000_000_000;
    market.amm.total_fee_minus_distributions = 1_000_000;

    assert_eq!(!market.has_too_much_drawdown().unwrap(), false);

    market.amm.net_revenue_since_last_funding = -5_000;
    market.amm.total_fee_minus_distributions = -9279797219;

    assert_eq!(!market.has_too_much_drawdown().unwrap(), true); // too small net_revenue_since_last_funding drawdown

    market.amm.net_revenue_since_last_funding = -88_000_000_000;
    market.amm.total_fee_minus_distributions = -9279797219;

    assert_eq!(!market.has_too_much_drawdown().unwrap(), false); // too small net_revenue_since_last_funding drawdown
}

#[test]
fn calculate_net_user_pnl_test() {
    let prev = 1656682258;
    let _now = prev + 3600;

    let px = 32 * PRICE_PRECISION;

    let amm = AMM {
        base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        peg_multiplier: PEG_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap: px as i64,
            last_oracle_price_twap_ts: prev,

            ..HistoricalOracleData::default()
        },
        mark_std: PRICE_PRECISION as u64,
        last_mark_price_twap_ts: prev,
        funding_period: 3600_i64,
        ..AMM::default_test()
    };

    let oracle_price_data = OraclePriceData {
        price: (34 * PRICE_PRECISION) as i64,
        confidence: PRICE_PRECISION_U64 / 100,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    let net_user_pnl = calculate_net_user_pnl(&amm, oracle_price_data.price).unwrap();
    assert_eq!(net_user_pnl, 0);

    let market: PerpMarket = PerpMarket::default_btc_test();
    let net_user_pnl = calculate_net_user_pnl(
        &market.amm,
        market.amm.historical_oracle_data.last_oracle_price,
    )
    .unwrap();
    assert_eq!(net_user_pnl, -400000000); // down $400

    let net_user_pnl = calculate_net_user_pnl(&market.amm, 17501 * PRICE_PRECISION_I64).unwrap();
    assert_eq!(net_user_pnl, 1499000000); // up $1499
}

#[test]
fn calculate_expiry_price_long_imbalance_with_loss_test() {
    let prev = 1656682258;
    let _now = prev + 3600;

    // imbalanced short, no longs
    // btc
    let oracle_price_data = OraclePriceData {
        price: (22050 * PRICE_PRECISION) as i64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
    };

    let market_position = PerpPosition {
        market_index: 0,
        base_asset_amount: (12295081967 / 2_i64),
        quote_asset_amount: -193688524588, // $31506 entry price
        ..PerpPosition::default()
    };

    let market = PerpMarket {
        market_index: 0,
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 22_100_000_000,
            base_asset_amount_with_amm: (12295081967_i128),
            max_spread: 1000,
            quote_asset_amount: market_position.quote_asset_amount as i128 * 2,
            // assume someone else has other half same entry,
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        imf_factor: 1000, // 1_000/1_000_000 = .001
        unrealized_pnl_initial_asset_weight: 100,
        unrealized_pnl_maintenance_asset_weight: 100,
        ..PerpMarket::default()
    };

    let mut expiry_price = calculate_expiry_price(&market.amm, oracle_price_data.price, 0).unwrap();

    let reserve_price = market.amm.reserve_price().unwrap();
    let (terminal_price, _, _) = calculate_terminal_price_and_reserves(&market.amm).unwrap();
    let oracle_price = oracle_price_data.price;

    assert_eq!(expiry_price, 22049999999);
    assert_eq!(terminal_price, 20076684570);
    assert_eq!(oracle_price, 22050000000);
    assert_eq!(reserve_price, 21051929600);

    expiry_price = calculate_expiry_price(
        &market.amm,
        oracle_price_data.price,
        111_111_110, // $111
    )
    .unwrap();

    assert_eq!(expiry_price, 22049999999); // same price

    expiry_price = calculate_expiry_price(
        &market.amm,
        oracle_price_data.price,
        1_111_111_110, // $1,111
    )
    .unwrap();

    assert_eq!(expiry_price, 22049999999); // same price again

    expiry_price = calculate_expiry_price(
        &market.amm,
        oracle_price_data.price,
        111_111_110 * QUOTE_PRECISION,
    )
    .unwrap();

    assert_eq!(expiry_price, 22049999999);
    assert_eq!(expiry_price, oracle_price - 1); // more longs than shorts, bias = -1
}

#[test]
fn calculate_expiry_price_long_imbalance_test() {
    let prev = 1656682258;
    let _now = prev + 3600;

    // imbalanced short, no longs
    // btc
    let oracle_price_data = OraclePriceData {
        price: (22050 * PRICE_PRECISION) as i64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
    };

    let market_position = PerpPosition {
        market_index: 0,
        base_asset_amount: (12295081967 / 2_i64),
        quote_asset_amount: -103688524588, // $16,866.66 entry price
        ..PerpPosition::default()
    };

    let market = PerpMarket {
        market_index: 0,
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 22_100_000_000,
            base_asset_amount_with_amm: (12295081967_i128),
            max_spread: 1000,
            quote_asset_amount: market_position.quote_asset_amount as i128 * 2,
            // assume someone else has other half same entry,
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        imf_factor: 1000, // 1_000/1_000_000 = .001
        unrealized_pnl_initial_asset_weight: 100,
        unrealized_pnl_maintenance_asset_weight: 100,
        ..PerpMarket::default()
    };

    let mut expiry_price = calculate_expiry_price(&market.amm, oracle_price_data.price, 0).unwrap();

    let reserve_price = market.amm.reserve_price().unwrap();
    let (terminal_price, _, _) = calculate_terminal_price_and_reserves(&market.amm).unwrap();
    let oracle_price = oracle_price_data.price;

    assert_eq!(expiry_price, 16866666665);
    assert_eq!(terminal_price, 20076684570);
    assert_eq!(oracle_price, 22050000000);
    assert_eq!(reserve_price, 21051929600);

    expiry_price = calculate_expiry_price(
        &market.amm,
        oracle_price_data.price,
        111_111_110, // $111
    )
    .unwrap();

    assert_eq!(expiry_price, 16875703702); // better price

    expiry_price = calculate_expiry_price(
        &market.amm,
        oracle_price_data.price,
        1_111_111_110, // $1,111
    )
    .unwrap();

    assert_eq!(expiry_price, 16957037035); // even better price

    expiry_price = calculate_expiry_price(
        &market.amm,
        oracle_price_data.price,
        111_111_110 * QUOTE_PRECISION,
    )
    .unwrap();

    assert_eq!(expiry_price, 22049999999);
    assert_eq!(expiry_price, oracle_price - 1); // more longs than shorts, bias = -1
}

#[test]
fn calculate_expiry_price_test() {
    let prev = 1656682258;
    let _now = prev + 3600;

    let px = 32 * PRICE_PRECISION;

    let amm = AMM {
        base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        peg_multiplier: PEG_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap: px as i64,
            last_oracle_price_twap_ts: prev,

            ..HistoricalOracleData::default()
        },
        mark_std: PRICE_PRECISION as u64,
        last_mark_price_twap_ts: prev,
        funding_period: 3600_i64,
        ..AMM::default_test()
    };

    let oracle_price_data = OraclePriceData {
        price: (34 * PRICE_PRECISION) as i64,
        confidence: PRICE_PRECISION_U64 / 100,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    let mut expiry_price = calculate_expiry_price(&amm, oracle_price_data.price, 0).unwrap();

    assert_eq!(expiry_price, oracle_price_data.price);

    expiry_price = calculate_expiry_price(&amm, oracle_price_data.price, 111111110).unwrap();

    assert_eq!(expiry_price, oracle_price_data.price);

    // imbalanced short, no longs
    // btc
    let oracle_price_data = OraclePriceData {
        price: (22050 * PRICE_PRECISION) as i64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
    };

    let market_position = PerpPosition {
        market_index: 0,
        base_asset_amount: -(122950819670000 / 2_i64),
        quote_asset_amount: 153688524588, // $25,000 entry price
        ..PerpPosition::default()
    };

    let market = PerpMarket {
        market_index: 0,
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 22_100_000_000,
            base_asset_amount_with_amm: -(12295081967_i128),
            max_spread: 1000,
            quote_asset_amount: market_position.quote_asset_amount as i128 * 2,
            // assume someone else has other half same entry,
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        imf_factor: 1000, // 1_000/1_000_000 = .001
        unrealized_pnl_initial_asset_weight: 100,
        unrealized_pnl_maintenance_asset_weight: 100,
        ..PerpMarket::default()
    };

    let mut expiry_price = calculate_expiry_price(&market.amm, oracle_price_data.price, 0).unwrap();

    let reserve_price = market.amm.reserve_price().unwrap();
    let (terminal_price, _, _) = calculate_terminal_price_and_reserves(&market.amm).unwrap();
    let oracle_price = oracle_price_data.price;

    assert_eq!(expiry_price, 25000000001);
    assert_eq!(terminal_price, 22100000000);
    assert_eq!(oracle_price, 22050000000);
    assert_eq!(reserve_price, 21051929600);

    expiry_price = calculate_expiry_price(
        &market.amm,
        oracle_price_data.price,
        111_111_110, // $111
    )
    .unwrap();

    // 250000000000814 - 249909629631346 = 90370369468 (~$9 improved)
    assert_eq!(expiry_price, 24990962964); // better price

    expiry_price = calculate_expiry_price(
        &market.amm,
        oracle_price_data.price,
        1_111_111_110, // $1,111
    )
    .unwrap();

    // 250000000000814 - 249096296297998 = 903703702816 (~$90 improved)
    assert_eq!(expiry_price, 24909629630); // even better price

    expiry_price = calculate_expiry_price(
        &market.amm,
        oracle_price_data.price,
        111111110 * QUOTE_PRECISION,
    )
    .unwrap();

    assert_eq!(expiry_price, 22050000001);
    assert_eq!(expiry_price, oracle_price + 1); // more shorts than longs, bias = +1
}

#[test]

fn calc_delayed_mark_twap_tests() {
    let prev = 1656682258;
    let now = prev + 60;
    let mut amm = AMM {
        base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        peg_multiplier: PRICE_PRECISION,
        base_spread: 655,  //base spread is .065%,
        max_spread: 65535, //base spread is 6.5%
        mark_std: PRICE_PRECISION as u64,
        last_bid_price_twap: 21999 * PRICE_PRECISION as u64,
        last_ask_price_twap: 22001 * PRICE_PRECISION as u64,
        last_mark_price_twap: 22000 * PRICE_PRECISION as u64,
        last_mark_price_twap_ts: prev - 3600,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price: 22850 * PRICE_PRECISION as i64,
            last_oracle_price_twap: 22900 * PRICE_PRECISION as i64,
            last_oracle_price_twap_ts: prev,
            ..HistoricalOracleData::default()
        },
        funding_period: 3600,
        ..AMM::default()
    };
    let px = 22850 * PRICE_PRECISION as i64;
    amm.peg_multiplier = px as u128;
    let trade_direction = PositionDirection::Long;
    update_mark_twap_from_estimates(&mut amm, now, Some(px as u64), Some(trade_direction), None)
        .unwrap();

    assert_eq!(amm.last_bid_price_twap, 22850013657);
    assert_eq!(amm.last_mark_price_twap, 22850013657);
    assert_eq!(amm.last_ask_price_twap, 22850013657);

    assert_eq!(
        amm.last_mark_price_twap as i64 - amm.historical_oracle_data.last_oracle_price_twap,
        -49986343
    );
}

#[test]
fn calc_mark_std_tests() {
    let prev = 1656682258;
    let mut now = prev + 60;
    let mut amm = AMM {
        base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        peg_multiplier: PRICE_PRECISION,
        base_spread: 65535, //max base spread is 6.5%
        mark_std: PRICE_PRECISION as u64,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price: PRICE_PRECISION as i64,
            ..HistoricalOracleData::default()
        },
        last_mark_price_twap_ts: prev,
        ..AMM::default()
    };
    update_amm_mark_std(&mut amm, now, PRICE_PRECISION_U64 * 23, 0).unwrap();
    assert_eq!(amm.mark_std, 23000000);

    amm.mark_std = PRICE_PRECISION_U64 as u64;
    amm.last_mark_price_twap_ts = now - 60;
    update_amm_mark_std(&mut amm, now, PRICE_PRECISION_U64 * 2, 0).unwrap();
    assert_eq!(amm.mark_std, 2000000);

    let mut px = PRICE_PRECISION_U64;
    let stop_time = now + 3600 * 2;
    while now <= stop_time {
        now += 1;
        if now % 15 == 0 {
            px = px * 1012 / 1000;
            amm.historical_oracle_data.last_oracle_price =
                amm.historical_oracle_data.last_oracle_price * 10119 / 10000;
        } else {
            px = px * 100000 / 100133;
            amm.historical_oracle_data.last_oracle_price =
                amm.historical_oracle_data.last_oracle_price * 100001 / 100133;
        }
        amm.peg_multiplier = px as u128;
        let trade_direction = PositionDirection::Long;
        update_mark_twap_from_estimates(&mut amm, now, Some(px), Some(trade_direction), None)
            .unwrap();
    }
    assert_eq!(now, 1656689519);
    assert_eq!(px, 39397);
    assert_eq!(amm.mark_std, 105);

    // sol price looking thinkg
    let mut px: u64 = 31_936_658;
    let stop_time = now + 3600 * 2;
    assert_eq!(amm.reserve_price().unwrap(), 39397);
    amm.peg_multiplier = 31_986_658;
    assert_eq!(amm.reserve_price().unwrap(), 31986658);
    amm.historical_oracle_data.last_oracle_price = 31986658;

    while now <= stop_time {
        now += 1;
        if now % 15 == 0 {
            px = 31_986_658; //31.98
            amm.historical_oracle_data.last_oracle_price = (px - 1000000) as i64;
            amm.peg_multiplier = px as u128;
            let amm_reserve_price = amm.reserve_price().unwrap();
            let (amm_bid_price, amm_ask_price) = amm.bid_ask_price(amm_reserve_price).unwrap();
            msg!("bid={:?} ask={:?}", amm_bid_price, amm_ask_price);

            assert!(amm_bid_price <= px);
            assert!(amm_ask_price >= px);

            let trade_direction = PositionDirection::Long;
            update_mark_twap_from_estimates(&mut amm, now, Some(px), Some(trade_direction), None)
                .unwrap();
        }
        if now % 189 == 0 {
            px = 31_883_651; //31.88
            amm.peg_multiplier = px as u128;
            amm.historical_oracle_data.last_oracle_price = (px + 1000000) as i64;

            let amm_reserve_price = amm.reserve_price().unwrap();
            let (amm_bid_price, amm_ask_price) = amm.bid_ask_price(amm_reserve_price).unwrap();
            msg!("bid={:?} ask={:?}", amm_bid_price, amm_ask_price);
            assert!(amm_bid_price <= px);
            assert!(amm_ask_price >= px);

            let trade_direction = PositionDirection::Short;
            update_mark_twap_from_estimates(&mut amm, now, Some(px), Some(trade_direction), None)
                .unwrap();
        }
    }
    assert_eq!(now, 1656696720);
    assert_eq!(px, 31986658);
    assert_eq!(amm.mark_std, 13244);

    // sol price looking thinkg
    let mut px: u64 = 31_936_658;
    let stop_time = now + 3600 * 2;
    while now <= stop_time {
        now += 1;
        if now % 2 == 1 {
            px = 31_986_658; //31.98
            amm.peg_multiplier = px as u128;

            amm.historical_oracle_data.last_oracle_price = (px - 1000000) as i64;
            let trade_direction = PositionDirection::Long;
            update_mark_twap_from_estimates(&mut amm, now, Some(px), Some(trade_direction), None)
                .unwrap();
        }
        if now % 2 == 0 {
            px = 31_883_651; //31.88
            amm.peg_multiplier = px as u128;

            amm.historical_oracle_data.last_oracle_price = (px + 1000000) as i64;
            let trade_direction = PositionDirection::Short;
            update_mark_twap_from_estimates(&mut amm, now, Some(px), Some(trade_direction), None)
                .unwrap();

            let mark_twap = amm.last_mark_price_twap;

            update_amm_oracle_std(&mut amm, now, px + 1000000, mark_twap).unwrap();
        }
    }
    assert_eq!(now, 1656703921);
    assert_eq!(px, 31986658);
    assert_eq!(amm.mark_std, 68672); //.068
    assert_eq!(amm.oracle_std, 965665); // used mark twap ema tho
}

#[test]
fn update_mark_twap_tests() {
    let prev = 0;

    let mut now = 1;

    let mut oracle_price_data = OraclePriceData {
        price: 40_021_280 * PRICE_PRECISION_I64 / 1_000_000,
        confidence: PRICE_PRECISION_U64 / 100,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    // $40 everything init
    let mut amm = AMM {
        quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        peg_multiplier: 40 * PEG_PRECISION,
        base_spread: 0,
        long_spread: 0,
        short_spread: 0,
        last_mark_price_twap: (40 * PRICE_PRECISION_U64),
        last_bid_price_twap: (40 * PRICE_PRECISION_U64),
        last_ask_price_twap: (40 * PRICE_PRECISION_U64),
        last_mark_price_twap_ts: prev,
        funding_period: 3600,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price: (40 * PRICE_PRECISION) as i64,
            last_oracle_price_twap: (40 * PRICE_PRECISION) as i64,
            last_oracle_price_twap_ts: prev,
            ..HistoricalOracleData::default()
        },
        ..AMM::default()
    };

    update_oracle_price_twap(&mut amm, now, &oracle_price_data, None, None).unwrap();
    assert_eq!(
        amm.historical_oracle_data.last_oracle_price,
        oracle_price_data.price
    );
    assert_eq!(
        amm.historical_oracle_data.last_oracle_price,
        40_021_280 * PRICE_PRECISION_I64 / 1_000_000
    );

    let trade_price = 40_051_280 * PRICE_PRECISION_U64 / 1_000_000;
    let trade_direction = PositionDirection::Long;

    let old_mark_twap = amm.last_mark_price_twap;
    let new_mark_twap = update_mark_twap_from_estimates(
        &mut amm,
        now,
        Some(trade_price),
        Some(trade_direction),
        None,
    )
    .unwrap();
    let new_bid_twap = amm.last_bid_price_twap;
    let new_ask_twap = amm.last_ask_price_twap;

    assert!(new_mark_twap > old_mark_twap);
    assert_eq!(new_ask_twap, 40000015);
    assert_eq!(new_bid_twap, 40000006);
    assert_eq!(new_mark_twap, 40000010);
    assert!(new_bid_twap < new_ask_twap);

    while now < 3600 {
        now += 1;
        update_oracle_price_twap(&mut amm, now, &oracle_price_data, None, None).unwrap();
        update_mark_twap_from_estimates(
            &mut amm,
            now,
            Some(trade_price),
            Some(trade_direction),
            None,
        )
        .unwrap();
    }

    let new_oracle_twap = amm.historical_oracle_data.last_oracle_price_twap;
    let new_mark_twap = amm.last_mark_price_twap;
    let new_bid_twap = amm.last_bid_price_twap;
    let new_ask_twap = amm.last_ask_price_twap;

    assert!(new_bid_twap < new_ask_twap);
    assert_eq!((new_bid_twap + new_ask_twap) / 2, new_mark_twap);
    assert!((new_oracle_twap as u64) < new_mark_twap); // funding in favor of maker?
    assert_eq!(new_oracle_twap, 40008161);
    assert_eq!(new_bid_twap, 40014548);
    assert_eq!(new_mark_twap, 40024054); // ~ 2 cents above oracle twap
    assert_eq!(new_ask_twap, 40033561);
    assert_eq!(amm.mark_std, 27229);
    assert_eq!(amm.oracle_std, 3119);

    let trade_price_2 = 39_971_280 * PRICE_PRECISION_U64 / 1_000_000;
    let trade_direction_2 = PositionDirection::Short;
    oracle_price_data = OraclePriceData {
        price: 39_991_280 * PRICE_PRECISION_I64 / 1_000_000,
        confidence: PRICE_PRECISION_U64 / 80,
        delay: 14,
        has_sufficient_number_of_data_points: true,
    };

    while now <= 3600 * 2 {
        now += 1;
        update_oracle_price_twap(&mut amm, now, &oracle_price_data, None, None).unwrap();
        if now % 200 == 0 {
            update_mark_twap_from_estimates(
                &mut amm,
                now,
                Some(trade_price_2),
                Some(trade_direction_2),
                None,
            )
            .unwrap();
            // ~2 cents below oracle
        }
    }

    let new_oracle_twap = amm.historical_oracle_data.last_oracle_price_twap;
    let new_mark_twap = amm.last_mark_price_twap;
    let new_bid_twap = amm.last_bid_price_twap;
    let new_ask_twap = amm.last_ask_price_twap;

    assert_eq!(new_bid_twap, 39_989_389);
    assert_eq!(new_ask_twap, 40_000_790);
    assert!(new_bid_twap < new_ask_twap);
    assert_eq!((new_bid_twap + new_ask_twap) / 2, new_mark_twap);

    assert_eq!(new_oracle_twap, 39_998_518);
    assert_eq!(new_mark_twap, 39995089);

    assert!((new_oracle_twap as u64) >= new_mark_twap); // funding in favor of maker
    assert_eq!(amm.mark_std, 24467);
    assert_eq!(amm.oracle_std, 7238);
}

#[test]
fn calc_oracle_twap_tests() {
    let prev = 1656682258;
    let now = prev + 3600;

    let px = 32 * PRICE_PRECISION;

    let mut amm = AMM {
        base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        peg_multiplier: PEG_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap: px as i64,
            last_oracle_price_twap_ts: prev,
            ..HistoricalOracleData::default()
        },
        mark_std: PRICE_PRECISION as u64,
        last_mark_price_twap_ts: prev,
        funding_period: 3600_i64,
        ..AMM::default()
    };
    let mut oracle_price_data = OraclePriceData {
        price: (34 * PRICE_PRECISION) as i64,
        confidence: PRICE_PRECISION_U64 / 100,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    let _new_oracle_twap =
        update_oracle_price_twap(&mut amm, now, &oracle_price_data, None, None).unwrap();
    assert_eq!(
        amm.historical_oracle_data.last_oracle_price_twap,
        (34 * PRICE_PRECISION - PRICE_PRECISION / 100) as i64
    );

    // let after_ts = amm.historical_oracle_data.last_oracle_price_twap_ts;
    amm.last_mark_price_twap_ts = now - 60;
    amm.historical_oracle_data.last_oracle_price_twap_ts = now - 60;
    // let after_ts_2 = amm.historical_oracle_data.last_oracle_price_twap_ts;
    oracle_price_data = OraclePriceData {
        price: (31 * PRICE_PRECISION) as i64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
    };
    // let old_oracle_twap_2 = amm.historical_oracle_data.last_oracle_price_twap;
    let _new_oracle_twap_2 =
        update_oracle_price_twap(&mut amm, now, &oracle_price_data, None, None).unwrap();
    assert_eq!(amm.historical_oracle_data.last_oracle_price_twap, 33940167);
    assert_eq!(
        amm.historical_oracle_data.last_oracle_price_twap_5min,
        33392001
    );
    assert_eq!(amm.oracle_std, 2_940_167);

    let _new_oracle_twap_2 =
        update_oracle_price_twap(&mut amm, now + 60 * 5, &oracle_price_data, None, None).unwrap();

    assert_eq!(amm.historical_oracle_data.last_oracle_price_twap, 33695154);
    assert_eq!(
        amm.historical_oracle_data.last_oracle_price_twap_5min,
        31 * PRICE_PRECISION_I64
    );
    assert_eq!(amm.oracle_std, 2_695_154);

    oracle_price_data = OraclePriceData {
        price: (32 * PRICE_PRECISION) as i64,
        confidence: 0,
        delay: 2,
        has_sufficient_number_of_data_points: true,
    };

    let _new_oracle_twap_2 =
        update_oracle_price_twap(&mut amm, now + 60 * 5 + 60, &oracle_price_data, None, None)
            .unwrap();
    assert_eq!(
        amm.historical_oracle_data.last_oracle_price_twap_5min,
        31200001
    );
    assert_eq!(amm.oracle_std, 1_666_902); // ~$1.6 of std
}

#[test]
fn calc_oracle_twap_clamp_update_tests() {
    let prev = 1667387000;
    let mut now = prev + 1;

    // let oracle_price_data = OraclePriceData {
    //     price: 13_021_280 * PRICE_PRECISION_I64 / 1_000_000,
    //     confidence: PRICE_PRECISION_U64 / 100,
    //     delay: 1,
    //     has_sufficient_number_of_data_points: true,
    // };

    // $13 everything init
    let mut amm = AMM {
        quote_asset_reserve: 200 * AMM_RESERVE_PRECISION,
        base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
        peg_multiplier: 13 * PEG_PRECISION,
        base_spread: 0,
        long_spread: 0,
        short_spread: 0,
        last_mark_price_twap: (13 * PRICE_PRECISION_U64),
        last_bid_price_twap: (13 * PRICE_PRECISION_U64),
        last_ask_price_twap: (13 * PRICE_PRECISION_U64),
        last_mark_price_twap_ts: prev,
        funding_period: 3600,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price: (13 * PRICE_PRECISION) as i64,
            last_oracle_price_twap: (13 * PRICE_PRECISION) as i64,
            last_oracle_price_twap_5min: (13 * PRICE_PRECISION) as i64,
            last_oracle_price_twap_ts: prev,
            ..HistoricalOracleData::default()
        },
        ..AMM::default()
    };

    // price jumps 10x
    let oracle_price_data = OraclePriceData {
        price: 130 * PRICE_PRECISION_I64 + 873,
        confidence: PRICE_PRECISION_U64 / 10,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    while now < prev + 3600 {
        update_oracle_price_twap(&mut amm, now, &oracle_price_data, None, None).unwrap();
        now += 1;
    }
    assert_eq!(
        amm.historical_oracle_data.last_oracle_price_twap,
        18_143_130
    );
    assert_eq!(
        amm.historical_oracle_data.last_oracle_price_twap_5min,
        23_536_961
    );
    assert_eq!(amm.last_oracle_normalised_price, 24_188_600);

    while now < prev + 3600 * 2 {
        update_oracle_price_twap(&mut amm, now, &oracle_price_data, None, None).unwrap();
        now += 1;
    }

    assert_eq!(
        amm.historical_oracle_data.last_oracle_price_twap,
        25_322_529
    );
    assert_eq!(
        amm.historical_oracle_data.last_oracle_price_twap_5min,
        32_850_803
    );
    assert_eq!(amm.last_oracle_normalised_price, 33_760_245);

    while now < prev + 3600 * 10 {
        update_oracle_price_twap(&mut amm, now, &oracle_price_data, None, None).unwrap();
        now += 1;
    }

    assert_eq!(
        amm.historical_oracle_data.last_oracle_price_twap,
        129_282_724
    );
    assert_eq!(
        amm.historical_oracle_data.last_oracle_price_twap_5min,
        129_900_874
    );
    assert_eq!(amm.last_oracle_normalised_price, 129_900_873);
}

#[test]
fn test_last_oracle_conf_update() {
    let prev = 1667387000;
    let now = prev + 1;

    let mut amm = AMM {
        quote_asset_reserve: 200 * AMM_RESERVE_PRECISION,
        base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
        peg_multiplier: 13 * PEG_PRECISION,
        base_spread: 0,
        long_spread: 0,
        short_spread: 0,
        last_mark_price_twap: (13 * PRICE_PRECISION_U64),
        last_bid_price_twap: (13 * PRICE_PRECISION_U64),
        last_ask_price_twap: (13 * PRICE_PRECISION_U64),
        last_mark_price_twap_ts: prev,
        funding_period: 3600,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price: (13 * PRICE_PRECISION) as i64,
            last_oracle_price_twap: (13 * PRICE_PRECISION) as i64,
            last_oracle_price_twap_5min: (13 * PRICE_PRECISION) as i64,
            last_oracle_price_twap_ts: prev,
            ..HistoricalOracleData::default()
        },
        ..AMM::default()
    };

    // price jumps 10x
    let oracle_price_data = OraclePriceData {
        price: 130 * PRICE_PRECISION_I64 + 873,
        confidence: PRICE_PRECISION_U64 / 10,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    update_oracle_price_twap(&mut amm, now, &oracle_price_data, None, None).unwrap();

    assert_eq!(amm.last_oracle_conf_pct, 7692);

    // price jumps 10x
    let oracle_price_data = OraclePriceData {
        price: 130 * PRICE_PRECISION_I64 + 873,
        confidence: 1,
        delay: 5,
        has_sufficient_number_of_data_points: true,
    };

    // unchanged if now hasnt changed
    update_oracle_price_twap(&mut amm, now, &oracle_price_data, None, None).unwrap();
    assert_eq!(amm.last_oracle_conf_pct, 7692);

    update_oracle_price_twap(&mut amm, now + 1, &oracle_price_data, None, None).unwrap();

    assert_eq!(amm.last_oracle_conf_pct, 7692 - 7692 / 20); // 7287

    // longer time between update means delay is faster
    update_oracle_price_twap(&mut amm, now + 60, &oracle_price_data, None, None).unwrap();

    assert_eq!(amm.last_oracle_conf_pct, 7307 - 7307 / 5 + 1); //5847
}
