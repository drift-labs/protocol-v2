use anchor_lang::prelude::*;
use solana_program::msg;
use std::cmp::max;
use switchboard_v2::decimal::SwitchboardDecimal;
use switchboard_v2::AggregatorAccountData;

use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm;
use crate::math::casting::{cast, cast_to_i128, cast_to_i64, cast_to_u128};
use crate::math::constants::AMM_RESERVE_PRECISION;
use crate::math::constants::LIQUIDATION_FEE_PRECISION;
use crate::math::margin::{
    calculate_size_discount_asset_weight, calculate_size_premium_liability_weight,
    MarginRequirementType,
};
use crate::math_error;
use crate::state::bank::{BankBalance, BankBalanceType};
use crate::state::oracle::{OraclePriceData, OracleSource};
use crate::state::user::MarketPosition;
use crate::{
    AMM_TO_QUOTE_PRECISION_RATIO, BID_ASK_SPREAD_PRECISION, MARGIN_PRECISION, MARK_PRICE_PRECISION,
};

#[account(zero_copy)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(packed)]
pub struct Market {
    pub market_index: u64,
    pub pubkey: Pubkey,
    pub initialized: bool,
    pub amm: AMM,
    pub base_asset_amount_long: i128,
    pub base_asset_amount_short: i128,
    pub open_interest: u128, // number of users in a position
    pub margin_ratio_initial: u32,
    pub margin_ratio_maintenance: u32,
    pub next_fill_record_id: u64,
    pub next_funding_rate_record_id: u64,
    pub next_curve_record_id: u64,
    pub pnl_pool: PoolBalance,
    pub revenue_withdraw_since_last_settle: u128,
    pub max_revenue_withdraw_per_period: u128,
    pub last_revenue_withdraw_ts: i64,
    pub imf_factor: u128,
    pub unrealized_initial_asset_weight: u8,
    pub unrealized_maintenance_asset_weight: u8,
    pub unrealized_imf_factor: u128,
    pub liquidation_fee: u128,

    // upgrade-ability
    pub padding0: u32,
    pub padding1: u128,
    pub padding2: u128,
    pub padding3: u128,
    pub padding4: u128,
}

impl Market {
    pub fn get_margin_ratio(
        &self,
        size: u128,
        margin_type: MarginRequirementType,
    ) -> ClearingHouseResult<u32> {
        let margin_ratio = match margin_type {
            MarginRequirementType::Initial => max(
                self.margin_ratio_initial as u128,
                calculate_size_premium_liability_weight(
                    size,
                    self.imf_factor,
                    self.margin_ratio_initial as u128,
                    MARGIN_PRECISION,
                )?,
            ),
            MarginRequirementType::Maintenance => self.margin_ratio_maintenance as u128,
        };

        Ok(margin_ratio as u32)
    }

    pub fn default_test() -> Self {
        let amm = AMM::default_test();
        Market {
            amm,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            ..Market::default()
        }
    }

    pub fn default_btc_test() -> Self {
        let amm = AMM::default_btc_test();
        Market {
            amm,
            margin_ratio_initial: 1000,    // 10x
            margin_ratio_maintenance: 500, // 5x
            ..Market::default()
        }
    }

    pub fn get_unrealized_asset_weight(
        &self,
        unrealized_pnl: i128,
        margin_type: MarginRequirementType,
    ) -> ClearingHouseResult<u128> {
        // the asset weight for a position's unrealized pnl in the margin system
        // > 0 (positive balance)
        // < 0 (negative balance) always has asset weight = 1
        let unrealized_asset_weight = if unrealized_pnl > 0 {
            // todo: only discount the initial margin s.t. no one gets liquidated over upnl?

            // a larger imf factor -> lower asset weight
            match margin_type {
                MarginRequirementType::Initial => calculate_size_discount_asset_weight(
                    unrealized_pnl
                        .unsigned_abs()
                        .checked_mul(AMM_TO_QUOTE_PRECISION_RATIO)
                        .ok_or_else(math_error!())?,
                    self.unrealized_imf_factor,
                    self.unrealized_initial_asset_weight as u128,
                )?,
                MarginRequirementType::Maintenance => {
                    self.unrealized_maintenance_asset_weight as u128
                }
            }
        } else {
            100
        };

        Ok(unrealized_asset_weight)
    }

    pub fn get_liquidation_fee_multiplier(
        &self,
        base_asset_amount: i128,
    ) -> ClearingHouseResult<u128> {
        if base_asset_amount >= 0 {
            LIQUIDATION_FEE_PRECISION
                .checked_sub(self.liquidation_fee)
                .ok_or_else(math_error!())
        } else {
            LIQUIDATION_FEE_PRECISION
                .checked_add(self.liquidation_fee)
                .ok_or_else(math_error!())
        }
    }
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
pub struct PoolBalance {
    pub balance: u128,
}

impl BankBalance for PoolBalance {
    fn balance_type(&self) -> &BankBalanceType {
        &BankBalanceType::Deposit
    }

    fn balance(&self) -> u128 {
        self.balance
    }

    fn increase_balance(&mut self, delta: u128) -> ClearingHouseResult {
        self.balance = self.balance.checked_add(delta).ok_or_else(math_error!())?;
        Ok(())
    }

    fn decrease_balance(&mut self, delta: u128) -> ClearingHouseResult {
        self.balance = self.balance.checked_sub(delta).ok_or_else(math_error!())?;
        Ok(())
    }

    fn update_balance_type(&mut self, _balance_type: BankBalanceType) -> ClearingHouseResult {
        Err(ErrorCode::CantUpdatePoolBalanceType)
    }
}

#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
#[repr(packed)]
pub struct AMM {
    // oracle
    pub oracle: Pubkey,
    pub oracle_source: OracleSource,
    pub last_oracle_price: i128,
    pub last_oracle_conf_pct: u64,
    pub last_oracle_delay: i64,
    pub last_oracle_normalised_price: i128,
    pub last_oracle_price_twap: i128,
    pub last_oracle_price_twap_5min: i128,
    pub last_oracle_price_twap_ts: i64,
    pub last_oracle_mark_spread_pct: i128,

    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
    pub min_base_asset_reserve: u128,
    pub max_base_asset_reserve: u128,
    pub sqrt_k: u128,
    pub peg_multiplier: u128,

    pub terminal_quote_asset_reserve: u128,
    pub net_base_asset_amount: i128,
    pub quote_asset_amount_long: i128,
    pub quote_asset_amount_short: i128,
    pub quote_entry_amount_long: i128,
    pub quote_entry_amount_short: i128,

    // lp stuff
    pub net_unsettled_lp_base_asset_amount: i128,
    pub lp_cooldown_time: i64,
    pub user_lp_shares: u128,
    pub market_position_per_lp: MarketPosition,
    pub amm_jit_intensity: u8,

    // funding
    pub last_funding_rate: i128,
    pub last_funding_rate_long: i128,
    pub last_funding_rate_short: i128,
    pub last_funding_rate_ts: i64,
    pub funding_period: i64,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub cumulative_repeg_rebate_long: u128,
    pub cumulative_repeg_rebate_short: u128,

    pub mark_std: u64,
    pub last_mark_price_twap: u128,
    pub last_mark_price_twap_5min: u128,
    pub last_mark_price_twap_ts: i64,

    // trade constraints
    pub minimum_quote_asset_trade_size: u128,
    pub max_base_asset_amount_ratio: u16,
    pub max_slippage_ratio: u16,
    pub base_asset_amount_step_size: u128,

    // market making
    pub market_position: MarketPosition,
    pub base_spread: u16,
    pub long_spread: u128,
    pub short_spread: u128,
    pub max_spread: u32,
    pub ask_base_asset_reserve: u128,
    pub ask_quote_asset_reserve: u128,
    pub bid_base_asset_reserve: u128,
    pub bid_quote_asset_reserve: u128,

    pub last_bid_price_twap: u128,
    pub last_ask_price_twap: u128,

    pub long_intensity_count: u16,
    pub long_intensity_volume: u64,
    pub short_intensity_count: u16,
    pub short_intensity_volume: u64,
    pub curve_update_intensity: u8,

    // fee tracking
    pub total_fee: i128,
    pub total_mm_fee: i128,
    pub total_exchange_fee: u128,
    pub total_fee_minus_distributions: i128,
    pub total_fee_withdrawn: u128,
    pub net_revenue_since_last_funding: i64,
    pub fee_pool: PoolBalance,
    pub last_update_slot: u64,
    pub last_oracle_valid: bool,

    pub padding0: u16,
    pub padding1: u32,
    pub padding2: u128,
    pub padding3: u128,
}

impl AMM {
    pub fn default_test() -> Self {
        let default_reserves = 100 * AMM_RESERVE_PRECISION;
        // make sure tests dont have the default sqrt_k = 0
        AMM {
            base_asset_reserve: default_reserves,
            quote_asset_reserve: default_reserves,
            sqrt_k: default_reserves,
            base_asset_amount_step_size: 1,
            max_base_asset_reserve: u128::MAX,
            min_base_asset_reserve: 0,
            terminal_quote_asset_reserve: default_reserves,
            peg_multiplier: crate::math::constants::PEG_PRECISION,
            max_spread: 1000,
            last_oracle_price: MARK_PRICE_PRECISION as i128,
            last_oracle_valid: true,
            ..AMM::default()
        }
    }

    pub fn default_btc_test() -> Self {
        AMM {
            base_asset_reserve: 65 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 630153846154000,
            terminal_quote_asset_reserve: 64 * AMM_RESERVE_PRECISION,
            sqrt_k: 64 * AMM_RESERVE_PRECISION,

            peg_multiplier: 19_400_000,

            max_base_asset_reserve: 90 * AMM_RESERVE_PRECISION,
            min_base_asset_reserve: 45 * AMM_RESERVE_PRECISION,

            net_base_asset_amount: -(AMM_RESERVE_PRECISION as i128),
            mark_std: MARK_PRICE_PRECISION as u64,

            last_oracle_price_twap_ts: 1662800000,
            last_mark_price_twap_ts: 1662800000,
            last_oracle_price_twap: (19_400 * MARK_PRICE_PRECISION) as i128,
            curve_update_intensity: 100,

            base_spread: 250,
            max_spread: 975,

            last_oracle_valid: true,
            ..AMM::default()
        }
    }

    pub fn amm_jit_is_active(&self) -> bool {
        self.amm_jit_intensity > 0
    }

    pub fn mark_price(&self) -> ClearingHouseResult<u128> {
        amm::calculate_price(
            self.quote_asset_reserve,
            self.base_asset_reserve,
            self.peg_multiplier,
        )
    }

    pub fn bid_price(&self, mark_price: u128) -> ClearingHouseResult<u128> {
        let bid_price = mark_price
            .checked_mul(
                BID_ASK_SPREAD_PRECISION
                    .checked_sub(self.short_spread)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;

        Ok(bid_price)
    }

    pub fn ask_price(&self, mark_price: u128) -> ClearingHouseResult<u128> {
        let ask_price = mark_price
            .checked_mul(
                BID_ASK_SPREAD_PRECISION
                    .checked_add(self.long_spread)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;

        Ok(ask_price)
    }

    pub fn bid_ask_price(&self, mark_price: u128) -> ClearingHouseResult<(u128, u128)> {
        let bid_price = self.bid_price(mark_price)?;
        let ask_price = self.ask_price(mark_price)?;
        Ok((bid_price, ask_price))
    }

    pub fn get_oracle_price(
        &self,
        price_oracle: &AccountInfo,
        clock_slot: u64,
    ) -> ClearingHouseResult<OraclePriceData> {
        match self.oracle_source {
            OracleSource::Pyth => self.get_pyth_price(price_oracle, clock_slot),
            OracleSource::Switchboard => self.get_switchboard_price(price_oracle, clock_slot),
            OracleSource::QuoteAsset => panic!(),
        }
    }

    pub fn can_lower_k(&self) -> ClearingHouseResult<bool> {
        let can_lower = self.net_base_asset_amount.unsigned_abs() < self.sqrt_k / 4;
        Ok(can_lower)
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
            OracleSource::QuoteAsset => panic!(),
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
