use anchor_lang::prelude::*;
use std::cell::Ref;

use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::{
    PERCENTAGE_PRECISION, PRICE_PRECISION, PRICE_PRECISION_I64, PRICE_PRECISION_U64,
};
use crate::math::safe_math::SafeMath;
use switchboard::{AggregatorAccountData, SwitchboardDecimal};
use switchboard_on_demand::{PullFeedAccountData, SB_ON_DEMAND_PRECISION};

use crate::error::ErrorCode::{InvalidOracle, UnableToLoadOracle};
use crate::math::oracle::{is_oracle_valid_for_action, DriftAction, OracleValidity};
use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::load_ref::load_ref;
use crate::state::perp_market::PerpMarket;
use crate::state::pyth_lazer_oracle::PythLazerOracle;
use crate::state::traits::Size;
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

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Eq, PartialEq, Debug, Default, Ord, PartialOrd,
)]
pub enum OracleSource {
    #[default]
    Pyth,
    Switchboard,
    QuoteAsset,
    Pyth1K,
    Pyth1M,
    PythStableCoin,
    Prelaunch,
    PythPull,
    Pyth1KPull,
    Pyth1MPull,
    PythStableCoinPull,
    SwitchboardOnDemand,
    PythLazer,
    PythLazer1K,
    PythLazer1M,
    PythLazerStableCoin,
}

impl OracleSource {
    pub fn is_pyth_pull_oracle(&self) -> bool {
        matches!(
            self,
            OracleSource::PythPull
                | OracleSource::Pyth1KPull
                | OracleSource::Pyth1MPull
                | OracleSource::PythStableCoinPull
        )
    }

    pub fn is_pyth_push_oracle(&self) -> bool {
        matches!(
            self,
            OracleSource::Pyth
                | OracleSource::Pyth1K
                | OracleSource::Pyth1M
                | OracleSource::PythStableCoin
        )
    }

    pub fn get_pyth_multiple(&self) -> u128 {
        match self {
            OracleSource::Pyth
            | OracleSource::PythPull
            | OracleSource::PythLazer
            | OracleSource::PythStableCoin
            | OracleSource::PythStableCoinPull
            | OracleSource::PythLazerStableCoin => 1,
            OracleSource::Pyth1K | OracleSource::Pyth1KPull | OracleSource::PythLazer1K => 1000,
            OracleSource::Pyth1M | OracleSource::Pyth1MPull | OracleSource::PythLazer1M => 1000000,
            _ => {
                panic!("Calling get_pyth_multiple on non-pyth oracle source");
            }
        }
    }
}

const MM_EXCHANGE_FALLBACK_THRESHOLD: u128 = PERCENTAGE_PRECISION / 100; // 1%
#[derive(Default, Clone, Copy, Debug)]
pub struct MMOraclePriceData {
    mm_oracle_price: i64,
    mm_oracle_delay: i64,
    mm_oracle_validity: OracleValidity,
    mm_exchange_diff_bps: u128,
    exchange_oracle_price_data: OraclePriceData,
    safe_oracle_price_data: OraclePriceData,
}

impl MMOraclePriceData {
    pub fn new(
        mm_oracle_price: i64,
        mm_oracle_delay: i64,
        mm_oracle_validity: OracleValidity,
        oracle_price_data: OraclePriceData,
    ) -> DriftResult<Self> {
        let price_diff = mm_oracle_price.safe_sub(oracle_price_data.price)?;
        let price_diff_bps = price_diff
            .abs()
            .cast::<u128>()?
            .safe_mul(PERCENTAGE_PRECISION)?
            .safe_div(oracle_price_data.price.abs().max(1).cast::<u128>()?)?;
        let safe_oracle_price_data = if mm_oracle_delay > oracle_price_data.delay
            || mm_oracle_price == 0i64
            || !is_oracle_valid_for_action(mm_oracle_validity, Some(DriftAction::UseMMOraclePrice))?
            || price_diff_bps > MM_EXCHANGE_FALLBACK_THRESHOLD
        // 1% price difference
        {
            oracle_price_data
        } else {
            let mm_oracle_diff_premium = mm_oracle_price.abs_diff(oracle_price_data.price);
            let adjusted_confidence = oracle_price_data
                .confidence
                .safe_add(mm_oracle_diff_premium)?;

            OraclePriceData {
                price: mm_oracle_price,
                confidence: adjusted_confidence,
                delay: mm_oracle_delay,
                has_sufficient_number_of_data_points: true,
            }
        };

        Ok(MMOraclePriceData {
            mm_oracle_price,
            mm_oracle_delay,
            mm_oracle_validity,
            mm_exchange_diff_bps: price_diff_bps,
            exchange_oracle_price_data: oracle_price_data,
            safe_oracle_price_data,
        })
    }

    pub fn get_price(&self) -> i64 {
        self.safe_oracle_price_data.price
    }

    pub fn get_delay(&self) -> i64 {
        self.safe_oracle_price_data.delay
    }

    pub fn get_confidence(&self) -> u64 {
        self.safe_oracle_price_data.confidence
    }

    pub fn get_safe_oracle_price_data(&self) -> OraclePriceData {
        self.safe_oracle_price_data
    }

    pub fn get_exchange_oracle_price_data(&self) -> OraclePriceData {
        self.exchange_oracle_price_data
    }

    pub fn get_mm_oracle_validity(&self) -> OracleValidity {
        self.mm_oracle_validity
    }

    pub fn get_mm_exchange_diff_bps(&self) -> u128 {
        self.mm_exchange_diff_bps
    }

    pub fn is_mm_exchange_diff_bps_high(&self) -> bool {
        self.mm_exchange_diff_bps > MM_EXCHANGE_FALLBACK_THRESHOLD
    }

    pub fn is_mm_oracle_as_recent(&self) -> bool {
        self.mm_oracle_delay <= self.safe_oracle_price_data.delay
    }

    pub fn is_enabled(&self) -> bool {
        self.mm_oracle_price != 0 && self.mm_oracle_delay >= 0
    }

    // For potential future observability
    pub fn _get_mm_oracle_price(&self) -> i64 {
        self.mm_oracle_price
    }

    pub fn get_mm_oracle_delay(&self) -> i64 {
        self.mm_oracle_delay
    }
}

#[derive(Default, Clone, Copy, Debug)]
pub struct OraclePriceData {
    pub price: i64,
    pub confidence: u64,
    pub delay: i64,
    pub has_sufficient_number_of_data_points: bool,
}

pub fn get_oracle_price(
    oracle_source: &OracleSource,
    price_oracle: &AccountInfo,
    clock_slot: u64,
) -> DriftResult<OraclePriceData> {
    match oracle_source {
        OracleSource::Pyth => get_pyth_price(price_oracle, clock_slot, oracle_source),
        OracleSource::Pyth1K => get_pyth_price(price_oracle, clock_slot, oracle_source),
        OracleSource::Pyth1M => get_pyth_price(price_oracle, clock_slot, oracle_source),
        OracleSource::PythStableCoin => {
            get_pyth_stable_coin_price(price_oracle, clock_slot, oracle_source)
        }
        OracleSource::Switchboard => get_switchboard_price(price_oracle, clock_slot),
        OracleSource::SwitchboardOnDemand => get_sb_on_demand_price(price_oracle, clock_slot),
        OracleSource::QuoteAsset => Ok(OraclePriceData {
            price: PRICE_PRECISION_I64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        }),
        OracleSource::Prelaunch => get_prelaunch_price(price_oracle, clock_slot),
        OracleSource::PythPull => get_pyth_price(price_oracle, clock_slot, oracle_source),
        OracleSource::Pyth1KPull => get_pyth_price(price_oracle, clock_slot, oracle_source),
        OracleSource::Pyth1MPull => get_pyth_price(price_oracle, clock_slot, oracle_source),
        OracleSource::PythStableCoinPull => {
            get_pyth_stable_coin_price(price_oracle, clock_slot, oracle_source)
        }
        OracleSource::PythLazer => get_pyth_price(price_oracle, clock_slot, oracle_source),
        OracleSource::PythLazer1K => get_pyth_price(price_oracle, clock_slot, oracle_source),
        OracleSource::PythLazer1M => get_pyth_price(price_oracle, clock_slot, oracle_source),
        OracleSource::PythLazerStableCoin => {
            get_pyth_stable_coin_price(price_oracle, clock_slot, oracle_source)
        }
    }
}

pub fn get_pyth_price(
    price_oracle: &AccountInfo,
    clock_slot: u64,
    oracle_source: &OracleSource,
) -> DriftResult<OraclePriceData> {
    let multiple = oracle_source.get_pyth_multiple();
    let mut pyth_price_data: &[u8] = &price_oracle
        .try_borrow_data()
        .or(Err(crate::error::ErrorCode::UnableToLoadOracle))?;

    let oracle_price: i64;
    let oracle_conf: u64;
    let mut has_sufficient_number_of_data_points: bool = true;
    let mut oracle_precision: u128;
    let published_slot: u64;

    if oracle_source.is_pyth_pull_oracle() {
        let price_message = pyth_solana_receiver_sdk::price_update::PriceUpdateV2::try_deserialize(
            &mut pyth_price_data,
        )
        .unwrap();
        oracle_price = price_message.price_message.price;
        oracle_conf = price_message.price_message.conf;
        oracle_precision = 10_u128.pow(price_message.price_message.exponent.unsigned_abs());
        published_slot = price_message.posted_slot;
    } else if oracle_source.is_pyth_push_oracle() {
        let price_data = pyth_client::cast::<pyth_client::Price>(pyth_price_data);
        oracle_price = price_data.agg.price;
        oracle_conf = price_data.agg.conf;
        let min_publishers = price_data.num.min(3);
        let publisher_count = price_data.num_qt;

        #[cfg(feature = "mainnet-beta")]
        {
            has_sufficient_number_of_data_points = publisher_count >= min_publishers;
        }
        #[cfg(not(feature = "mainnet-beta"))]
        {
            has_sufficient_number_of_data_points = true;
        }

        oracle_precision = 10_u128.pow(price_data.expo.unsigned_abs());
        published_slot = price_data.valid_slot;
    } else {
        let price_data = PythLazerOracle::try_deserialize(&mut pyth_price_data).unwrap();
        oracle_price = price_data.price;
        oracle_conf = price_data.conf;
        oracle_precision = 10_u128.pow(price_data.exponent.unsigned_abs());
        published_slot = price_data.posted_slot;
    }

    if oracle_precision <= multiple {
        msg!("Multiple larger than oracle precision");
        return Err(crate::error::ErrorCode::InvalidOracle);
    }
    oracle_precision = oracle_precision.safe_div(multiple)?;

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

    let oracle_delay: i64 = clock_slot.cast::<i64>()?.safe_sub(published_slot.cast()?)?;

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
    oracle_source: &OracleSource,
) -> DriftResult<OraclePriceData> {
    let mut oracle_price_data = get_pyth_price(price_oracle, clock_slot, oracle_source)?;

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
    let aggregator_data: Ref<AggregatorAccountData> =
        load_ref(price_oracle).or(Err(ErrorCode::UnableToLoadOracle))?;

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

pub fn get_sb_on_demand_price(
    price_oracle: &AccountInfo,
    clock_slot: u64,
) -> DriftResult<OraclePriceData> {
    let pull_feed_account_info: Ref<PullFeedAccountData> =
        load_ref(price_oracle).or(Err(ErrorCode::UnableToLoadOracle))?;

    let latest_oracle_submssions: Vec<switchboard_on_demand::OracleSubmission> =
        pull_feed_account_info.latest_submissions();
    let average_price = latest_oracle_submssions
        .iter()
        .map(|submission| submission.value)
        .sum::<i128>()
        / latest_oracle_submssions.len() as i128;

    let price = convert_sb_i128(&average_price)?.cast::<i64>()?;

    let confidence = convert_sb_i128(
        &pull_feed_account_info
            .range()
            .ok_or(ErrorCode::UnableToLoadOracle)?,
    )?
    .cast::<i64>()?
    .unsigned_abs();

    let delay = clock_slot
        .cast::<i64>()?
        .safe_sub(latest_oracle_submssions[0].landed_at.cast()?)?;

    let has_sufficient_number_of_data_points = true;

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

/// Given a decimal number represented as a mantissa (the digits) plus an
/// original_precision (10.pow(some number of decimals)), scale the
/// mantissa/digits to make sense with a new_precision.
fn convert_sb_i128(switchboard_i128: &i128) -> DriftResult<i128> {
    let switchboard_precision = 10_u128.pow(SB_ON_DEMAND_PRECISION);
    if switchboard_precision > PRICE_PRECISION {
        switchboard_i128.safe_div((switchboard_precision / PRICE_PRECISION) as i128)
    } else {
        switchboard_i128.safe_mul((PRICE_PRECISION / switchboard_precision) as i128)
    }
}

pub fn get_prelaunch_price(price_oracle: &AccountInfo, slot: u64) -> DriftResult<OraclePriceData> {
    let oracle: Ref<PrelaunchOracle> = load_ref(price_oracle).or(Err(UnableToLoadOracle))?;

    Ok(OraclePriceData {
        price: oracle.price,
        confidence: oracle.confidence,
        delay: oracle.amm_last_update_slot.saturating_sub(slot).cast()?,
        has_sufficient_number_of_data_points: true,
    })
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

#[account(zero_copy(unsafe))]
#[derive(Eq, PartialEq, Debug)]
#[repr(C)]
pub struct PrelaunchOracle {
    pub price: i64,
    pub max_price: i64,
    pub confidence: u64,
    // last slot oracle was updated, should be greater than or equal to last_update_slot
    pub last_update_slot: u64,
    // amm.last_update_slot at time oracle was updated
    pub amm_last_update_slot: u64,
    pub perp_market_index: u16,
    pub padding: [u8; 70],
}

impl Default for PrelaunchOracle {
    fn default() -> Self {
        PrelaunchOracle {
            price: 0,
            max_price: 0,
            confidence: 0,
            last_update_slot: 0,
            amm_last_update_slot: 0,
            perp_market_index: 0,
            padding: [0; 70],
        }
    }
}

impl Size for PrelaunchOracle {
    const SIZE: usize = 112 + 8;
}

impl PrelaunchOracle {
    pub fn update(&mut self, perp_market: &PerpMarket, slot: u64) -> DriftResult {
        let last_twap = perp_market.amm.last_mark_price_twap.cast::<i64>()?;
        let new_price = if self.max_price <= last_twap {
            msg!(
                "mark twap {} >= max price {}, using max",
                last_twap,
                self.max_price
            );
            self.max_price
        } else {
            last_twap
        };

        self.price = new_price;

        let spread_twap = perp_market
            .amm
            .last_ask_price_twap
            .cast::<i64>()?
            .safe_sub(perp_market.amm.last_bid_price_twap.cast()?)?
            .unsigned_abs();

        let mark_std = perp_market.amm.mark_std;

        self.confidence = spread_twap.max(mark_std);

        self.amm_last_update_slot = perp_market.amm.last_update_slot;
        self.last_update_slot = slot;

        msg!(
            "setting price = {} confidence = {}",
            self.price,
            self.confidence
        );

        Ok(())
    }

    pub fn validate(&self) -> DriftResult {
        validate!(self.price != 0, InvalidOracle, "price == 0",)?;

        validate!(self.max_price != 0, InvalidOracle, "max price == 0",)?;

        validate!(
            self.price <= self.max_price,
            InvalidOracle,
            "price {} > max price {}",
            self.price,
            self.max_price
        )?;

        Ok(())
    }
}

#[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub struct PrelaunchOracleParams {
    pub perp_market_index: u16,
    pub price: Option<i64>,
    pub max_price: Option<i64>,
}
