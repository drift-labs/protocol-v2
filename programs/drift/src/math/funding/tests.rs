use crate::controller::funding::update_funding_rate;
use crate::controller::repeg::_update_amm;
use crate::math::helpers::on_the_hour_update;
use crate::math::oracle::block_operation;

use crate::math::constants::{
    AMM_RESERVE_PRECISION, ONE_HOUR_I128, PRICE_PRECISION, PRICE_PRECISION_U64, QUOTE_PRECISION,
};
use crate::math::funding::*;
use std::cmp::min;

use crate::test_utils::get_pyth_price;

// use crate::create_anchor_account_info;
use crate::state::oracle::HistoricalOracleData;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{ContractTier, PerpMarket, AMM};
use crate::state::state::{OracleGuardRails, State, ValidityGuardRails};
use solana_program::pubkey::Pubkey;
use std::str::FromStr;

fn calculate_funding_rate(
    mid_price_twap: u128,
    oracle_price_twap: i128,
    funding_period: i64,
) -> DriftResult<i128> {
    // funding period = 1 hour, window = 1 day
    // low periodicity => quickly updating/settled funding rates
    //                 => lower funding rate payment per interval
    let period_adjustment = (24_i128)
        .safe_mul(ONE_HOUR_I128)?
        .safe_div(funding_period as i128)?;

    let price_spread = mid_price_twap.cast::<i128>()?.safe_sub(oracle_price_twap)?;

    // clamp price divergence to 3% for funding rate calculation
    let max_price_spread = oracle_price_twap.safe_div(33)?; // 3%
    let clamped_price_spread = max(-max_price_spread, min(price_spread, max_price_spread));

    let funding_rate = clamped_price_spread
        .safe_mul(FUNDING_RATE_BUFFER.cast()?)?
        .safe_div(period_adjustment.cast()?)?;

    Ok(funding_rate)
}

use crate::create_account_info;
use crate::test_utils::create_account_info;
#[cfg(test)]
use crate::test_utils::get_account_bytes;

#[test]
fn balanced_funding_test() {
    // balanced market no fees collected

    let sqrt_k0 = 100 * AMM_RESERVE_PRECISION + 8793888383;
    let px0 = 32_513_929;
    let mut count = 0;

    while count < 2 {
        let px = px0 + count;
        let sqrt_k = sqrt_k0 + count;

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: sqrt_k as u128,
                quote_asset_reserve: sqrt_k as u128,
                sqrt_k: sqrt_k as u128,
                peg_multiplier: px,
                base_asset_amount_with_amm: 0,
                base_asset_amount_long: 12295081967,
                base_asset_amount_short: -12295081967,
                total_exchange_fee: (count * 1000000783) / 2888,
                total_fee_minus_distributions: (count * 1000000783) as i128,
                last_mark_price_twap: (px * 999 / 1000) as u64,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: (px * 1001 / 1000) as i64,
                    ..HistoricalOracleData::default()
                },
                funding_period: 3600,

                ..AMM::default()
            },
            ..PerpMarket::default()
        };
        let balanced_funding = calculate_funding_rate(
            market.amm.last_mark_price_twap as u128,
            market.amm.historical_oracle_data.last_oracle_price_twap as i128,
            market.amm.funding_period,
        )
        .unwrap();

        assert_eq!(
            market.amm.last_mark_price_twap
                < (market.amm.historical_oracle_data.last_oracle_price_twap as u64),
            true
        );

        let (long_funding, short_funding, _) =
            calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

        assert_eq!(balanced_funding, -2709458);
        assert_eq!(long_funding, -2709458);
        assert_eq!(short_funding, -2709458);
        count += 1;
    }

    let sqrt_k0 = 55 * AMM_RESERVE_PRECISION + 48383;
    let px0 = 19_902_513_929;
    let mut count = 0;

    while count < 2 {
        let px = px0 + count;
        let sqrt_k = sqrt_k0 + count;

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: sqrt_k as u128,
                quote_asset_reserve: sqrt_k as u128,
                sqrt_k: sqrt_k as u128,
                peg_multiplier: px,
                base_asset_amount_with_amm: 0,
                base_asset_amount_long: 7845926098328,
                base_asset_amount_short: -7845926098328,
                total_exchange_fee: (count * 1000000783) / 2888,
                total_fee_minus_distributions: (count * 1000000783) as i128,
                last_mark_price_twap: (px * 999 / 1000) as u64,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: (px * 888 / 1000) as i64,
                    ..HistoricalOracleData::default()
                },
                funding_period: 3600,

                ..AMM::default()
            },
            ..PerpMarket::default()
        };
        let balanced_funding = calculate_funding_rate(
            market.amm.last_mark_price_twap as u128,
            market.amm.historical_oracle_data.last_oracle_price_twap as i128,
            market.amm.funding_period,
        )
        .unwrap();

        //sanity, funding CANT be larger than oracle twap price
        assert_eq!(balanced_funding < (px * FUNDING_RATE_BUFFER) as i128, true);
        assert_eq!(
            balanced_funding
                < ((market.amm.historical_oracle_data.last_oracle_price_twap as u128)
                    * FUNDING_RATE_BUFFER) as i128,
            true
        );

        assert_eq!(
            market.amm.last_mark_price_twap
                > (market.amm.historical_oracle_data.last_oracle_price_twap as u64),
            true
        );

        let (long_funding, short_funding, _) =
            calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

        assert_eq!(balanced_funding, 22_314_939_833); // 2_231_493 in PRICE_PRECISION
        assert_eq!(long_funding, 22_314_939_833);
        assert_eq!(short_funding, 22_314_939_833);
        count += 1;
    }
}

#[test]
fn capped_sym_funding_test() {
    // more shorts than longs, positive funding, 1/3 of fee pool too small
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: -12295081967,
            base_asset_amount_long: 12295081967,
            base_asset_amount_short: -12295081967 * 2,
            total_exchange_fee: QUOTE_PRECISION / 2,
            total_fee_minus_distributions: (QUOTE_PRECISION as i128) / 2,

            last_mark_price_twap: 50 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (49 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            funding_period: 3600,

            ..AMM::default()
        },
        ..PerpMarket::default()
    };

    let balanced_funding = calculate_funding_rate(
        market.amm.last_mark_price_twap as u128,
        market.amm.historical_oracle_data.last_oracle_price_twap as i128,
        market.amm.funding_period,
    )
    .unwrap();

    assert_eq!(balanced_funding, 41666666);

    let (long_funding, short_funding, _) =
        calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

    assert_eq!(long_funding, balanced_funding);
    assert!(long_funding > short_funding);
    assert_eq!(short_funding, 24222164);

    // only spend 1/3 of fee pool, ((.5-.416667)) * 3 < .25
    assert_eq!(market.amm.total_fee_minus_distributions, 416667);

    // more longs than shorts, positive funding, amm earns funding
    market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: 12295081967,
            base_asset_amount_long: 12295081967 * 2,
            base_asset_amount_short: -12295081967,
            total_exchange_fee: QUOTE_PRECISION / 2,
            total_fee_minus_distributions: (QUOTE_PRECISION as i128) / 2,
            last_mark_price_twap: 50 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (49 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            funding_period: 3600,

            ..AMM::default()
        },
        ..PerpMarket::default()
    };

    assert_eq!(balanced_funding, 41666666);

    let (long_funding, short_funding, _) =
        calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

    assert_eq!(long_funding, balanced_funding);
    assert_eq!(long_funding, short_funding);
    let new_fees = market.amm.total_fee_minus_distributions;
    assert!(new_fees > QUOTE_PRECISION as i128 / 2);
    assert_eq!(new_fees, 1012295); // made over $.50
}

#[test]
fn funding_unsettled_lps_amm_win_test() {
    // more shorts than longs, positive funding

    // positive base_asset_amount_with_unsettled_lp =
    // 1) lots of long users who have lp as counterparty
    // 2) the lps should be short but its unsettled...
    // 3) amm takes on the funding revenu/cost of those short LPs

    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: -12295081967, //~12
            base_asset_amount_long: 12295081967,
            base_asset_amount_short: -12295081967 * 2,
            base_asset_amount_with_unsettled_lp: (AMM_RESERVE_PRECISION * 500) as i128, //wowsers
            total_exchange_fee: QUOTE_PRECISION / 2,
            total_fee_minus_distributions: (QUOTE_PRECISION as i128) / 2,

            last_mark_price_twap: 50 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (49 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            funding_period: 3600,

            ..AMM::default()
        },
        ..PerpMarket::default()
    };

    let balanced_funding = calculate_funding_rate(
        market.amm.last_mark_price_twap as u128,
        market.amm.historical_oracle_data.last_oracle_price_twap as i128,
        market.amm.funding_period,
    )
    .unwrap();

    assert_eq!(balanced_funding, 41666666);
    assert_eq!(market.amm.total_fee_minus_distributions, 500000);

    let (long_funding, short_funding, _) =
        calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

    let settled_net_market_position = market
        .amm
        .base_asset_amount_with_amm
        .checked_add(market.amm.base_asset_amount_with_unsettled_lp)
        .unwrap();

    let net_market_position_funding_payment =
        calculate_funding_payment_in_quote_precision(balanced_funding, settled_net_market_position)
            .unwrap();
    let uncapped_funding_pnl = -net_market_position_funding_payment;

    assert_eq!(market.amm.base_asset_amount_with_amm, -12295081967);
    assert_eq!(market.amm.base_asset_amount_with_unsettled_lp, 500000000000);
    assert_eq!(settled_net_market_position, 487704918033);
    assert_eq!(net_market_position_funding_payment, -20321037);
    assert_eq!(uncapped_funding_pnl, 20321037); //protocol revenue

    assert_eq!(long_funding, balanced_funding);
    assert_eq!(short_funding, balanced_funding);

    assert!(long_funding == short_funding);

    // making money off unsettled lps
    assert_eq!(market.amm.total_fee_minus_distributions, 20821037);

    // more longs than shorts, positive funding, amm earns funding
    market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: 12295081967,
            base_asset_amount_long: 12295081967 * 2,
            base_asset_amount_short: -12295081967,
            base_asset_amount_with_unsettled_lp: (AMM_RESERVE_PRECISION * 500) as i128, //wowsers
            total_exchange_fee: QUOTE_PRECISION / 2,
            total_fee_minus_distributions: (QUOTE_PRECISION as i128) / 2,
            last_mark_price_twap: 50 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (49 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            funding_period: 3600,

            ..AMM::default()
        },
        ..PerpMarket::default()
    };

    let balanced_funding = calculate_funding_rate(
        market.amm.last_mark_price_twap as u128,
        market.amm.historical_oracle_data.last_oracle_price_twap as i128,
        market.amm.funding_period,
    )
    .unwrap();
    assert_eq!(balanced_funding, 41666666);

    let (long_funding, short_funding, drift_pnl) =
        calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

    assert_eq!(drift_pnl, 21345628);
    assert_eq!(long_funding, balanced_funding);
    assert_eq!(long_funding, short_funding);
    let new_fees = market.amm.total_fee_minus_distributions;
    assert!(new_fees > QUOTE_PRECISION as i128 / 2);
    assert_eq!(new_fees, 21845628); // made more
}

#[test]
fn funding_unsettled_lps_amm_lose_test() {
    // more shorts than longs, positive funding

    // positive base_asset_amount_with_unsettled_lp =
    // 1) lots of long users who have lp as counterparty
    // 2) the lps should be short but its unsettled...
    // 3) amm takes on the funding revenu/cost of those short LPs

    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: -12295081967, //~12
            base_asset_amount_long: 12295081967,
            base_asset_amount_short: -12295081967 * 2,
            base_asset_amount_with_unsettled_lp: -((AMM_RESERVE_PRECISION * 500) as i128), //wowsers
            total_exchange_fee: QUOTE_PRECISION / 2,
            total_fee_minus_distributions: ((QUOTE_PRECISION * 99999) as i128),

            last_mark_price_twap: 50 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (49 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            funding_period: 3600,

            ..AMM::default()
        },
        ..PerpMarket::default()
    };

    let balanced_funding = calculate_funding_rate(
        market.amm.last_mark_price_twap as u128,
        market.amm.historical_oracle_data.last_oracle_price_twap as i128,
        market.amm.funding_period,
    )
    .unwrap();

    assert_eq!(balanced_funding, 41666666);
    assert_eq!(market.amm.total_fee_minus_distributions, 99999000000);

    let (long_funding, short_funding, _) =
        calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

    let settled_net_market_position = market
        .amm
        .base_asset_amount_with_amm
        .checked_add(market.amm.base_asset_amount_with_unsettled_lp)
        .unwrap();

    let net_market_position_funding_payment =
        calculate_funding_payment_in_quote_precision(balanced_funding, settled_net_market_position)
            .unwrap();
    let uncapped_funding_pnl = -net_market_position_funding_payment;

    assert_eq!(market.amm.base_asset_amount_with_amm, -12295081967);
    assert_eq!(
        market.amm.base_asset_amount_with_unsettled_lp,
        -500000000000
    );
    assert_eq!(settled_net_market_position, -512295081967);
    assert_eq!(net_market_position_funding_payment, 21345628);
    assert_eq!(uncapped_funding_pnl, -21345628); //protocol loses $21

    assert_eq!(long_funding, balanced_funding);
    assert_eq!(short_funding, balanced_funding);

    assert!(long_funding == short_funding);

    // making money off unsettled lps
    assert_eq!(market.amm.total_fee_minus_distributions, 99977654372);

    // more longs than shorts, positive funding, amm earns funding
    market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: 12295081967,
            base_asset_amount_long: 12295081967 * 2,
            base_asset_amount_short: -12295081967,
            base_asset_amount_with_unsettled_lp: -((AMM_RESERVE_PRECISION * 500) as i128), //wowsers
            total_exchange_fee: QUOTE_PRECISION / 2,
            total_fee_minus_distributions: (QUOTE_PRECISION as i128) / 2,
            last_mark_price_twap: 50 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (49 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            funding_period: 3600,

            ..AMM::default()
        },
        ..PerpMarket::default()
    };

    let balanced_funding = calculate_funding_rate(
        market.amm.last_mark_price_twap as u128,
        market.amm.historical_oracle_data.last_oracle_price_twap as i128,
        market.amm.funding_period,
    )
    .unwrap();
    assert_eq!(balanced_funding, 41666666);

    let (long_funding, short_funding, drift_pnl) =
        calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

    assert_eq!(drift_pnl, -20321037);
    assert_eq!(long_funding, balanced_funding);
    assert_eq!(short_funding, 90110989);
    assert_eq!(long_funding < short_funding, true);

    let new_fees = market.amm.total_fee_minus_distributions;
    assert_eq!(new_fees, 416667); // lost
}

#[test]
fn max_funding_rates() {
    let now = 0_i64;
    let slot = 0_u64;

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };

    let mut oracle_price = get_pyth_price(51, 6);
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();
    let mut market = PerpMarket {
        market_index: 0,
        amm: AMM {
            oracle: oracle_price_key,

            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: -12295081967, //~12
            base_asset_amount_long: 12295081967,
            base_asset_amount_short: -12295081967 * 2,
            base_asset_amount_with_unsettled_lp: -((AMM_RESERVE_PRECISION * 500) as i128), //wowsers
            total_exchange_fee: QUOTE_PRECISION / 2,
            total_fee_minus_distributions: ((QUOTE_PRECISION * 99999) as i128),

            last_mark_price_twap: 50 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (49 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            funding_period: 3600,

            ..AMM::default()
        },
        ..PerpMarket::default()
    };

    let res1 = market
        .get_max_price_divergence_for_funding_rate(
            market.amm.historical_oracle_data.last_oracle_price_twap,
        )
        .unwrap();
    assert_eq!(res1, 4900000);
    market.contract_tier = ContractTier::B;
    let res1 = market
        .get_max_price_divergence_for_funding_rate(
            market.amm.historical_oracle_data.last_oracle_price_twap,
        )
        .unwrap();
    assert_eq!(res1, 1484848);

    let did_succeed = update_funding_rate(
        0,
        &mut market,
        &mut oracle_map,
        now,
        slot,
        &state.oracle_guard_rails,
        false,
        None,
    )
    .unwrap();

    assert!(!did_succeed);
}

#[test]
fn unsettled_funding_pnl() {
    let mut now = 0_i64;
    let mut slot = 0_u64;

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };

    let mut oracle_price = get_pyth_price(51, 6);
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();
    let mut market = PerpMarket {
        market_index: 0,
        amm: AMM {
            oracle: oracle_price_key,

            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: -12295081967, //~12
            base_asset_amount_long: 12295081967,
            base_asset_amount_short: -12295081967 * 2,
            base_asset_amount_with_unsettled_lp: -((AMM_RESERVE_PRECISION * 500) as i128), //wowsers
            total_exchange_fee: QUOTE_PRECISION / 2,
            total_fee_minus_distributions: ((QUOTE_PRECISION * 99999) as i128),

            last_mark_price_twap: 50 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (49 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            funding_period: 3600,

            ..AMM::default()
        },
        ..PerpMarket::default()
    };
    assert_eq!(market.amm.reserve_price().unwrap(), 47628800);
    assert_eq!(market.amm.net_unsettled_funding_pnl, 0);

    let time_until_next_update = on_the_hour_update(
        now,
        market.amm.last_funding_rate_ts,
        market.amm.funding_period,
    )
    .unwrap();

    assert_eq!(time_until_next_update, 3600);
    let time_until_next_update = on_the_hour_update(
        now + 3600,
        market.amm.last_funding_rate_ts,
        market.amm.funding_period,
    )
    .unwrap();
    let oracle_price_data = oracle_map.get_price_data(&market.amm.oracle).unwrap();

    assert_eq!(time_until_next_update, 0);
    let block_funding_rate_update = block_operation(
        &market,
        oracle_price_data,
        &state.oracle_guard_rails,
        None,
        slot,
    )
    .unwrap();
    assert_eq!(block_funding_rate_update, true);
    assert_eq!(market.amm.last_update_slot, slot);

    now += 3600;
    slot += 3600 * 2;

    let cost = _update_amm(&mut market, oracle_price_data, &state, now, slot).unwrap();
    assert_eq!(cost, 0);
    assert_eq!(market.amm.last_update_slot, slot);
    assert_eq!(market.amm.last_mark_price_twap, 50000000);
    assert_eq!(
        market.amm.historical_oracle_data.last_oracle_price_twap,
        51000000
    );
    // oracle twap > mark, expect negative funding

    let block_funding_rate_update = block_operation(
        &market,
        oracle_price_data,
        &state.oracle_guard_rails,
        None,
        slot,
    )
    .unwrap();
    assert_eq!(block_funding_rate_update, false);
    assert_eq!(market.amm.total_fee_minus_distributions, 99999000000);

    let did_succeed = update_funding_rate(
        0,
        &mut market,
        &mut oracle_map,
        now,
        slot,
        &state.oracle_guard_rails,
        false,
        None,
    )
    .unwrap();
    assert!(did_succeed);
    assert_eq!(market.amm.last_mark_price_twap, 47629736);
    assert!(market.amm.last_mark_price_twap > market.amm.reserve_price().unwrap());

    assert_eq!(
        market.amm.historical_oracle_data.last_oracle_price_twap,
        51000000
    );

    assert_eq!(market.amm.cumulative_funding_rate_long, -140002666); // negative funding
    assert_eq!(market.amm.cumulative_funding_rate_short, -140002666);
    assert_eq!(market.amm.last_funding_rate, -140002666);
    assert_eq!(market.amm.last_24h_avg_funding_rate, -140002666 / 24 + 1);
    assert_eq!(market.amm.last_funding_rate_ts, now);
    assert_eq!(market.amm.net_revenue_since_last_funding, 0); // back to 0
    assert_eq!(market.amm.total_fee_minus_distributions, 100070722677); //71.722677 gain
    assert_eq!(market.amm.total_fee, 0);

    assert_ne!(market.amm.net_unsettled_funding_pnl, 0); // important: imbalanced market adds funding rev
    assert_eq!(market.amm.net_unsettled_funding_pnl, -71722677); // users up
}
