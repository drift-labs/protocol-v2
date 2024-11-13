use std::cmp::max;

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;

use crate::error::{DriftResult, ErrorCode};
use crate::math::amm;
use crate::math::casting::Cast;
use crate::math::constants::BID_ASK_SPREAD_PRECISION;
use crate::math::safe_math::SafeMath;

use crate::state::oracle::{OraclePriceData, OracleSource};
use crate::state::paused_operations::PerpOperation;
use crate::state::perp_market::PerpMarket;
use crate::state::state::{OracleGuardRails, ValidityGuardRails};
use crate::state::user::MarketType;
use std::fmt;

#[cfg(test)]
mod tests;

// ordered by "severity"
#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq, Default)]
pub enum OracleValidity {
    NonPositive,
    TooVolatile,
    TooUncertain,
    StaleForMargin,
    InsufficientDataPoints,
    StaleForAMM,
    #[default]
    Valid,
}

impl OracleValidity {
    pub fn get_error_code(&self) -> ErrorCode {
        match self {
            OracleValidity::NonPositive => ErrorCode::OracleNonPositive,
            OracleValidity::TooVolatile => ErrorCode::OracleTooVolatile,
            OracleValidity::TooUncertain => ErrorCode::OracleTooUncertain,
            OracleValidity::StaleForMargin => ErrorCode::OracleStaleForMargin,
            OracleValidity::InsufficientDataPoints => ErrorCode::OracleInsufficientDataPoints,
            OracleValidity::StaleForAMM => ErrorCode::OracleStaleForAMM,
            OracleValidity::Valid => unreachable!(),
        }
    }
}

impl fmt::Display for OracleValidity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OracleValidity::NonPositive => write!(f, "NonPositive"),
            OracleValidity::TooVolatile => write!(f, "TooVolatile"),
            OracleValidity::TooUncertain => write!(f, "TooUncertain"),
            OracleValidity::StaleForMargin => write!(f, "StaleForMargin"),
            OracleValidity::InsufficientDataPoints => write!(f, "InsufficientDataPoints"),
            OracleValidity::StaleForAMM => write!(f, "StaleForAMM"),
            OracleValidity::Valid => write!(f, "Valid"),
        }
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
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
    OracleOrderPrice,
}

pub fn is_oracle_valid_for_action(
    oracle_validity: OracleValidity,
    action: Option<DriftAction>,
) -> DriftResult<bool> {
    let is_ok = match action {
        Some(action) => match action {
            DriftAction::FillOrderAmm => {
                matches!(oracle_validity, OracleValidity::Valid)
            }
            // relax oracle staleness, later checks for sufficiently recent amm slot update for funding update
            DriftAction::UpdateFunding => {
                matches!(
                    oracle_validity,
                    OracleValidity::Valid
                        | OracleValidity::StaleForAMM
                        | OracleValidity::InsufficientDataPoints
                        | OracleValidity::StaleForMargin
                )
            }
            DriftAction::OracleOrderPrice => {
                matches!(
                    oracle_validity,
                    OracleValidity::Valid
                        | OracleValidity::StaleForAMM
                        | OracleValidity::InsufficientDataPoints
                )
            }
            DriftAction::MarginCalc => !matches!(
                oracle_validity,
                OracleValidity::NonPositive
                    | OracleValidity::TooVolatile
                    | OracleValidity::TooUncertain
                    | OracleValidity::StaleForMargin
            ),
            DriftAction::TriggerOrder => !matches!(
                oracle_validity,
                OracleValidity::NonPositive | OracleValidity::TooVolatile
            ),
            DriftAction::SettlePnl => matches!(
                oracle_validity,
                OracleValidity::Valid
                    | OracleValidity::StaleForAMM
                    | OracleValidity::InsufficientDataPoints
                    | OracleValidity::StaleForMargin
            ),
            DriftAction::FillOrderMatch => !matches!(
                oracle_validity,
                OracleValidity::NonPositive
                    | OracleValidity::TooVolatile
                    | OracleValidity::TooUncertain
            ),
            DriftAction::Liquidate => !matches!(
                oracle_validity,
                OracleValidity::NonPositive | OracleValidity::TooVolatile
            ),
            DriftAction::UpdateTwap => !matches!(oracle_validity, OracleValidity::NonPositive),
            DriftAction::UpdateAMMCurve => !matches!(oracle_validity, OracleValidity::NonPositive),
        },
        None => {
            matches!(oracle_validity, OracleValidity::Valid)
        }
    };

    Ok(is_ok)
}

pub fn block_operation(
    market: &PerpMarket,
    oracle_price_data: &OraclePriceData,
    guard_rails: &OracleGuardRails,
    reserve_price: u64,
    slot: u64,
) -> DriftResult<bool> {
    let OracleStatus {
        oracle_validity,
        mark_too_divergent: is_oracle_mark_too_divergent,
        oracle_reserve_price_spread_pct: _,
        ..
    } = get_oracle_status(market, oracle_price_data, guard_rails, reserve_price)?;
    let is_oracle_valid =
        is_oracle_valid_for_action(oracle_validity, Some(DriftAction::UpdateFunding))?;

    let slots_since_amm_update = slot.saturating_sub(market.amm.last_update_slot);

    let funding_paused_on_market = market.is_operation_paused(PerpOperation::UpdateFunding);

    // block if amm hasnt been updated since over half the funding period (assuming slot ~= 500ms)
    let block = slots_since_amm_update > market.amm.funding_period.cast()?
        || !is_oracle_valid
        || is_oracle_mark_too_divergent
        || funding_paused_on_market;
    Ok(block)
}

#[derive(Default, Clone, Copy, Debug)]
pub struct OracleStatus {
    pub price_data: OraclePriceData,
    pub oracle_reserve_price_spread_pct: i64,
    pub mark_too_divergent: bool,
    pub oracle_validity: OracleValidity,
}

pub fn get_oracle_status(
    market: &PerpMarket,
    oracle_price_data: &OraclePriceData,
    guard_rails: &OracleGuardRails,
    reserve_price: u64,
) -> DriftResult<OracleStatus> {
    let oracle_validity = oracle_validity(
        MarketType::Perp,
        market.market_index,
        market.amm.historical_oracle_data.last_oracle_price_twap,
        oracle_price_data,
        &guard_rails.validity,
        market.get_max_confidence_interval_multiplier()?,
        &market.amm.oracle_source,
        false,
    )?;
    let oracle_reserve_price_spread_pct =
        amm::calculate_oracle_twap_5min_price_spread_pct(&market.amm, reserve_price)?;
    let is_oracle_mark_too_divergent = amm::is_oracle_mark_too_divergent(
        oracle_reserve_price_spread_pct,
        &guard_rails.price_divergence,
    )?;

    Ok(OracleStatus {
        price_data: *oracle_price_data,
        oracle_reserve_price_spread_pct,
        mark_too_divergent: is_oracle_mark_too_divergent,
        oracle_validity,
    })
}

pub fn oracle_validity(
    market_type: MarketType,
    market_index: u16,
    last_oracle_twap: i64,
    oracle_price_data: &OraclePriceData,
    valid_oracle_guard_rails: &ValidityGuardRails,
    max_confidence_interval_multiplier: u64,
    oracle_source: &OracleSource,
    log_validity: bool,
) -> DriftResult<OracleValidity> {
    let OraclePriceData {
        price: oracle_price,
        confidence: oracle_conf,
        delay: oracle_delay,
        has_sufficient_number_of_data_points,
        ..
    } = *oracle_price_data;

    let is_oracle_price_nonpositive = oracle_price <= 0;

    let is_oracle_price_too_volatile = (oracle_price.max(last_oracle_twap))
        .safe_div(last_oracle_twap.min(oracle_price).max(1))?
        .gt(&valid_oracle_guard_rails.too_volatile_ratio);

    let conf_pct_of_price = max(1, oracle_conf)
        .safe_mul(BID_ASK_SPREAD_PRECISION)?
        .safe_div(oracle_price.cast()?)?;

    // TooUncertain
    let is_conf_too_large = conf_pct_of_price.gt(&valid_oracle_guard_rails
        .confidence_interval_max_size
        .safe_mul(max_confidence_interval_multiplier)?);

    let is_stale_for_amm = oracle_delay.gt(&valid_oracle_guard_rails.slots_before_stale_for_amm);

    let is_stale_for_margin = if matches!(oracle_source, OracleSource::PythStableCoinPull | OracleSource::PythStableCoin)
    {
        oracle_delay.gt(&(valid_oracle_guard_rails.slots_before_stale_for_margin.saturating_mul(3)))
    } else {
        oracle_delay.gt(&valid_oracle_guard_rails.slots_before_stale_for_margin)
    };

    let oracle_validity = if is_oracle_price_nonpositive {
        OracleValidity::NonPositive
    } else if is_oracle_price_too_volatile {
        OracleValidity::TooVolatile
    } else if is_conf_too_large {
        OracleValidity::TooUncertain
    } else if is_stale_for_margin {
        OracleValidity::StaleForMargin
    } else if !has_sufficient_number_of_data_points {
        OracleValidity::InsufficientDataPoints
    } else if is_stale_for_amm {
        OracleValidity::StaleForAMM
    } else {
        OracleValidity::Valid
    };

    if log_validity {
        if !has_sufficient_number_of_data_points {
            msg!(
                "Invalid {} {} Oracle: Insufficient Data Points",
                market_type,
                market_index
            );
        }

        if is_oracle_price_nonpositive {
            msg!(
                "Invalid {} {} Oracle: Non-positive (oracle_price <=0)",
                market_type,
                market_index
            );
        }

        if is_oracle_price_too_volatile {
            msg!(
                "Invalid {} {} Oracle: Too Volatile (last_oracle_price_twap={:?} vs oracle_price={:?})",
                market_type,
                market_index,
                last_oracle_twap,
                oracle_price,
            );
        }

        if is_conf_too_large {
            msg!(
                "Invalid {} {} Oracle: Confidence Too Large (is_conf_too_large={:?})",
                market_type,
                market_index,
                conf_pct_of_price
            );
        }

        if is_stale_for_amm || is_stale_for_margin {
            msg!(
                "Invalid {} {} Oracle: Stale (oracle_delay={:?})",
                market_type,
                market_index,
                oracle_delay
            );
        }
    }

    Ok(oracle_validity)
}
