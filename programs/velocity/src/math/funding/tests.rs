use crate::controller::funding::update_funding_rate;
use crate::math::helpers::on_the_hour_update;
use crate::math::oracle::{block_operation, OracleValidity};
use crate::state::perp_market::MarketStats;
use crate::vlp::amm::refresh::_update_amm;

use crate::math::constants::{
    AMM_RESERVE_PRECISION, ONE_HOUR_I128, PRICE_PRECISION, PRICE_PRECISION_U64, QUOTE_PRECISION,
};
use crate::math::funding::*;
use std::cmp::min;

use crate::test_utils::get_pyth_price;

// use crate::create_anchor_account_info;
use crate::state::oracle::{HistoricalOracleData, MMOraclePriceData};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{ContractTier, FeeLedger, PerpMarket, AMM};
use crate::state::state::{OracleGuardRails, State, ValidityGuardRails};
use solana_program::pubkey::Pubkey;
use std::str::FromStr;

fn calculate_funding_rate(
    mid_price_twap: u128,
    oracle_price_twap: i128,
    funding_period: i64,
) -> VelocityResult<i128> {
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

use crate::create_anchor_account_info;
use crate::state::pyth_lazer_oracle::PythLazerOracle;

#[test]
fn balanced_funding_test() {
    // balanced market no fees collected

    let sqrt_k0 = 100 * AMM_RESERVE_PRECISION + 8793888383;
    let px0 = 32_513_929;
    let mut count = 0;

    while count < 2 {
        let px = px0 + count;
        let sqrt_k = sqrt_k0 + count;

        let market = PerpMarket {
            amm: AMM {
                base_asset_reserve: sqrt_k,
                quote_asset_reserve: sqrt_k,
                sqrt_k,
                peg_multiplier: px,
                base_asset_amount_with_amm: 0,
                total_fee_minus_distributions: (count * 1000000783) as i128,

                ..AMM::default()
            },
            base_asset_amount_long: 12295081967,
            base_asset_amount_short: -12295081967,
            fee_ledger: FeeLedger {
                total_exchange_fee: (count * 1000000783) / 2888,
                ..FeeLedger::default()
            },
            market_stats: MarketStats {
                funding_period: 3600,
                last_mark_price_twap: (px * 999 / 1000) as u64,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: (px * 1001 / 1000) as i64,
                    ..HistoricalOracleData::default()
                },
                ..MarketStats::default()
            },
            ..PerpMarket::default()
        };
        let balanced_funding = calculate_funding_rate(
            market.market_stats.last_mark_price_twap as u128,
            market
                .market_stats
                .historical_oracle_data
                .last_oracle_price_twap as i128,
            market.market_stats.funding_period,
        )
        .unwrap();

        assert_eq!(
            market.market_stats.last_mark_price_twap
                < (market
                    .market_stats
                    .historical_oracle_data
                    .last_oracle_price_twap as u64),
            true
        );

        let (long_funding, short_funding, _) = calculate_funding_rate_long_short(
            &crate::math::funding::FundingMarketInputs::from_market(&market),
            balanced_funding,
        )
        .unwrap();

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

        let market = PerpMarket {
            amm: AMM {
                base_asset_reserve: sqrt_k,
                quote_asset_reserve: sqrt_k,
                sqrt_k,
                peg_multiplier: px,
                base_asset_amount_with_amm: 0,
                total_fee_minus_distributions: (count * 1000000783) as i128,

                ..AMM::default()
            },
            base_asset_amount_long: 7845926098328,
            base_asset_amount_short: -7845926098328,
            fee_ledger: FeeLedger {
                total_exchange_fee: (count * 1000000783) / 2888,
                ..FeeLedger::default()
            },
            market_stats: MarketStats {
                funding_period: 3600,
                last_mark_price_twap: (px * 999 / 1000) as u64,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: (px * 888 / 1000) as i64,
                    ..HistoricalOracleData::default()
                },
                ..MarketStats::default()
            },
            ..PerpMarket::default()
        };
        let balanced_funding = calculate_funding_rate(
            market.market_stats.last_mark_price_twap as u128,
            market
                .market_stats
                .historical_oracle_data
                .last_oracle_price_twap as i128,
            market.market_stats.funding_period,
        )
        .unwrap();

        //sanity, funding CANT be larger than oracle twap price
        assert_eq!(balanced_funding < (px * FUNDING_RATE_BUFFER) as i128, true);
        assert_eq!(
            balanced_funding
                < ((market
                    .market_stats
                    .historical_oracle_data
                    .last_oracle_price_twap as u128)
                    * FUNDING_RATE_BUFFER) as i128,
            true
        );

        assert_eq!(
            market.market_stats.last_mark_price_twap
                > (market
                    .market_stats
                    .historical_oracle_data
                    .last_oracle_price_twap as u64),
            true
        );

        let (long_funding, short_funding, _) = calculate_funding_rate_long_short(
            &crate::math::funding::FundingMarketInputs::from_market(&market),
            balanced_funding,
        )
        .unwrap();

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
            total_fee_minus_distributions: (QUOTE_PRECISION as i128) / 2,

            ..AMM::default()
        },
        base_asset_amount_long: 12295081967,
        base_asset_amount_short: -12295081967 * 2,
        // pendings no longer floor the funding budget: tfmd contains only
        // the AMM's own equity post-isolation, spendable down to zero
        // (capped at 1/3 per period)
        fee_ledger: FeeLedger {
            total_exchange_fee: QUOTE_PRECISION / 2,
            pending_protocol_fee: QUOTE_PRECISION / 4,
            ..FeeLedger::default()
        },
        market_stats: MarketStats {
            funding_period: 3600,
            last_mark_price_twap: 50 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (49 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            ..MarketStats::default()
        },
        ..PerpMarket::default()
    };

    let balanced_funding = calculate_funding_rate(
        market.market_stats.last_mark_price_twap as u128,
        market
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap as i128,
        market.market_stats.funding_period,
    )
    .unwrap();

    assert_eq!(balanced_funding, 41666666);

    let (long_funding, short_funding, capped_pnl) = calculate_funding_rate_long_short(
        &crate::math::funding::FundingMarketInputs::from_market(&market),
        balanced_funding,
    )
    .unwrap();

    // `calculate_funding_rate_long_short` is pure now; the caller records
    // the AMM's PnL explicitly so this test does so too.
    use crate::vlp::amm::quoter::AmmContract;
    market.amm.record_amm_pnl(capped_pnl).unwrap();

    assert_eq!(long_funding, balanced_funding);
    assert!(long_funding > short_funding);
    assert_eq!(short_funding, 27611040);

    // only spend 1/3 of the (full, unfloored) 0.5-QUOTE fee pool
    assert_eq!(market.amm.total_fee_minus_distributions, 333334);

    // more longs than shorts, positive funding, amm earns funding
    market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: 12295081967,
            total_fee_minus_distributions: (QUOTE_PRECISION as i128) / 2,

            ..AMM::default()
        },
        base_asset_amount_long: 12295081967 * 2,
        base_asset_amount_short: -12295081967,
        fee_ledger: FeeLedger {
            total_exchange_fee: QUOTE_PRECISION / 2,
            ..FeeLedger::default()
        },
        market_stats: MarketStats {
            funding_period: 3600,
            last_mark_price_twap: 50 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (49 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            ..MarketStats::default()
        },
        ..PerpMarket::default()
    };

    assert_eq!(balanced_funding, 41666666);

    let (long_funding, short_funding, capped_pnl) = calculate_funding_rate_long_short(
        &crate::math::funding::FundingMarketInputs::from_market(&market),
        balanced_funding,
    )
    .unwrap();
    market.amm.record_amm_pnl(capped_pnl).unwrap();

    assert_eq!(long_funding, balanced_funding);
    assert_eq!(long_funding, short_funding);
    let new_fees = market.amm.total_fee_minus_distributions;
    assert!(new_fees > QUOTE_PRECISION as i128 / 2);
    assert_eq!(new_fees, 1012295); // made over $.50
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
    create_anchor_account_info!(
        oracle_price,
        &oracle_price_key,
        PythLazerOracle,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();
    let mut market = PerpMarket {
        market_index: 0,
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: -12295081967, //~12
            total_fee_minus_distributions: ((QUOTE_PRECISION * 99999) as i128),

            ..AMM::default()
        },
        oracle: oracle_price_key,
        oracle_source: crate::state::oracle::OracleSource::PythLazer,
        base_asset_amount_long: 12295081967,
        base_asset_amount_short: -12295081967 * 2,
        fee_ledger: FeeLedger {
            total_exchange_fee: QUOTE_PRECISION / 2,
            ..FeeLedger::default()
        },
        market_stats: MarketStats {
            funding_period: 3600,
            last_mark_price_twap: 50 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (49 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            ..MarketStats::default()
        },
        ..PerpMarket::default()
    };

    let res1 = market
        .get_max_price_divergence_for_funding_rate(
            market
                .market_stats
                .historical_oracle_data
                .last_oracle_price_twap,
        )
        .unwrap();
    assert_eq!(res1, 4900000);
    market.contract_tier = ContractTier::B;
    let res1 = market
        .get_max_price_divergence_for_funding_rate(
            market
                .market_stats
                .historical_oracle_data
                .last_oracle_price_twap,
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
    create_anchor_account_info!(
        oracle_price,
        &oracle_price_key,
        PythLazerOracle,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();
    let mut market = PerpMarket {
        market_index: 0,
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 50000000,
            base_asset_amount_with_amm: -12295081967 + -((AMM_RESERVE_PRECISION * 500) as i128), //~ 12 - 500
            total_fee_minus_distributions: ((QUOTE_PRECISION * 99999) as i128),

            ..AMM::default()
        },
        oracle: oracle_price_key,
        oracle_source: crate::state::oracle::OracleSource::PythLazer,
        base_asset_amount_long: 12295081967,
        base_asset_amount_short: -12295081967 * 2,
        fee_ledger: FeeLedger {
            total_exchange_fee: QUOTE_PRECISION / 2,
            ..FeeLedger::default()
        },
        market_stats: MarketStats {
            funding_period: 3600,
            last_mark_price_twap: 50 * PRICE_PRECISION_U64,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (49 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            ..MarketStats::default()
        },
        ..PerpMarket::default()
    };
    assert_eq!(market.amm.reserve_price().unwrap(), 47628800);
    assert_eq!(market.net_unsettled_funding_pnl, 0);

    let time_until_next_update = on_the_hour_update(
        now,
        market.last_funding_rate_ts,
        market.market_stats.funding_period,
    )
    .unwrap();

    assert_eq!(time_until_next_update, 3600);
    let time_until_next_update = on_the_hour_update(
        now + 3600,
        market.last_funding_rate_ts,
        market.market_stats.funding_period,
    )
    .unwrap();
    let oracle_price_data = oracle_map.get_price_data(&market.oracle_id()).unwrap();
    let mm_oracle_price_data = MMOraclePriceData::new(
        oracle_price_data.price,
        oracle_price_data.delay + 1,
        0,
        OracleValidity::default(),
        *oracle_price_data,
    )
    .unwrap();

    assert_eq!(time_until_next_update, 0);
    let block_funding_rate_update = block_operation(
        &market,
        oracle_price_data,
        &state.oracle_guard_rails,
        market.amm.reserve_price().unwrap(),
        slot,
    )
    .unwrap();
    assert_eq!(block_funding_rate_update, true);
    assert_eq!(market.amm.last_update_slot, slot);

    now += 3600;
    slot += 3600 * 2;

    let cost = _update_amm(&mut market, &mm_oracle_price_data, &state, now, slot).unwrap();
    assert_eq!(cost, 0);
    assert_eq!(market.amm.last_update_slot, slot);
    assert_eq!(market.market_stats.last_mark_price_twap, 50000000);
    assert_eq!(
        market
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap,
        51000000
    );
    // oracle twap > mark, expect negative funding

    let block_funding_rate_update = block_operation(
        &market,
        oracle_price_data,
        &state.oracle_guard_rails,
        market.amm.reserve_price().unwrap(),
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
    assert_eq!(market.market_stats.last_mark_price_twap, 47629736);
    assert!(market.market_stats.last_mark_price_twap > market.amm.reserve_price().unwrap());

    assert_eq!(
        market
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap,
        51000000
    );

    assert_eq!(market.cumulative_funding_rate_long, -139790125); // negative funding
    assert_eq!(market.cumulative_funding_rate_short, -139790125);
    assert_eq!(market.last_funding_rate, -139790125);
    assert_eq!(
        market.market_stats.last_24h_avg_funding_rate,
        -139790125 / 24 + 1
    );
    assert_eq!(market.last_funding_rate_ts, now);
    assert_eq!(market.amm.net_revenue_since_last_funding, 0); // back to 0
                                                              // AMM-as-user migration: the AMM now settles its funding from cum-rate
                                                              // deltas decomposed across the long and short sides (each side reads
                                                              // `base_asset_amount_long/short`), instead of from
                                                              // `base_asset_amount_with_amm`. This test fixture sets
                                                              // `base_asset_amount_with_amm` artificially divergent from
                                                              // `base_long + base_short`; the new math reflects only the user-side
                                                              // imbalance (~$1.72 gain), not the inflated `with_amm` value (~$70.61
                                                              // gain under the legacy single-net-position math).
    assert_eq!(market.amm.total_fee_minus_distributions, 100000718731);
    assert_eq!(market.amm.total_fee, 0);

    assert_ne!(market.net_unsettled_funding_pnl, 0); // important: imbalanced market adds funding rev
                                                     // net_unsettled_funding_pnl uses the math function's third return
                                                     // (uncapped, derived from `base_asset_amount_with_amm`), so it still
                                                     // reflects the legacy single-net-position value — the AMM-as-user
                                                     // migration only changed how the AMM books its own settlement, not
                                                     // this aggregate.
    assert_eq!(market.net_unsettled_funding_pnl, -71613793);
}

/// Property tests for `calculate_amm_funding_payment` — the AMM-as-user
/// settlement math. Locks the invariants the cum-rate-delta decomposition
/// has to satisfy so the migration to "AMM is just another user position"
/// can't silently drift.
mod amm_funding_payment {
    use super::*;
    use crate::math::constants::{
        AMM_TO_QUOTE_PRECISION_RATIO, FUNDING_RATE_BUFFER, PRICE_PRECISION,
    };

    /// Zero deltas → zero payment, regardless of position sizes.
    #[test]
    fn zero_delta_pays_nothing() {
        let payment = calculate_amm_funding_payment(
            1_000_000_000_000, // base_long
            -500_000_000_000,  // base_short
            12345,             // cum_long
            6789,              // cum_short
            12345,             // last_cum_long (same → delta 0)
            6789,              // last_cum_short (same → delta 0)
        )
        .unwrap();
        assert_eq!(payment, 0);
    }

    /// Zero user positions on both sides → zero payment, regardless of
    /// deltas. The AMM has no exposure to settle.
    #[test]
    fn zero_positions_pays_nothing() {
        let payment = calculate_amm_funding_payment(0, 0, 1_000_000, -500_000, 0, 0).unwrap();
        assert_eq!(payment, 0);
    }

    /// Balanced book (`base_long == -base_short`) + symmetric cum rates →
    /// AMM nets out to zero. Sanity check that the long-side and
    /// short-side contributions cancel when there's no imbalance.
    #[test]
    fn balanced_book_symmetric_rates_pays_nothing() {
        let payment = calculate_amm_funding_payment(
            1_000_000_000_000,
            -1_000_000_000_000,
            10_000,
            10_000,
            0,
            0,
        )
        .unwrap();
        assert_eq!(payment, 0);
    }

    /// Long-biased book + positive funding rate → longs pay shorts;
    /// AMM (net short on the imbalance) earns. Sign check.
    #[test]
    fn long_bias_positive_rate_amm_earns() {
        let payment = calculate_amm_funding_payment(
            2_000_000_000_000,  // base_long (more longs)
            -1_000_000_000_000, // base_short
            10_000,             // cum_long delta = +10000
            10_000,             // cum_short delta = +10000 (symmetric)
            0,
            0,
        )
        .unwrap();
        assert!(payment > 0, "AMM should earn when long-biased and rate > 0");
    }

    /// Short-biased book + positive funding rate → AMM (net long on the
    /// imbalance) pays.
    #[test]
    fn short_bias_positive_rate_amm_pays() {
        let payment = calculate_amm_funding_payment(
            1_000_000_000_000,
            -2_000_000_000_000, // more shorts
            10_000,
            10_000,
            0,
            0,
        )
        .unwrap();
        assert!(payment < 0, "AMM should pay when short-biased and rate > 0");
    }

    /// Reversing the sign of the funding rate reverses the AMM's payment.
    #[test]
    fn rate_sign_inverts_payment() {
        let pos = calculate_amm_funding_payment(
            2_000_000_000_000,
            -1_000_000_000_000,
            10_000,
            10_000,
            0,
            0,
        )
        .unwrap();
        let neg = calculate_amm_funding_payment(
            2_000_000_000_000,
            -1_000_000_000_000,
            -10_000,
            -10_000,
            0,
            0,
        )
        .unwrap();
        assert_eq!(pos, -neg);
    }

    /// Calling `calculate_amm_funding_payment` twice with the same `last_*`
    /// is the same as calling once. Concretely: settling a single funding
    /// period against the current cum rates is idempotent if last_* are
    /// re-read after each call.
    #[test]
    fn settle_then_advance_last_cum_rate_is_consistent() {
        let base_long = 1_500_000_000_000;
        let base_short = -800_000_000_000;
        let cum_long = 5_000;
        let cum_short = 3_000;

        // Single settle from a zero baseline.
        let one_shot =
            calculate_amm_funding_payment(base_long, base_short, cum_long, cum_short, 0, 0)
                .unwrap();

        // Two-step settle: cum rates advance halfway, then to full. The
        // sum should match the single settle (math is linear in delta).
        let step_a = calculate_amm_funding_payment(
            base_long, base_short, 2_000, // partial cum_long
            1_000, // partial cum_short
            0, 0,
        )
        .unwrap();
        let step_b = calculate_amm_funding_payment(
            base_long, base_short, cum_long, cum_short,
            2_000, // last_cum_long = previous cum_long
            1_000, // last_cum_short = previous cum_short
        )
        .unwrap();

        // Allow ±1 quote unit of rounding because magnitude rounding in
        // `_calculate_funding_payment` happens per-call.
        assert!(
            (step_a + step_b - one_shot).abs() <= 1,
            "two-step settle ({} + {} = {}) should match one-shot ({})",
            step_a,
            step_b,
            step_a + step_b,
            one_shot
        );
    }

    /// Uncapped case (rate_long == rate_short): the AMM's payment via two-
    /// side decomp equals the legacy single-net-position math
    /// `-calculate_funding_payment_in_quote_precision(rate, B)` where
    /// `B = base_long + base_short`. Locks the equivalence with master in
    /// the no-cap path.
    #[test]
    fn uncapped_matches_legacy_single_position_math() {
        // Fixtures over a few combinations: long-bias / short-bias /
        // balanced × positive / negative rate.
        let fixtures: &[(i128, i128, i128)] = &[
            // (base_long, base_short, rate)
            (
                2_000_000_000_000,
                -1_000_000_000_000,
                FUNDING_RATE_BUFFER as i128 / 10,
            ),
            (
                1_000_000_000_000,
                -2_000_000_000_000,
                FUNDING_RATE_BUFFER as i128 / 10,
            ),
            (
                2_000_000_000_000,
                -1_000_000_000_000,
                -(FUNDING_RATE_BUFFER as i128 / 10),
            ),
            (
                1_500_000_000_000,
                -1_500_000_000_000, // balanced
                FUNDING_RATE_BUFFER as i128 / 20,
            ),
        ];

        for (i, &(base_long, base_short, rate)) in fixtures.iter().enumerate() {
            // Two-side decomp: cum_long delta == cum_short delta == rate
            // (uncapped → same delta on both sides).
            let amm_payment =
                calculate_amm_funding_payment(base_long, base_short, rate, rate, 0, 0).unwrap();

            // Legacy: -calculate_funding_payment(rate, base_long + base_short).
            let net_pos = base_long + base_short;
            let legacy_owe = calculate_funding_payment_in_quote_precision(rate, net_pos).unwrap();
            let legacy_amm_pnl = -legacy_owe;

            // Magnitude must match within a small rounding tolerance —
            // the two-side decomp adds two partial payments, each
            // independently rounded.
            let _ = (PRICE_PRECISION, AMM_TO_QUOTE_PRECISION_RATIO); // silence
            assert!(
                (amm_payment - legacy_amm_pnl).abs() <= 2,
                "fixture {}: two-side decomp ({}) should match legacy single-pos math ({})",
                i,
                amm_payment,
                legacy_amm_pnl
            );
        }
    }

    /// Capped case: capping only fires when the AMM would have paid
    /// (uncapped imbalance < 0). The cap reduces what users on the
    /// receiving side get, which moves the AMM's payment toward zero —
    /// in extreme caps it can even flip the sign (longs pay full, shorts
    /// receive nothing, AMM nets positive). The invariant: `capped >
    /// uncapped` when `uncapped < 0`.
    #[test]
    fn capped_short_side_reduces_amm_debt() {
        let base_long = 1_000_000_000_000;
        let base_short = -2_000_000_000_000; // more shorts → uncapped, AMM pays
        let full_rate = FUNDING_RATE_BUFFER as i128 / 10;
        let capped_rate = full_rate / 3; // shorts receive only 1/3 of what longs pay

        let uncapped =
            calculate_amm_funding_payment(base_long, base_short, full_rate, full_rate, 0, 0)
                .unwrap();
        let capped =
            calculate_amm_funding_payment(base_long, base_short, full_rate, capped_rate, 0, 0)
                .unwrap();

        assert!(uncapped < 0, "AMM should owe in uncapped scenario");
        assert!(
            capped > uncapped,
            "Capping the short-side rate should reduce AMM's debt ({} → {})",
            uncapped,
            capped
        );
    }
}
