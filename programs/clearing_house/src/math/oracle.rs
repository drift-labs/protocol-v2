use crate::error::ClearingHouseResult;
use crate::math::amm;
use crate::state::market::AMM;
use crate::state::oracle::OraclePriceData;
use crate::state::state::OracleGuardRails;

pub fn block_operation(
    amm: &AMM,
    oracle_price_data: &OraclePriceData,
    guard_rails: &OracleGuardRails,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<bool> {
    let OracleStatus {
        is_valid: oracle_is_valid,
        mark_too_divergent: is_oracle_mark_too_divergent,
        oracle_mark_spread_pct: _,
        ..
    } = get_oracle_status(amm, oracle_price_data, guard_rails, precomputed_mark_price)?;

    let block = !oracle_is_valid || is_oracle_mark_too_divergent;
    Ok(block)
}

#[derive(Default, Clone, Copy, Debug)]
pub struct OracleStatus {
    pub price_data: OraclePriceData,
    pub oracle_mark_spread_pct: i128,
    pub is_valid: bool,
    pub mark_too_divergent: bool,
}

pub fn get_oracle_status<'a>(
    amm: &AMM,
    oracle_price_data: &'a OraclePriceData,
    guard_rails: &OracleGuardRails,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<OracleStatus> {
    let oracle_is_valid = amm::is_oracle_valid(amm, oracle_price_data, &guard_rails.validity)?;
    let oracle_mark_spread_pct =
        amm::calculate_oracle_twap_5min_mark_spread_pct(amm, precomputed_mark_price)?;
    let is_oracle_mark_too_divergent =
        amm::is_oracle_mark_too_divergent(oracle_mark_spread_pct, &guard_rails.price_divergence)?;

    Ok(OracleStatus {
        price_data: *oracle_price_data,
        oracle_mark_spread_pct,
        is_valid: oracle_is_valid,
        mark_too_divergent: is_oracle_mark_too_divergent,
    })
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::amm::update_oracle_price_twap;
    use crate::math::constants::{AMM_RESERVE_PRECISION, MARK_PRICE_PRECISION, PEG_PRECISION};
    use crate::state::state::{
        OracleGuardRails, PriceDivergenceGuardRails, State, ValidityGuardRails,
    };
    #[test]
    fn calculate_oracle_valid() {
        let prev = 1656682258;
        let now = prev + 3600;

        let px = 32 * MARK_PRICE_PRECISION;

        let mut amm = AMM {
            base_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 2 * AMM_RESERVE_PRECISION,
            peg_multiplier: 33 * PEG_PRECISION,
            last_oracle_price_twap_5min: px as i128,
            last_oracle_price_twap: (px as i128) - 10000000,
            last_oracle_price_twap_ts: prev,
            mark_std: MARK_PRICE_PRECISION as u64,
            last_mark_price_twap_ts: prev,
            funding_period: 3600_i64,
            ..AMM::default()
        };
        let mut oracle_price_data = OraclePriceData {
            price: (34 * MARK_PRICE_PRECISION) as i128,
            confidence: MARK_PRICE_PRECISION / 100,
            delay: 1,
            has_sufficient_number_of_data_points: true,
        };

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 20000, // 2%
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        let mut oracle_status =
            get_oracle_status(&amm, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();

        assert!(oracle_status.is_valid);
        assert_eq!(oracle_status.oracle_mark_spread_pct, 30303); //0.030303 ()
        assert_eq!(oracle_status.mark_too_divergent, false);

        let _new_oracle_twap =
            update_oracle_price_twap(&mut amm, now, &oracle_price_data, None).unwrap();
        assert_eq!(
            amm.last_oracle_price_twap,
            (34 * MARK_PRICE_PRECISION - MARK_PRICE_PRECISION / 100) as i128
        );

        oracle_price_data = OraclePriceData {
            price: (34 * MARK_PRICE_PRECISION) as i128,
            confidence: MARK_PRICE_PRECISION / 100,
            delay: 11,
            has_sufficient_number_of_data_points: true,
        };
        oracle_status =
            get_oracle_status(&amm, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();
        assert_eq!(oracle_status.is_valid, false);

        oracle_price_data.delay = 8;
        amm.last_oracle_price_twap_5min = 32 * MARK_PRICE_PRECISION as i128;
        amm.last_oracle_price_twap = 21 * MARK_PRICE_PRECISION as i128;
        oracle_status =
            get_oracle_status(&amm, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();
        assert_eq!(oracle_status.is_valid, true);
        assert_eq!(oracle_status.mark_too_divergent, false);

        amm.last_oracle_price_twap_5min = 29 * MARK_PRICE_PRECISION as i128;
        oracle_status =
            get_oracle_status(&amm, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();
        assert_eq!(oracle_status.mark_too_divergent, true);
        assert_eq!(oracle_status.is_valid, true);

        oracle_price_data.confidence = 1 * MARK_PRICE_PRECISION;
        oracle_status =
            get_oracle_status(&amm, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();
        assert_eq!(oracle_status.mark_too_divergent, true);
        assert_eq!(oracle_status.is_valid, false);
    }
}
