use crate::error::ClearingHouseResult;
use crate::math::amm;
use crate::math::casting::cast_to_u128;
use crate::math::constants::BID_ASK_SPREAD_PRECISION;
use crate::math_error;
use crate::state::market::AMM;
use crate::state::oracle::OraclePriceData;
use crate::state::state::{OracleGuardRails, ValidityGuardRails};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;
use std::cmp::max;

// ordered by "severity"
#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum OracleValidity {
    Invalid,
    TooVolatile,
    StaleForMargin,
    InsufficientDataPoints,
    StaleForAMM,
    Valid,
}

impl Default for OracleValidity {
    fn default() -> Self {
        OracleValidity::Valid
    }
}

pub enum DriftAction {
    UpdateFunding,
    SettlePnl,
    TriggerOrder,
    FillOrderMatch,
    FillOrderAmm,
    Liquidate,
    MarginCalc,
    UpdateTwap,
    UpdateAMMCurve,
}

pub fn is_oracle_valid_for_action(
    oracle_validity: OracleValidity,
    action: Option<DriftAction>,
) -> ClearingHouseResult<bool> {
    let is_ok = match action {
        Some(action) => match action {
            DriftAction::FillOrderAmm => {
                matches!(oracle_validity, OracleValidity::Valid)
            }
            DriftAction::UpdateFunding => {
                matches!(
                    oracle_validity,
                    OracleValidity::Valid | OracleValidity::StaleForAMM
                )
            }
            DriftAction::MarginCalc => !matches!(
                oracle_validity,
                OracleValidity::Invalid
                    | OracleValidity::TooVolatile
                    | OracleValidity::StaleForMargin
            ),
            DriftAction::TriggerOrder => !matches!(
                oracle_validity,
                OracleValidity::Invalid | OracleValidity::TooVolatile
            ),
            DriftAction::SettlePnl => !matches!(
                oracle_validity,
                OracleValidity::Invalid | OracleValidity::TooVolatile
            ),
            DriftAction::Liquidate => !matches!(
                oracle_validity,
                OracleValidity::Invalid | OracleValidity::TooVolatile
            ),
            DriftAction::FillOrderMatch => !matches!(
                oracle_validity,
                OracleValidity::Invalid | OracleValidity::TooVolatile
            ),
            DriftAction::UpdateTwap => !matches!(oracle_validity, OracleValidity::Invalid),
            DriftAction::UpdateAMMCurve => !matches!(oracle_validity, OracleValidity::Invalid),
        },
        None => {
            matches!(oracle_validity, OracleValidity::Valid)
        }
    };

    Ok(is_ok)
}

pub fn block_operation(
    amm: &AMM,
    oracle_price_data: &OraclePriceData,
    guard_rails: &OracleGuardRails,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<bool> {
    let OracleStatus {
        oracle_validity,
        mark_too_divergent: is_oracle_mark_too_divergent,
        oracle_mark_spread_pct: _,
        ..
    } = get_oracle_status(amm, oracle_price_data, guard_rails, precomputed_mark_price)?;
    let is_oracle_valid =
        is_oracle_valid_for_action(oracle_validity, Some(DriftAction::UpdateFunding))?;
    let block = !is_oracle_valid || is_oracle_mark_too_divergent;
    Ok(block)
}

#[derive(Default, Clone, Copy, Debug)]
pub struct OracleStatus {
    pub price_data: OraclePriceData,
    pub oracle_mark_spread_pct: i128,
    pub mark_too_divergent: bool,
    pub oracle_validity: OracleValidity,
}

pub fn get_oracle_status<'a>(
    amm: &AMM,
    oracle_price_data: &'a OraclePriceData,
    guard_rails: &OracleGuardRails,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<OracleStatus> {
    let oracle_validity = oracle_validity(
        amm.historical_oracle_data.last_oracle_price_twap,
        oracle_price_data,
        &guard_rails.validity,
    )?;
    let oracle_mark_spread_pct =
        amm::calculate_oracle_twap_5min_mark_spread_pct(amm, precomputed_mark_price)?;
    let is_oracle_mark_too_divergent =
        amm::is_oracle_mark_too_divergent(oracle_mark_spread_pct, &guard_rails.price_divergence)?;

    Ok(OracleStatus {
        price_data: *oracle_price_data,
        oracle_mark_spread_pct,
        mark_too_divergent: is_oracle_mark_too_divergent,
        oracle_validity,
    })
}

pub fn oracle_validity(
    last_oracle_twap: i128,
    oracle_price_data: &OraclePriceData,
    valid_oracle_guard_rails: &ValidityGuardRails,
) -> ClearingHouseResult<OracleValidity> {
    let OraclePriceData {
        price: oracle_price,
        confidence: oracle_conf,
        delay: oracle_delay,
        has_sufficient_number_of_data_points,
        ..
    } = *oracle_price_data;

    let is_oracle_price_nonpositive = oracle_price <= 0;
    if is_oracle_price_nonpositive {
        msg!("Invalid Oracle: Non-positive (oracle_price <=0)");
    }

    let is_oracle_price_too_volatile = (oracle_price.max(last_oracle_twap))
        .checked_div(last_oracle_twap.min(oracle_price).max(1))
        .ok_or_else(math_error!())?
        .gt(&valid_oracle_guard_rails.too_volatile_ratio);

    if is_oracle_price_too_volatile {
        msg!(
            "Invalid Oracle: Too Volatile (last_oracle_price_twap={:?} vs oracle_price={:?})",
            last_oracle_twap,
            oracle_price
        );
    }

    let conf_pct_of_price = max(1, oracle_conf)
        .checked_mul(BID_ASK_SPREAD_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(cast_to_u128(oracle_price)?)
        .ok_or_else(math_error!())?;

    let is_conf_too_large =
        conf_pct_of_price.gt(&valid_oracle_guard_rails.confidence_interval_max_size);
    if is_conf_too_large {
        msg!(
            "Invalid Oracle: Confidence Too Large (is_conf_too_large={:?})",
            conf_pct_of_price
        );
    }
    let is_stale_for_amm = oracle_delay.gt(&valid_oracle_guard_rails.slots_before_stale_for_amm);
    let is_stale_for_margin =
        oracle_delay.gt(&valid_oracle_guard_rails.slots_before_stale_for_margin);
    if is_stale_for_amm || is_stale_for_margin {
        msg!("Invalid Oracle: Stale (oracle_delay={:?})", oracle_delay);
    }

    let oracle_validity = if is_oracle_price_nonpositive || is_conf_too_large {
        OracleValidity::Invalid
    } else if is_oracle_price_too_volatile {
        OracleValidity::TooVolatile
    } else if is_stale_for_margin {
        OracleValidity::StaleForMargin
    } else if !has_sufficient_number_of_data_points {
        OracleValidity::InsufficientDataPoints
    } else if is_stale_for_amm {
        OracleValidity::StaleForAMM
    } else {
        OracleValidity::Valid
    };

    Ok(oracle_validity)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::amm::update_oracle_price_twap;
    use crate::math::constants::{AMM_RESERVE_PRECISION, MARK_PRICE_PRECISION, PEG_PRECISION};
    use crate::state::oracle::HistoricalOracleData;
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
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap_5min: px as i128,
                last_oracle_price_twap: (px as i128) - 10000000,
                last_oracle_price_twap_ts: prev,
                ..HistoricalOracleData::default()
            },
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
                    slots_before_stale_for_amm: 10,      // 5s
                    slots_before_stale_for_margin: 120,  // 60s
                    confidence_interval_max_size: 20000, // 2%
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        let mut oracle_status =
            get_oracle_status(&amm, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();

        assert!(oracle_status.oracle_validity == OracleValidity::Valid);
        assert_eq!(oracle_status.oracle_mark_spread_pct, 30303); //0.030303 ()
        assert!(!oracle_status.mark_too_divergent);

        let _new_oracle_twap =
            update_oracle_price_twap(&mut amm, now, &oracle_price_data, None).unwrap();
        assert_eq!(
            amm.historical_oracle_data.last_oracle_price_twap,
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
        assert!(oracle_status.oracle_validity != OracleValidity::Valid);

        oracle_price_data.delay = 8;
        amm.historical_oracle_data.last_oracle_price_twap_5min = 32 * MARK_PRICE_PRECISION as i128;
        amm.historical_oracle_data.last_oracle_price_twap = 21 * MARK_PRICE_PRECISION as i128;
        oracle_status =
            get_oracle_status(&amm, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();
        assert!(oracle_status.oracle_validity == OracleValidity::Valid);
        assert!(!oracle_status.mark_too_divergent);

        amm.historical_oracle_data.last_oracle_price_twap_5min = 29 * MARK_PRICE_PRECISION as i128;
        oracle_status =
            get_oracle_status(&amm, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();
        assert!(oracle_status.mark_too_divergent);
        assert!(oracle_status.oracle_validity == OracleValidity::Valid);

        oracle_price_data.confidence = MARK_PRICE_PRECISION;
        oracle_status =
            get_oracle_status(&amm, &oracle_price_data, &state.oracle_guard_rails, None).unwrap();
        assert!(oracle_status.mark_too_divergent);
        assert!(oracle_status.oracle_validity == OracleValidity::Invalid);
    }
}
