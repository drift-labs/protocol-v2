use crate::math::amm::update_oracle_price_twap;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, PEG_PRECISION, PRICE_PRECISION, PRICE_PRECISION_U64,
};
use crate::math::oracle::*;
use crate::state::oracle::HistoricalOracleData;
use crate::state::perp_market::{ContractTier, PerpMarket, AMM};
use crate::state::state::{OracleGuardRails, PriceDivergenceGuardRails, State, ValidityGuardRails};

#[test]
fn calculate_oracle_valid() {
    let prev = 1656682258;
    let now = prev + 3600;

    let px = 32 * PRICE_PRECISION;
    let amm = AMM {
        base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
        peg_multiplier: 33 * PEG_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap_5min: px as i64,
            last_oracle_price_twap: (px as i64) - 1000,
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
    let mut market: PerpMarket = PerpMarket {
        amm,
        contract_tier: ContractTier::B,
        ..PerpMarket::default()
    };

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_percent_divergence: 1,
                oracle_twap_5min_percent_divergence: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,      // 5s
                slots_before_stale_for_margin: 120,  // 60s
                confidence_interval_max_size: 20000, // 2%
                too_volatile_ratio: 5,
            },
        },
        ..State::default()
    };

    let mut oracle_status =
        get_oracle_status(&market, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();

    assert!(oracle_status.oracle_validity == OracleValidity::Valid);
    assert_eq!(oracle_status.oracle_reserve_price_spread_pct, 30303); //0.030303 ()
    assert!(!oracle_status.mark_too_divergent);

    let _new_oracle_twap =
        update_oracle_price_twap(&mut market.amm, now, &oracle_price_data, None, None).unwrap();
    assert_eq!(
        market.amm.historical_oracle_data.last_oracle_price_twap,
        (34 * PRICE_PRECISION - PRICE_PRECISION / 100) as i64
    );

    oracle_price_data = OraclePriceData {
        price: (34 * PRICE_PRECISION) as i64,
        confidence: PRICE_PRECISION_U64 / 100,
        delay: 11,
        has_sufficient_number_of_data_points: true,
    };
    oracle_status =
        get_oracle_status(&market, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();
    assert!(oracle_status.oracle_validity != OracleValidity::Valid);

    oracle_price_data.delay = 8;
    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min = 32 * PRICE_PRECISION as i64;
    market.amm.historical_oracle_data.last_oracle_price_twap = 21 * PRICE_PRECISION as i64;
    oracle_status =
        get_oracle_status(&market, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();
    assert!(oracle_status.oracle_validity == OracleValidity::Valid);
    assert!(!oracle_status.mark_too_divergent);

    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min = 29 * PRICE_PRECISION as i64;
    oracle_status =
        get_oracle_status(&market, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();
    assert!(oracle_status.mark_too_divergent);
    assert!(oracle_status.oracle_validity == OracleValidity::Valid);

    oracle_price_data.confidence = PRICE_PRECISION_U64;
    oracle_status =
        get_oracle_status(&market, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();
    assert!(oracle_status.mark_too_divergent);
    assert!(oracle_status.oracle_validity == OracleValidity::TooUncertain);
}
