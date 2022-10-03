use anchor_lang::prelude::*;
use solana_program::msg;
use std::cmp::max;

use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128, cast_to_u32};
use crate::math::constants::{
    AMM_RESERVE_PRECISION, LIQUIDATION_FEE_PRECISION, SPOT_WEIGHT_PRECISION, TWENTY_FOUR_HOUR,
};
use crate::math::margin::{
    calculate_size_discount_asset_weight, calculate_size_premium_liability_weight,
    MarginRequirementType,
};
use crate::math_error;
use crate::state::oracle::{HistoricalOracleData, OracleSource};
use crate::state::spot_market::{SpotBalance, SpotBalanceType};
use crate::state::user::PerpPosition;
use crate::{
    AMM_TO_QUOTE_PRECISION_RATIO, BID_ASK_SPREAD_PRECISION, MARGIN_PRECISION,
    MAX_CONCENTRATION_COEFFICIENT, PRICE_PRECISION,
};
use borsh::{BorshDeserialize, BorshSerialize};

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum MarketStatus {
    Initialized,
    ReduceOnly,
    Settlement,
    Delisted,
}

impl Default for MarketStatus {
    fn default() -> Self {
        MarketStatus::Initialized
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum ContractType {
    Perpetual,
    Future,
}

impl Default for ContractType {
    fn default() -> Self {
        ContractType::Perpetual
    }
}

#[account(zero_copy)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(packed)]
pub struct PerpMarket {
    pub market_index: u16,
    pub pubkey: Pubkey,
    pub status: MarketStatus,
    pub contract_type: ContractType,
    pub settlement_price: i128, // iff market has expired, price users can settle position
    pub expiry_ts: i64,         // iff market in reduce only mode
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
    pub unrealized_initial_asset_weight: u32,
    pub unrealized_maintenance_asset_weight: u32,
    pub unrealized_imf_factor: u128,
    pub unrealized_max_imbalance: u128,
    pub liquidator_fee: u128,
    pub if_liquidation_fee: u128,
    pub quote_max_insurance: u128,
    pub quote_settled_insurance: u128,
    // upgrade-ability
    pub padding0: u32,
    pub padding1: u128,
    pub padding2: u128,
    pub padding3: u128,
    pub padding4: u128,
}

impl PerpMarket {
    pub fn is_active(&self, now: i64) -> ClearingHouseResult<bool> {
        let status_ok = self.status != MarketStatus::Settlement;
        let is_active = self.expiry_ts == 0 || self.expiry_ts < now;
        Ok(is_active && status_ok)
    }

    pub fn is_reduce_only(&self) -> ClearingHouseResult<bool> {
        Ok(self.status == MarketStatus::ReduceOnly)
    }

    pub fn get_margin_ratio(
        &self,
        size: u128,
        margin_type: MarginRequirementType,
    ) -> ClearingHouseResult<u32> {
        let default_margin_ratio = match margin_type {
            MarginRequirementType::Initial => cast_to_u128(self.margin_ratio_initial)?,
            MarginRequirementType::Maintenance => cast_to_u128(self.margin_ratio_maintenance)?,
        };

        let size_adj_margin_ratio = calculate_size_premium_liability_weight(
            size,
            self.imf_factor,
            default_margin_ratio,
            MARGIN_PRECISION,
        )?;

        let margin_ratio = default_margin_ratio.max(size_adj_margin_ratio);

        cast_to_u32(margin_ratio)
    }

    pub fn get_initial_leverage_ratio(&self, margin_type: MarginRequirementType) -> u128 {
        match margin_type {
            MarginRequirementType::Initial => {
                MARGIN_PRECISION * MARGIN_PRECISION / self.margin_ratio_initial as u128
            }
            MarginRequirementType::Maintenance => {
                MARGIN_PRECISION * MARGIN_PRECISION / self.margin_ratio_maintenance as u128
            }
        }
    }

    pub fn default_test() -> Self {
        let amm = AMM::default_test();
        PerpMarket {
            amm,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            ..PerpMarket::default()
        }
    }

    pub fn default_btc_test() -> Self {
        let amm = AMM::default_btc_test();
        PerpMarket {
            amm,
            margin_ratio_initial: 1000,    // 10x
            margin_ratio_maintenance: 500, // 5x
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        }
    }

    pub fn get_unrealized_asset_weight(
        &self,
        unrealized_pnl: i128,
        margin_type: MarginRequirementType,
    ) -> ClearingHouseResult<u128> {
        let mut margin_asset_weight = match margin_type {
            MarginRequirementType::Initial => self.unrealized_initial_asset_weight as u128,
            MarginRequirementType::Maintenance => self.unrealized_maintenance_asset_weight as u128,
        };

        if margin_type == MarginRequirementType::Initial && self.unrealized_max_imbalance > 0 {
            let net_unsettled_pnl = amm::calculate_net_user_pnl(
                &self.amm,
                self.amm.historical_oracle_data.last_oracle_price,
            )?;
            if net_unsettled_pnl > cast_to_i128(self.unrealized_max_imbalance)? {
                margin_asset_weight = margin_asset_weight
                    .checked_mul(self.unrealized_max_imbalance)
                    .ok_or_else(math_error!())?
                    .checked_div(net_unsettled_pnl.unsigned_abs())
                    .ok_or_else(math_error!())?
            }
        }

        // the asset weight for a position's unrealized pnl + unsettled pnl in the margin system
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
                    margin_asset_weight,
                )?,
                MarginRequirementType::Maintenance => {
                    self.unrealized_maintenance_asset_weight as u128
                }
            }
        } else {
            SPOT_WEIGHT_PRECISION
        };

        Ok(unrealized_asset_weight)
    }

    pub fn get_liquidation_fee_multiplier(
        &self,
        base_asset_amount: i128,
    ) -> ClearingHouseResult<u128> {
        if base_asset_amount >= 0 {
            LIQUIDATION_FEE_PRECISION
                .checked_sub(self.liquidator_fee)
                .ok_or_else(math_error!())
        } else {
            LIQUIDATION_FEE_PRECISION
                .checked_add(self.liquidator_fee)
                .ok_or_else(math_error!())
        }
    }
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(packed)]
pub struct PoolBalance {
    pub market_index: u16,
    pub balance: u128,
}

impl SpotBalance for PoolBalance {
    fn market_index(&self) -> u16 {
        self.market_index
    }

    fn balance_type(&self) -> &SpotBalanceType {
        &SpotBalanceType::Deposit
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

    fn update_balance_type(&mut self, _balance_type: SpotBalanceType) -> ClearingHouseResult {
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
    pub historical_oracle_data: HistoricalOracleData,
    pub last_oracle_valid: bool,
    pub last_update_slot: u64,
    pub last_oracle_conf_pct: u64,
    pub last_oracle_normalised_price: i128,
    pub last_oracle_reserve_price_spread_pct: i128,

    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
    pub concentration_coef: u128,
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
    pub market_position_per_lp: PerpPosition,
    pub amm_jit_intensity: u8,

    // funding
    pub last_funding_rate: i128,
    pub last_funding_rate_long: i128,
    pub last_funding_rate_short: i128,
    pub last_24h_avg_funding_rate: i128,
    pub last_funding_rate_ts: i64,
    pub funding_period: i64,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub cumulative_social_loss: i128,

    // trade constraints
    pub minimum_quote_asset_trade_size: u128,
    pub max_base_asset_amount_ratio: u16,
    pub max_slippage_ratio: u16,
    pub base_asset_amount_step_size: u64,

    // market making
    pub market_position: PerpPosition,
    pub base_spread: u16,
    pub long_spread: u128,
    pub short_spread: u128,
    pub max_spread: u32,
    pub ask_base_asset_reserve: u128,
    pub ask_quote_asset_reserve: u128,
    pub bid_base_asset_reserve: u128,
    pub bid_quote_asset_reserve: u128,

    pub volume_24h: u64,
    pub long_intensity_count: u16,
    pub long_intensity_volume: u64,
    pub short_intensity_count: u16,
    pub short_intensity_volume: u64,
    pub curve_update_intensity: u8,
    pub last_trade_ts: i64,

    pub mark_std: u64,
    pub last_bid_price_twap: u128,
    pub last_ask_price_twap: u128,
    pub last_mark_price_twap: u128,
    pub last_mark_price_twap_5min: u128,
    pub last_mark_price_twap_ts: i64,

    // fee tracking
    pub total_fee: i128,
    pub total_mm_fee: i128,
    pub total_exchange_fee: u128,
    pub total_fee_minus_distributions: i128,
    pub total_fee_withdrawn: u128,
    pub net_revenue_since_last_funding: i64,
    pub total_liquidation_fee: u128,
    pub fee_pool: PoolBalance,

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
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            base_asset_amount_step_size: 1,
            max_base_asset_reserve: u64::MAX as u128,
            min_base_asset_reserve: 0,
            terminal_quote_asset_reserve: default_reserves,
            peg_multiplier: crate::math::constants::PEG_PRECISION,
            max_spread: 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: PRICE_PRECISION as i128,
                ..HistoricalOracleData::default()
            },
            last_oracle_valid: true,
            ..AMM::default()
        }
    }

    pub fn default_btc_test() -> Self {
        AMM {
            base_asset_reserve: 65 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 63015384615,
            terminal_quote_asset_reserve: 64 * AMM_RESERVE_PRECISION,
            sqrt_k: 64 * AMM_RESERVE_PRECISION,

            peg_multiplier: 19_400_000_000,

            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            max_base_asset_reserve: 90 * AMM_RESERVE_PRECISION,
            min_base_asset_reserve: 45 * AMM_RESERVE_PRECISION,

            net_base_asset_amount: -(AMM_RESERVE_PRECISION as i128),
            mark_std: PRICE_PRECISION as u64,

            quote_asset_amount_long: 0,
            quote_asset_amount_short: 19_000_000_000, // short 1 BTC @ $19000
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: (19_400 * PRICE_PRECISION) as i128,
                last_oracle_price_twap: (19_400 * PRICE_PRECISION) as i128,
                last_oracle_price_twap_ts: 1662800000_i64,
                ..HistoricalOracleData::default()
            },
            last_mark_price_twap_ts: 1662800000,

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

    pub fn reserve_price(&self) -> ClearingHouseResult<u128> {
        amm::calculate_price(
            self.quote_asset_reserve,
            self.base_asset_reserve,
            self.peg_multiplier,
        )
    }

    pub fn bid_price(&self, reserve_price: u128) -> ClearingHouseResult<u128> {
        let bid_price = reserve_price
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

    pub fn ask_price(&self, reserve_price: u128) -> ClearingHouseResult<u128> {
        let ask_price = reserve_price
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

    pub fn bid_ask_price(&self, reserve_price: u128) -> ClearingHouseResult<(u128, u128)> {
        let bid_price = self.bid_price(reserve_price)?;
        let ask_price = self.ask_price(reserve_price)?;
        Ok((bid_price, ask_price))
    }

    pub fn can_lower_k(&self) -> ClearingHouseResult<bool> {
        let can_lower = self.net_base_asset_amount.unsigned_abs() < self.sqrt_k / 4;
        Ok(can_lower)
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

        assert!(oracle_twap > cast_to_i128(price_data.agg.price)? / 10);

        let oracle_precision = 10_u128.pow(price_data.expo.unsigned_abs());

        let mut oracle_scale_mult = 1;
        let mut oracle_scale_div = 1;

        if oracle_precision > PRICE_PRECISION {
            oracle_scale_div = oracle_precision
                .checked_div(PRICE_PRECISION)
                .ok_or_else(math_error!())?;
        } else {
            oracle_scale_mult = PRICE_PRECISION
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

    pub fn update_volume_24h(
        &mut self,
        quote_asset_amount: u64,
        position_direction: PositionDirection,
        now: i64,
    ) -> ClearingHouseResult {
        let since_last = cast_to_i128(max(
            1,
            now.checked_sub(self.last_trade_ts)
                .ok_or_else(math_error!())?,
        ))?;

        amm::update_amm_long_short_intensity(self, now, quote_asset_amount, position_direction)?;

        self.volume_24h = amm::calculate_rolling_sum(
            self.volume_24h,
            quote_asset_amount,
            since_last,
            TWENTY_FOUR_HOUR as i128,
        )?;

        self.last_trade_ts = now;

        Ok(())
    }
}
