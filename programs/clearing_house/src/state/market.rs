use std::cell::{Ref, RefMut};
use std::cmp::max;
use std::collections::{BTreeMap, BTreeSet};
use std::iter::Peekable;
use std::slice::Iter;

use anchor_lang::prelude::*;
use solana_program::msg;
use switchboard_v2::decimal::SwitchboardDecimal;
use switchboard_v2::AggregatorAccountData;

use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm;
use crate::math::casting::{cast, cast_to_i128, cast_to_i64, cast_to_u128};
use crate::math::margin::MarginType;
use crate::math_error;
use crate::state::user::UserPositions;
use crate::MARK_PRICE_PRECISION;
use anchor_lang::{AccountsExit, Discriminator};
use arrayref::array_ref;

#[zero_copy]
#[derive(Default)]
#[repr(packed)]
pub struct DeprecatedMarket {
    pub initialized: bool,
    pub base_asset_amount_long: i128,
    pub base_asset_amount_short: i128,
    pub base_asset_amount: i128,
    // net market bias
    pub open_interest: u128,
    // number of users in a position
    pub amm: AMM,
    pub margin_ratio_initial: u32,
    pub margin_ratio_partial: u32,
    pub margin_ratio_maintenance: u32,

    // upgrade-ability
    pub padding0: u32,
    pub padding1: u128,
    pub padding2: u128,
    pub padding3: u128,
    pub padding4: u128,
}

#[account(zero_copy)]
#[derive(Default)]
#[repr(packed)]
pub struct Market {
    pub market_index: u64,
    pub initialized: bool,
    pub amm: AMM,
    pub base_asset_amount_long: i128,
    pub base_asset_amount_short: i128,
    pub base_asset_amount: i128, // net market bias
    pub open_interest: u128,     // number of users in a position
    pub margin_ratio_initial: u32,
    pub margin_ratio_partial: u32,
    pub margin_ratio_maintenance: u32,

    // upgrade-ability
    pub padding0: u32,
    pub padding1: u128,
    pub padding2: u128,
    pub padding3: u128,
    pub padding4: u128,
}

impl DeprecatedMarket {
    pub fn get_margin_ratio(&self, margin_type: MarginType) -> u32 {
        match margin_type {
            MarginType::Init => self.margin_ratio_initial,
            MarginType::Partial => self.margin_ratio_partial,
            MarginType::Maint => self.margin_ratio_maintenance,
        }
    }
}

impl Market {
    pub fn get_margin_ratio(&self, margin_type: MarginType) -> u32 {
        match margin_type {
            MarginType::Init => self.margin_ratio_initial,
            MarginType::Partial => self.margin_ratio_partial,
            MarginType::Maint => self.margin_ratio_maintenance,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum OracleSource {
    Pyth,
    Switchboard,
}

impl Default for OracleSource {
    // UpOnly
    fn default() -> Self {
        OracleSource::Pyth
    }
}

#[zero_copy]
#[derive(Default)]
#[repr(packed)]
pub struct AMM {
    pub oracle: Pubkey,
    pub oracle_source: OracleSource,
    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
    pub cumulative_repeg_rebate_long: u128,
    pub cumulative_repeg_rebate_short: u128,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub last_funding_rate: i128,
    pub last_funding_rate_ts: i64,
    pub funding_period: i64,
    pub last_oracle_price_twap: i128,
    pub last_mark_price_twap: u128,
    pub last_mark_price_twap_ts: i64,
    pub sqrt_k: u128,
    pub peg_multiplier: u128,
    pub total_fee: u128,
    pub total_fee_minus_distributions: u128,
    pub total_fee_withdrawn: u128,
    pub minimum_quote_asset_trade_size: u128,
    pub last_oracle_price_twap_ts: i64,
    pub last_oracle_price: i128,
    pub minimum_base_asset_trade_size: u128,
    pub base_spread: u16,

    pub padding0: u16,
    pub padding1: u32,
    pub padding2: u128,
    pub padding3: u128,
}

impl AMM {
    pub fn mark_price(&self) -> ClearingHouseResult<u128> {
        amm::calculate_price(
            self.quote_asset_reserve,
            self.base_asset_reserve,
            self.peg_multiplier,
        )
    }

    pub fn get_oracle_price(
        &self,
        price_oracle: &AccountInfo,
        clock_slot: u64,
    ) -> ClearingHouseResult<OraclePriceData> {
        match self.oracle_source {
            OracleSource::Pyth => self.get_pyth_price(price_oracle, clock_slot),
            OracleSource::Switchboard => self.get_switchboard_price(price_oracle, clock_slot),
        }
    }

    pub fn get_pyth_price(
        &self,
        price_oracle: &AccountInfo,
        clock_slot: u64,
    ) -> ClearingHouseResult<OraclePriceData> {
        let pyth_price_data = price_oracle
            .try_borrow_data()
            .or(Err(ErrorCode::UnableToLoadOracle))?;
        let price_data = pyth_client::cast::<pyth_client::Price>(&pyth_price_data);

        let oracle_price = cast_to_i128(price_data.agg.price)?;
        let oracle_conf = cast_to_u128(price_data.agg.conf)?;

        let oracle_precision = 10_u128.pow(price_data.expo.unsigned_abs());

        let mut oracle_scale_mult = 1;
        let mut oracle_scale_div = 1;

        if oracle_precision > MARK_PRICE_PRECISION {
            oracle_scale_div = oracle_precision
                .checked_div(MARK_PRICE_PRECISION)
                .ok_or_else(math_error!())?;
        } else {
            oracle_scale_mult = MARK_PRICE_PRECISION
                .checked_div(oracle_precision)
                .ok_or_else(math_error!())?;
        }

        let oracle_price_scaled = (oracle_price)
            .checked_mul(cast(oracle_scale_mult)?)
            .ok_or_else(math_error!())?
            .checked_div(cast(oracle_scale_div)?)
            .ok_or_else(math_error!())?;

        let oracle_conf_scaled = (oracle_conf)
            .checked_mul(oracle_scale_mult)
            .ok_or_else(math_error!())?
            .checked_div(oracle_scale_div)
            .ok_or_else(math_error!())?;

        let oracle_delay: i64 = cast_to_i64(clock_slot)?
            .checked_sub(cast(price_data.valid_slot)?)
            .ok_or_else(math_error!())?;

        Ok(OraclePriceData {
            price: oracle_price_scaled,
            confidence: oracle_conf_scaled,
            delay: oracle_delay,
            has_sufficient_number_of_data_points: true,
        })
    }

    pub fn get_switchboard_price(
        &self,
        price_oracle: &AccountInfo,
        clock_slot: u64,
    ) -> ClearingHouseResult<OraclePriceData> {
        let aggregator_data =
            AggregatorAccountData::new(price_oracle).or(Err(ErrorCode::UnableToLoadOracle))?;

        let price = convert_switchboard_decimal(&aggregator_data.latest_confirmed_round.result)?;
        let confidence =
            convert_switchboard_decimal(&aggregator_data.latest_confirmed_round.std_deviation)?;

        // std deviation should always be positive, if we get a negative make it u128::MAX so it's flagged as bad value
        let confidence = if confidence < 0 {
            u128::MAX
        } else {
            let price_10bps = price
                .unsigned_abs()
                .checked_div(1000)
                .ok_or_else(math_error!())?;
            max(confidence.unsigned_abs(), price_10bps)
        };

        let delay: i64 = cast_to_i64(clock_slot)?
            .checked_sub(cast(
                aggregator_data.latest_confirmed_round.round_open_slot,
            )?)
            .ok_or_else(math_error!())?;

        let has_sufficient_number_of_data_points =
            aggregator_data.latest_confirmed_round.num_success
                >= aggregator_data.min_oracle_results;

        Ok(OraclePriceData {
            price,
            confidence,
            delay,
            has_sufficient_number_of_data_points,
        })
    }

    pub fn get_oracle_twap(&self, price_oracle: &AccountInfo) -> ClearingHouseResult<Option<i128>> {
        match self.oracle_source {
            OracleSource::Pyth => Ok(Some(self.get_pyth_twap(price_oracle)?)),
            OracleSource::Switchboard => Ok(None),
        }
    }

    pub fn get_pyth_twap(&self, price_oracle: &AccountInfo) -> ClearingHouseResult<i128> {
        let pyth_price_data = price_oracle
            .try_borrow_data()
            .or(Err(ErrorCode::UnableToLoadOracle))?;
        let price_data = pyth_client::cast::<pyth_client::Price>(&pyth_price_data);

        let oracle_twap = cast_to_i128(price_data.twap.val)?;

        let oracle_precision = 10_u128.pow(price_data.expo.unsigned_abs());

        let mut oracle_scale_mult = 1;
        let mut oracle_scale_div = 1;

        if oracle_precision > MARK_PRICE_PRECISION {
            oracle_scale_div = oracle_precision
                .checked_div(MARK_PRICE_PRECISION)
                .ok_or_else(math_error!())?;
        } else {
            oracle_scale_mult = MARK_PRICE_PRECISION
                .checked_div(oracle_precision)
                .ok_or_else(math_error!())?;
        }

        let oracle_twap_scaled = (oracle_twap)
            .checked_mul(cast(oracle_scale_mult)?)
            .ok_or_else(math_error!())?
            .checked_div(cast(oracle_scale_div)?)
            .ok_or_else(math_error!())?;

        Ok(oracle_twap_scaled)
    }
}

#[derive(Default, Clone, Copy, Debug)]
pub struct OraclePriceData {
    pub price: i128,
    pub confidence: u128,
    pub delay: i64,
    pub has_sufficient_number_of_data_points: bool,
}

/// Given a decimal number represented as a mantissa (the digits) plus an
/// original_precision (10.pow(some number of decimals)), scale the
/// mantissa/digits to make sense with a new_precision.
fn convert_switchboard_decimal(
    switchboard_decimal: &SwitchboardDecimal,
) -> ClearingHouseResult<i128> {
    let switchboard_precision = 10_u128.pow(switchboard_decimal.scale);
    if switchboard_precision > MARK_PRICE_PRECISION {
        switchboard_decimal
            .mantissa
            .checked_div((switchboard_precision / MARK_PRICE_PRECISION) as i128)
            .ok_or_else(math_error!())
    } else {
        switchboard_decimal
            .mantissa
            .checked_mul((MARK_PRICE_PRECISION / switchboard_precision) as i128)
            .ok_or_else(math_error!())
    }
}

pub type WritableMarkets = BTreeSet<u64>;
pub type MarketOracles<'a, 'b> = BTreeMap<u64, &'a AccountInfo<'b>>;

pub struct MarketMap<'a>(pub BTreeMap<u64, AccountLoader<'a, Market>>);

impl MarketMap<'_> {
    pub fn get_ref(&self, market_index: &u64) -> ClearingHouseResult<Ref<Market>> {
        self.0
            .get(market_index)
            .ok_or(ErrorCode::MarketNotFound)?
            .load()
            .or(Err(ErrorCode::UnableToLoadMarketAccount))
    }

    pub fn get_ref_mut(&self, market_index: &u64) -> ClearingHouseResult<RefMut<Market>> {
        self.0
            .get(market_index)
            .ok_or(ErrorCode::MarketNotFound)?
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadMarketAccount))
    }

    pub fn write_accounts(
        &self,
        account_info_map: &WritableMarkets,
        program_id: &Pubkey,
    ) -> ClearingHouseResult {
        for (market_index, account_loader) in &self.0 {
            if account_info_map.contains(market_index) {
                account_loader
                    .exit(program_id)
                    .or(Err(ErrorCode::UnableToWriteMarket))?;
            }
        }

        Ok(())
    }
}

pub fn get_writable_markets_for_user_positions(user_positions: &UserPositions) -> WritableMarkets {
    let mut writable_markets = WritableMarkets::new();
    for position in user_positions.positions.iter() {
        writable_markets.insert(position.market_index);
    }
    writable_markets
}

pub fn get_market_map<'a, 'b, 'c>(
    writable_markets: &'a WritableMarkets,
    market_oracles: &MarketOracles,
    account_info_iter: &'b mut Peekable<Iter<AccountInfo<'c>>>,
) -> ClearingHouseResult<MarketMap<'c>> {
    let mut market_map: MarketMap = MarketMap(BTreeMap::new());

    let market_discriminator: [u8; 8] = Market::discriminator();
    while let Some(account_info) = account_info_iter.peek() {
        let data = account_info
            .try_borrow_data()
            .or(Err(ErrorCode::CouldNotLoadMarketData))?;

        if data.len() < std::mem::size_of::<Market>() + 8 {
            break;
        }

        let account_discriminator = array_ref![data, 0, 8];
        if account_discriminator != &market_discriminator {
            break;
        }
        let market_index = u64::from_le_bytes(*array_ref![data, 8, 8]);
        let is_initialized = array_ref![data, 16, 1];
        let market_oracle = Pubkey::new(array_ref![data, 17, 32]);

        let account_info = account_info_iter.next().unwrap();
        let is_writable = account_info.is_writable;
        let account_loader: AccountLoader<Market> =
            AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidMarketAccount))?;

        if writable_markets.contains(&market_index) && !is_writable {
            return Err(ErrorCode::MarketWrongMutability);
        }

        if is_initialized != &[1] {
            return Err(ErrorCode::MarketIndexNotInitialized);
        }

        if let Some(oracle_account_info) = market_oracles.get(&market_index) {
            if !oracle_account_info.key.eq(&market_oracle) {
                return Err(ErrorCode::InvalidOracle);
            }
        }

        market_map.0.insert(market_index, account_loader);
    }

    Ok(market_map)
}
