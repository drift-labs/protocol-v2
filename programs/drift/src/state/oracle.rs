use anchor_lang::prelude::*;

use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::{PRICE_PRECISION, PRICE_PRECISION_I64, PRICE_PRECISION_U64};
use crate::math::safe_math::SafeMath;
use switchboard_solana::{AggregatorAccountData, SwitchboardDecimal};

use crate::math::safe_unwrap::SafeUnwrap;
use crate::validate;

#[cfg(test)]
mod tests;

#[derive(Default, AnchorSerialize, AnchorDeserialize, Clone, Copy, Eq, PartialEq, Debug)]
pub struct HistoricalOracleData {
    /// precision: PRICE_PRECISION
    pub last_oracle_price: i64,
    /// precision: PRICE_PRECISION
    pub last_oracle_conf: u64,
    /// number of slots since last update
    pub last_oracle_delay: i64,
    /// precision: PRICE_PRECISION
    pub last_oracle_price_twap: i64,
    /// precision: PRICE_PRECISION
    pub last_oracle_price_twap_5min: i64,
    /// unix_timestamp of last snapshot
    pub last_oracle_price_twap_ts: i64,
}

impl HistoricalOracleData {
    pub fn default_quote_oracle() -> Self {
        HistoricalOracleData {
            last_oracle_price: PRICE_PRECISION_I64,
            last_oracle_conf: 0,
            last_oracle_delay: 0,
            last_oracle_price_twap: PRICE_PRECISION_I64,
            last_oracle_price_twap_5min: PRICE_PRECISION_I64,
            ..HistoricalOracleData::default()
        }
    }

    pub fn default_price(price: i64) -> Self {
        HistoricalOracleData {
            last_oracle_price: price,
            last_oracle_conf: 0,
            last_oracle_delay: 10,
            last_oracle_price_twap: price,
            last_oracle_price_twap_5min: price,
            ..HistoricalOracleData::default()
        }
    }

    pub fn default_with_current_oracle(oracle_price_data: OraclePriceData) -> Self {
        HistoricalOracleData {
            last_oracle_price: oracle_price_data.price,
            last_oracle_conf: oracle_price_data.confidence,
            last_oracle_delay: oracle_price_data.delay,
            last_oracle_price_twap: oracle_price_data.price,
            last_oracle_price_twap_5min: oracle_price_data.price,
            // last_oracle_price_twap_ts: now,
            ..HistoricalOracleData::default()
        }
    }
}

#[derive(Default, AnchorSerialize, AnchorDeserialize, Clone, Copy, Eq, PartialEq, Debug)]
pub struct HistoricalIndexData {
    /// precision: PRICE_PRECISION
    pub last_index_bid_price: u64,
    /// precision: PRICE_PRECISION
    pub last_index_ask_price: u64,
    /// precision: PRICE_PRECISION
    pub last_index_price_twap: u64,
    /// precision: PRICE_PRECISION
    pub last_index_price_twap_5min: u64,
    /// unix_timestamp of last snapshot
    pub last_index_price_twap_ts: i64,
}

impl HistoricalIndexData {
    pub fn default_quote_oracle() -> Self {
        HistoricalIndexData {
            last_index_bid_price: PRICE_PRECISION_U64,
            last_index_ask_price: PRICE_PRECISION_U64,
            last_index_price_twap: PRICE_PRECISION_U64,
            last_index_price_twap_5min: PRICE_PRECISION_U64,
            ..HistoricalIndexData::default()
        }
    }

    pub fn default_with_current_oracle(oracle_price_data: OraclePriceData) -> DriftResult<Self> {
        let price = oracle_price_data.price.cast::<u64>().safe_unwrap()?;
        Ok(HistoricalIndexData {
            last_index_bid_price: price,
            last_index_ask_price: price,
            last_index_price_twap: price,
            last_index_price_twap_5min: price,
            ..HistoricalIndexData::default()
        })
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Eq, PartialEq, Debug)]
pub enum OracleSource {
    Pyth,
    Switchboard,
    QuoteAsset,
    Pyth1K,
    Pyth1M,
    PythStableCoin,
}

impl Default for OracleSource {
    // UpOnly
    fn default() -> Self {
        OracleSource::Pyth
    }
}

#[derive(Default, Clone, Copy, Debug)]
pub struct OraclePriceData {
    pub price: i64,
    pub confidence: u64,
    pub delay: i64,
    pub has_sufficient_number_of_data_points: bool,
}

impl OraclePriceData {
    pub fn default_usd() -> Self {
        OraclePriceData {
            price: PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        }
    }
}

pub fn get_oracle_price(
    oracle_source: &OracleSource,
    price_oracle: &AccountInfo,
    clock_slot: u64,
) -> DriftResult<OraclePriceData> {
    match oracle_source {
        OracleSource::Pyth => get_pyth_price(price_oracle, clock_slot, 1),
        OracleSource::Pyth1K => get_pyth_price(price_oracle, clock_slot, 1000),
        OracleSource::Pyth1M => get_pyth_price(price_oracle, clock_slot, 1000000),
        OracleSource::PythStableCoin => get_pyth_stable_coin_price(price_oracle, clock_slot),
        OracleSource::Switchboard => get_switchboard_price(price_oracle, clock_slot),
        OracleSource::QuoteAsset => Ok(OraclePriceData {
            price: PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        }),
    }
}

pub fn get_pyth_price(
    price_oracle: &AccountInfo,
    clock_slot: u64,
    multiple: u128,
) -> DriftResult<OraclePriceData> {
    let pyth_price_data = price_oracle
        .try_borrow_data()
        .or(Err(crate::error::ErrorCode::UnableToLoadOracle))?;
    let price_data = pyth_client::cast::<pyth_client::Price>(&pyth_price_data);

    let oracle_price = price_data.agg.price;
    let oracle_conf = price_data.agg.conf;

    let min_publishers = price_data.num.min(3);
    let publisher_count = price_data.num_qt;

    let oracle_precision = 10_u128.pow(price_data.expo.unsigned_abs());

    if oracle_precision <= multiple {
        msg!("Multiple larger than oracle precision");
        return Err(crate::error::ErrorCode::InvalidOracle);
    }

    let oracle_precision = oracle_precision.safe_div(multiple)?;

    let mut oracle_scale_mult = 1;
    let mut oracle_scale_div = 1;

    if oracle_precision > PRICE_PRECISION {
        oracle_scale_div = oracle_precision.safe_div(PRICE_PRECISION)?;
    } else {
        oracle_scale_mult = PRICE_PRECISION.safe_div(oracle_precision)?;
    }

    let oracle_price_scaled = (oracle_price)
        .cast::<i128>()?
        .safe_mul(oracle_scale_mult.cast()?)?
        .safe_div(oracle_scale_div.cast()?)?
        .cast::<i64>()?;

    let oracle_conf_scaled = (oracle_conf)
        .cast::<u128>()?
        .safe_mul(oracle_scale_mult)?
        .safe_div(oracle_scale_div)?
        .cast::<u64>()?;

    let oracle_delay: i64 = clock_slot
        .cast::<i64>()?
        .safe_sub(price_data.valid_slot.cast()?)?;

    #[cfg(feature = "mainnet-beta")]
    let has_sufficient_number_of_data_points = publisher_count >= min_publishers;
    #[cfg(not(feature = "mainnet-beta"))]
    let has_sufficient_number_of_data_points = true;

    Ok(OraclePriceData {
        price: oracle_price_scaled,
        confidence: oracle_conf_scaled,
        delay: oracle_delay,
        has_sufficient_number_of_data_points,
    })
}

pub fn get_pyth_stable_coin_price(
    price_oracle: &AccountInfo,
    clock_slot: u64,
) -> DriftResult<OraclePriceData> {
    let mut oracle_price_data = get_pyth_price(price_oracle, clock_slot, 1)?;

    let price = oracle_price_data.price;
    let confidence = oracle_price_data.confidence;
    let five_bps = 500_i64;

    if price.safe_sub(PRICE_PRECISION_I64)?.abs() <= five_bps.min(confidence.cast()?) {
        oracle_price_data.price = PRICE_PRECISION_I64;
    }

    Ok(oracle_price_data)
}

pub fn get_switchboard_price(
    price_oracle: &AccountInfo,
    clock_slot: u64,
) -> DriftResult<OraclePriceData> {
    let aggregator_data_loader: AccountLoader<AggregatorAccountData> =
        AccountLoader::try_from(price_oracle).or(Err(ErrorCode::UnableToLoadOracle))?;
    let aggregator_data = aggregator_data_loader
        .load()
        .or(Err(ErrorCode::UnableToLoadOracle))?;

    let price = convert_switchboard_decimal(&aggregator_data.latest_confirmed_round.result)?
        .cast::<i64>()?;
    let confidence =
        convert_switchboard_decimal(&aggregator_data.latest_confirmed_round.std_deviation)?
            .cast::<i64>()?;

    // std deviation should always be positive, if we get a negative make it u128::MAX so it's flagged as bad value
    let confidence = if confidence < 0 {
        u64::MAX
    } else {
        let price_10bps = price.unsigned_abs().safe_div(1000)?;
        confidence.unsigned_abs().max(price_10bps)
    };

    let delay = clock_slot.cast::<i64>()?.safe_sub(
        aggregator_data
            .latest_confirmed_round
            .round_open_slot
            .cast()?,
    )?;

    let has_sufficient_number_of_data_points =
        aggregator_data.latest_confirmed_round.num_success >= aggregator_data.min_oracle_results;

    Ok(OraclePriceData {
        price,
        confidence,
        delay,
        has_sufficient_number_of_data_points,
    })
}

/// Given a decimal number represented as a mantissa (the digits) plus an
/// original_precision (10.pow(some number of decimals)), scale the
/// mantissa/digits to make sense with a new_precision.
fn convert_switchboard_decimal(switchboard_decimal: &SwitchboardDecimal) -> DriftResult<i128> {
    let switchboard_precision = 10_u128.pow(switchboard_decimal.scale);
    if switchboard_precision > PRICE_PRECISION {
        switchboard_decimal
            .mantissa
            .safe_div((switchboard_precision / PRICE_PRECISION) as i128)
    } else {
        switchboard_decimal
            .mantissa
            .safe_mul((PRICE_PRECISION / switchboard_precision) as i128)
    }
}

#[derive(Clone, Copy)]
pub struct StrictOraclePrice {
    pub current: i64,
    pub twap_5min: Option<i64>,
}

impl StrictOraclePrice {
    pub fn new(price: i64, twap_5min: i64, enabled: bool) -> Self {
        Self {
            current: price,
            twap_5min: if enabled { Some(twap_5min) } else { None },
        }
    }

    pub fn max(&self) -> i64 {
        match self.twap_5min {
            Some(twap) => self.current.max(twap),
            None => self.current,
        }
    }

    pub fn min(&self) -> i64 {
        match self.twap_5min {
            Some(twap) => self.current.min(twap),
            None => self.current,
        }
    }

    pub fn validate(&self) -> DriftResult {
        validate!(
            self.current > 0,
            ErrorCode::InvalidOracle,
            "oracle_price_data={} (<= 0)",
            self.current,
        )?;

        if let Some(twap) = self.twap_5min {
            validate!(
                twap > 0,
                ErrorCode::InvalidOracle,
                "oracle_price_twap={} (<= 0)",
                twap
            )?;
        }

        Ok(())
    }
}

#[cfg(test)]
impl StrictOraclePrice {
    pub fn test(price: i64) -> Self {
        Self {
            current: price,
            twap_5min: None,
        }
    }
}
