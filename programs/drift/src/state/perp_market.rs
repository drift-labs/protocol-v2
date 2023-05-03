use anchor_lang::prelude::*;

use std::cmp::max;

use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::amm;
use crate::math::casting::Cast;
#[cfg(test)]
use crate::math::constants::{
    AMM_RESERVE_PRECISION, MAX_CONCENTRATION_COEFFICIENT, PRICE_PRECISION_I64,
};
use crate::math::constants::{
    BID_ASK_SPREAD_PRECISION_U128, MARGIN_PRECISION_U128, QUOTE_PRECISION, SPOT_WEIGHT_PRECISION,
    TWENTY_FOUR_HOUR,
};

use crate::math::margin::{
    calculate_size_discount_asset_weight, calculate_size_premium_liability_weight,
    MarginRequirementType,
};
use crate::math::safe_math::SafeMath;
use crate::math::stats;

use crate::state::oracle::{HistoricalOracleData, OracleSource};
use crate::state::spot_market::{AssetTier, SpotBalance, SpotBalanceType};
use crate::state::traits::{MarketIndexOffset, Size};
use crate::{AMM_TO_QUOTE_PRECISION_RATIO, PRICE_PRECISION};
use borsh::{BorshDeserialize, BorshSerialize};

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum MarketStatus {
    Initialized,    // warm up period for initialization, fills are paused
    Active,         // all operations allowed
    FundingPaused,  // perp: pause funding rate updates | spot: pause interest updates
    AmmPaused,      // amm fills are prevented/blocked
    FillPaused,     // fills are blocked
    WithdrawPaused, // perp: pause settling positive pnl | spot: pause withdrawing asset
    ReduceOnly,     // fills only able to reduce liability
    Settlement, // market has determined settlement price and positions are expired must be settled
    Delisted,   // market has no remaining participants
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

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq, PartialOrd, Ord)]
pub enum ContractTier {
    A,           // max insurance capped at A level
    B,           // max insurance capped at B level
    C,           // max insurance capped at C level
    Speculative, // no insurance
    Isolated,    // no insurance, only single position allowed
}

impl ContractTier {
    pub fn default() -> Self {
        ContractTier::Speculative
    }

    pub fn is_as_safe_as(&self, best_contract: &ContractTier, best_asset: &AssetTier) -> bool {
        self.is_as_safe_as_contract(best_contract) && self.is_as_safe_as_asset(best_asset)
    }

    pub fn is_as_safe_as_contract(&self, other: &ContractTier) -> bool {
        // Contract Tier A safest
        self <= other
    }
    pub fn is_as_safe_as_asset(&self, other: &AssetTier) -> bool {
        // allow Contract Tier A,B,C to rank above Assets below Collateral status
        if other == &AssetTier::Unlisted {
            true
        } else {
            other >= &AssetTier::Cross && self <= &ContractTier::C
        }
    }
}

#[account(zero_copy)]
#[derive(Eq, PartialEq, Debug)]
#[repr(C)]
pub struct PerpMarket {
    /// The address of the perp market
    pub pubkey: Pubkey,
    /// Protocol's automated market maker
    pub amm: AMM,
    /// The pnl pool that users settle pnl with
    /// If a user settles negative pnl, the pool increases
    /// If a user settles positive pnl, the pool decreases
    /// The pool can not go negative, so for a user with positive pnl to settle, there must be
    /// users with negative pnl already settled
    pub pnl_pool: PoolBalance,
    /// Display name
    pub name: [u8; 32],
    /// The markets claim on the insurance fund
    pub insurance_claim: InsuranceClaim,
    /// pnl imbalance occurs when the long's pnl does not equal the short's pnl
    /// this happens because the amm takes on a position and has pnl
    /// the max imbalance is the max difference between the long and short pnl
    /// before the asset weight for positive pnl is reduced
    /// PRECISION: QUOTE_PRECISION
    pub unrealized_pnl_max_imbalance: u64,
    /// When the market will expire, only set if market is in reduce only mode
    pub expiry_ts: i64,
    /// The price the market will settle at, only set if market is expired
    pub expiry_price: i64,
    /// Each trade has a fill record id. This is the next id to be used
    pub next_fill_record_id: u64,
    /// Each funding rate update has a record id. This is the next id to be used
    pub next_funding_rate_record_id: u64,
    /// Each amm k update has a record id. This is the next id to be used
    pub next_curve_record_id: u64,
    /// The initial margin fraction factor. Used to increase the margin requirement for large positions
    /// PRECISION: 1e6
    pub imf_factor: u32,
    pub unrealized_pnl_imf_factor: u32,
    pub liquidator_fee: u32,
    pub if_liquidation_fee: u32,
    pub margin_ratio_initial: u32,
    pub margin_ratio_maintenance: u32,
    pub unrealized_pnl_initial_asset_weight: u32,
    pub unrealized_pnl_maintenance_asset_weight: u32,
    pub number_of_users_with_base: u32, // number of users in a position
    pub number_of_users: u32,           // number of users in a position (base) or pnl (quote)
    pub market_index: u16,
    pub status: MarketStatus,
    pub contract_type: ContractType,
    pub contract_tier: ContractTier,
    pub padding1: bool,
    pub quote_spot_market_index: u16,
    pub padding: [u8; 48],
}

impl Default for PerpMarket {
    fn default() -> Self {
        PerpMarket {
            pubkey: Pubkey::default(),
            amm: AMM::default(),
            pnl_pool: PoolBalance::default(),
            name: [0; 32],
            insurance_claim: InsuranceClaim::default(),
            unrealized_pnl_max_imbalance: 0,
            expiry_ts: 0,
            expiry_price: 0,
            next_fill_record_id: 0,
            next_funding_rate_record_id: 0,
            next_curve_record_id: 0,
            imf_factor: 0,
            unrealized_pnl_imf_factor: 0,
            liquidator_fee: 0,
            if_liquidation_fee: 0,
            margin_ratio_initial: 0,
            margin_ratio_maintenance: 0,
            unrealized_pnl_initial_asset_weight: 0,
            unrealized_pnl_maintenance_asset_weight: 0,
            number_of_users_with_base: 0,
            number_of_users: 0,
            market_index: 0,
            status: MarketStatus::default(),
            contract_type: ContractType::default(),
            contract_tier: ContractTier::default(),
            padding1: false,
            quote_spot_market_index: 0,
            padding: [0; 48],
        }
    }
}

impl Size for PerpMarket {
    const SIZE: usize = 1216;
}

impl MarketIndexOffset for PerpMarket {
    const MARKET_INDEX_OFFSET: usize = 1160;
}

impl PerpMarket {
    pub fn is_active(&self, now: i64) -> DriftResult<bool> {
        let status_ok = !matches!(
            self.status,
            MarketStatus::Settlement | MarketStatus::Delisted
        );
        let not_expired = self.expiry_ts == 0 || now < self.expiry_ts;
        Ok(status_ok && not_expired)
    }

    pub fn is_reduce_only(&self) -> DriftResult<bool> {
        Ok(self.status == MarketStatus::ReduceOnly)
    }

    pub fn get_sanitize_clamp_denominator(self) -> DriftResult<Option<i64>> {
        Ok(match self.contract_tier {
            ContractTier::A => Some(10_i64),   // 10%
            ContractTier::B => Some(5_i64),    // 20%
            ContractTier::C => Some(2_i64),    // 50%
            ContractTier::Speculative => None, // DEFAULT_MAX_TWAP_UPDATE_PRICE_BAND_DENOMINATOR
            ContractTier::Isolated => None,    // DEFAULT_MAX_TWAP_UPDATE_PRICE_BAND_DENOMINATOR
        })
    }

    pub fn get_margin_ratio(
        &self,
        size: u128,
        margin_type: MarginRequirementType,
    ) -> DriftResult<u32> {
        if self.status == MarketStatus::Settlement {
            return Ok(0); // no liability weight on size
        }

        let default_margin_ratio = match margin_type {
            MarginRequirementType::Initial => self.margin_ratio_initial,
            MarginRequirementType::Maintenance => self.margin_ratio_maintenance,
        };

        let size_adj_margin_ratio = calculate_size_premium_liability_weight(
            size,
            self.imf_factor,
            default_margin_ratio,
            MARGIN_PRECISION_U128,
        )?;

        let margin_ratio = default_margin_ratio.max(size_adj_margin_ratio);

        Ok(margin_ratio)
    }

    pub fn get_initial_leverage_ratio(&self, margin_type: MarginRequirementType) -> u128 {
        match margin_type {
            MarginRequirementType::Initial => {
                MARGIN_PRECISION_U128 * MARGIN_PRECISION_U128 / self.margin_ratio_initial as u128
            }
            MarginRequirementType::Maintenance => {
                MARGIN_PRECISION_U128 * MARGIN_PRECISION_U128
                    / self.margin_ratio_maintenance as u128
            }
        }
    }

    pub fn get_unrealized_asset_weight(
        &self,
        unrealized_pnl: i128,
        margin_type: MarginRequirementType,
    ) -> DriftResult<u32> {
        let mut margin_asset_weight = match margin_type {
            MarginRequirementType::Initial => self.unrealized_pnl_initial_asset_weight,
            MarginRequirementType::Maintenance => self.unrealized_pnl_maintenance_asset_weight,
        };

        if margin_type == MarginRequirementType::Initial && self.unrealized_pnl_max_imbalance > 0 {
            let net_unsettled_pnl = amm::calculate_net_user_pnl(
                &self.amm,
                self.amm.historical_oracle_data.last_oracle_price,
            )?;

            if net_unsettled_pnl > self.unrealized_pnl_max_imbalance.cast::<i128>()? {
                margin_asset_weight = margin_asset_weight
                    .cast::<u128>()?
                    .safe_mul(self.unrealized_pnl_max_imbalance.cast()?)?
                    .safe_div(net_unsettled_pnl.unsigned_abs())?
                    .cast()?;
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
                        .safe_mul(AMM_TO_QUOTE_PRECISION_RATIO)?,
                    self.unrealized_pnl_imf_factor,
                    margin_asset_weight,
                )?,
                MarginRequirementType::Maintenance => self.unrealized_pnl_maintenance_asset_weight,
            }
        } else {
            SPOT_WEIGHT_PRECISION
        };

        Ok(unrealized_asset_weight)
    }

    pub fn get_open_interest(&self) -> u128 {
        self.amm
            .base_asset_amount_long
            .abs()
            .max(self.amm.base_asset_amount_short.abs())
            .unsigned_abs()
    }
}

#[cfg(test)]
impl PerpMarket {
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
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct InsuranceClaim {
    pub revenue_withdraw_since_last_settle: i64,
    pub max_revenue_withdraw_per_period: u64,
    pub quote_max_insurance: u64,
    pub quote_settled_insurance: u64,
    pub last_revenue_withdraw_ts: i64,
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct PoolBalance {
    pub scaled_balance: u128,
    pub market_index: u16,
    pub padding: [u8; 6],
}

impl SpotBalance for PoolBalance {
    fn market_index(&self) -> u16 {
        self.market_index
    }

    fn balance_type(&self) -> &SpotBalanceType {
        &SpotBalanceType::Deposit
    }

    fn balance(&self) -> u128 {
        self.scaled_balance
    }

    fn increase_balance(&mut self, delta: u128) -> DriftResult {
        self.scaled_balance = self.scaled_balance.safe_add(delta)?;
        Ok(())
    }

    fn decrease_balance(&mut self, delta: u128) -> DriftResult {
        self.scaled_balance = self.scaled_balance.safe_sub(delta)?;
        Ok(())
    }

    fn update_balance_type(&mut self, _balance_type: SpotBalanceType) -> DriftResult {
        Err(ErrorCode::CantUpdatePoolBalanceType)
    }
}

#[zero_copy]
#[derive(Debug, PartialEq, Eq)]
#[repr(C)]
pub struct AMM {
    pub oracle: Pubkey,
    pub historical_oracle_data: HistoricalOracleData,
    pub base_asset_amount_per_lp: i128,
    pub quote_asset_amount_per_lp: i128,
    pub fee_pool: PoolBalance,
    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
    pub concentration_coef: u128,
    pub min_base_asset_reserve: u128,
    pub max_base_asset_reserve: u128,
    pub sqrt_k: u128,
    pub peg_multiplier: u128,
    pub terminal_quote_asset_reserve: u128,
    pub base_asset_amount_long: i128,
    pub base_asset_amount_short: i128,
    pub base_asset_amount_with_amm: i128,
    pub base_asset_amount_with_unsettled_lp: i128,
    pub max_open_interest: u128,
    pub quote_asset_amount: i128,
    pub quote_entry_amount_long: i128,
    pub quote_entry_amount_short: i128,
    pub quote_break_even_amount_long: i128,
    pub quote_break_even_amount_short: i128,
    pub user_lp_shares: u128,
    pub last_funding_rate: i64,
    pub last_funding_rate_long: i64,
    pub last_funding_rate_short: i64,
    pub last_24h_avg_funding_rate: i64,
    pub total_fee: i128,
    pub total_mm_fee: i128,
    pub total_exchange_fee: u128,
    pub total_fee_minus_distributions: i128,
    pub total_fee_withdrawn: u128,
    pub total_liquidation_fee: u128,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub total_social_loss: u128,
    pub ask_base_asset_reserve: u128,
    pub ask_quote_asset_reserve: u128,
    pub bid_base_asset_reserve: u128,
    pub bid_quote_asset_reserve: u128,
    pub last_oracle_normalised_price: i64,
    pub last_oracle_reserve_price_spread_pct: i64,
    pub last_bid_price_twap: u64,
    pub last_ask_price_twap: u64,
    pub last_mark_price_twap: u64,
    pub last_mark_price_twap_5min: u64,
    pub last_update_slot: u64,
    pub last_oracle_conf_pct: u64,
    pub net_revenue_since_last_funding: i64,
    pub last_funding_rate_ts: i64,
    pub funding_period: i64,
    pub order_step_size: u64,
    pub order_tick_size: u64,
    pub min_order_size: u64,
    pub max_position_size: u64,
    pub volume_24h: u64,
    pub long_intensity_volume: u64,
    pub short_intensity_volume: u64,
    pub last_trade_ts: i64,
    pub mark_std: u64,
    pub oracle_std: u64,
    pub last_mark_price_twap_ts: i64,
    pub base_spread: u32,
    pub max_spread: u32,
    pub long_spread: u32,
    pub short_spread: u32,
    pub long_intensity_count: u32,
    pub short_intensity_count: u32,
    pub max_fill_reserve_fraction: u16,
    pub max_slippage_ratio: u16,
    pub curve_update_intensity: u8,
    pub amm_jit_intensity: u8,
    pub oracle_source: OracleSource,
    pub last_oracle_valid: bool,
    pub padding: [u8; 48],
}

impl Default for AMM {
    fn default() -> Self {
        AMM {
            oracle: Pubkey::default(),
            historical_oracle_data: HistoricalOracleData::default(),
            base_asset_amount_per_lp: 0,
            quote_asset_amount_per_lp: 0,
            fee_pool: PoolBalance::default(),
            base_asset_reserve: 0,
            quote_asset_reserve: 0,
            concentration_coef: 0,
            min_base_asset_reserve: 0,
            max_base_asset_reserve: 0,
            sqrt_k: 0,
            peg_multiplier: 0,
            terminal_quote_asset_reserve: 0,
            base_asset_amount_long: 0,
            base_asset_amount_short: 0,
            base_asset_amount_with_amm: 0,
            base_asset_amount_with_unsettled_lp: 0,
            max_open_interest: 0,
            quote_asset_amount: 0,
            quote_entry_amount_long: 0,
            quote_entry_amount_short: 0,
            quote_break_even_amount_long: 0,
            quote_break_even_amount_short: 0,
            user_lp_shares: 0,
            last_funding_rate: 0,
            last_funding_rate_long: 0,
            last_funding_rate_short: 0,
            last_24h_avg_funding_rate: 0,
            total_fee: 0,
            total_mm_fee: 0,
            total_exchange_fee: 0,
            total_fee_minus_distributions: 0,
            total_fee_withdrawn: 0,
            total_liquidation_fee: 0,
            cumulative_funding_rate_long: 0,
            cumulative_funding_rate_short: 0,
            total_social_loss: 0,
            ask_base_asset_reserve: 0,
            ask_quote_asset_reserve: 0,
            bid_base_asset_reserve: 0,
            bid_quote_asset_reserve: 0,
            last_oracle_normalised_price: 0,
            last_oracle_reserve_price_spread_pct: 0,
            last_bid_price_twap: 0,
            last_ask_price_twap: 0,
            last_mark_price_twap: 0,
            last_mark_price_twap_5min: 0,
            last_update_slot: 0,
            last_oracle_conf_pct: 0,
            net_revenue_since_last_funding: 0,
            last_funding_rate_ts: 0,
            funding_period: 0,
            order_step_size: 0,
            order_tick_size: 0,
            min_order_size: 1,
            max_position_size: 0,
            volume_24h: 0,
            long_intensity_volume: 0,
            short_intensity_volume: 0,
            last_trade_ts: 0,
            mark_std: 0,
            oracle_std: 0,
            last_mark_price_twap_ts: 0,
            base_spread: 0,
            max_spread: 0,
            long_spread: 0,
            short_spread: 0,
            long_intensity_count: 0,
            short_intensity_count: 0,
            max_fill_reserve_fraction: 0,
            max_slippage_ratio: 0,
            curve_update_intensity: 0,
            amm_jit_intensity: 0,
            oracle_source: OracleSource::default(),
            last_oracle_valid: false,
            padding: [0; 48],
        }
    }
}

impl AMM {
    pub fn amm_jit_is_active(&self) -> bool {
        self.amm_jit_intensity > 0
    }

    pub fn reserve_price(&self) -> DriftResult<u64> {
        amm::calculate_price(
            self.quote_asset_reserve,
            self.base_asset_reserve,
            self.peg_multiplier,
        )
    }

    pub fn bid_price(&self, reserve_price: u64) -> DriftResult<u64> {
        reserve_price
            .cast::<u128>()?
            .safe_mul(BID_ASK_SPREAD_PRECISION_U128.safe_sub(self.short_spread.cast()?)?)?
            .safe_div(BID_ASK_SPREAD_PRECISION_U128)?
            .cast()
    }

    pub fn ask_price(&self, reserve_price: u64) -> DriftResult<u64> {
        reserve_price
            .cast::<u128>()?
            .safe_mul(BID_ASK_SPREAD_PRECISION_U128.safe_add(self.long_spread.cast()?)?)?
            .safe_div(BID_ASK_SPREAD_PRECISION_U128)?
            .cast::<u64>()
    }

    pub fn bid_ask_price(&self, reserve_price: u64) -> DriftResult<(u64, u64)> {
        let bid_price = self.bid_price(reserve_price)?;
        let ask_price = self.ask_price(reserve_price)?;
        Ok((bid_price, ask_price))
    }

    pub fn can_lower_k(&self) -> DriftResult<bool> {
        let (max_bids, max_asks) = amm::calculate_market_open_bids_asks(self)?;
        let can_lower = self.base_asset_amount_with_amm.unsigned_abs()
            < max_bids.unsigned_abs().min(max_asks.unsigned_abs())
            && self.base_asset_amount_with_amm.unsigned_abs()
                < self.sqrt_k.safe_sub(self.user_lp_shares)?;
        Ok(can_lower)
    }

    pub fn get_oracle_twap(&self, price_oracle: &AccountInfo) -> DriftResult<Option<i64>> {
        match self.oracle_source {
            OracleSource::Pyth | OracleSource::PythStableCoin => {
                Ok(Some(self.get_pyth_twap(price_oracle, 1)?))
            }
            OracleSource::Pyth1K => Ok(Some(self.get_pyth_twap(price_oracle, 1000)?)),
            OracleSource::Pyth1M => Ok(Some(self.get_pyth_twap(price_oracle, 1000000)?)),
            OracleSource::Switchboard => Ok(None),
            OracleSource::QuoteAsset => {
                msg!("Can't get oracle twap for quote asset");
                Err(ErrorCode::DefaultError)
            }
        }
    }

    pub fn get_pyth_twap(&self, price_oracle: &AccountInfo, multiple: u128) -> DriftResult<i64> {
        let pyth_price_data = price_oracle
            .try_borrow_data()
            .or(Err(ErrorCode::UnableToLoadOracle))?;
        let price_data = pyth_client::cast::<pyth_client::Price>(&pyth_price_data);

        let oracle_twap = price_data.twap.val;

        assert!(oracle_twap > price_data.agg.price / 10);

        let oracle_precision = 10_u128
            .pow(price_data.expo.unsigned_abs())
            .safe_div(multiple)?;

        let mut oracle_scale_mult = 1;
        let mut oracle_scale_div = 1;

        if oracle_precision > PRICE_PRECISION {
            oracle_scale_div = oracle_precision.safe_div(PRICE_PRECISION)?;
        } else {
            oracle_scale_mult = PRICE_PRECISION.safe_div(oracle_precision)?;
        }

        oracle_twap
            .cast::<i128>()?
            .safe_mul(oracle_scale_mult.cast()?)?
            .safe_div(oracle_scale_div.cast()?)?
            .cast::<i64>()
    }

    pub fn update_volume_24h(
        &mut self,
        quote_asset_amount: u64,
        position_direction: PositionDirection,
        now: i64,
    ) -> DriftResult {
        let since_last = max(1_i64, now.safe_sub(self.last_trade_ts)?);

        amm::update_amm_long_short_intensity(self, now, quote_asset_amount, position_direction)?;

        self.volume_24h = stats::calculate_rolling_sum(
            self.volume_24h,
            quote_asset_amount,
            since_last,
            TWENTY_FOUR_HOUR,
        )?;

        self.last_trade_ts = now;

        Ok(())
    }
}

#[cfg(test)]
impl AMM {
    pub fn default_test() -> Self {
        let default_reserves = 100 * AMM_RESERVE_PRECISION;
        // make sure tests dont have the default sqrt_k = 0
        AMM {
            base_asset_reserve: default_reserves,
            quote_asset_reserve: default_reserves,
            sqrt_k: default_reserves,
            concentration_coef: MAX_CONCENTRATION_COEFFICIENT,
            order_step_size: 1,
            order_tick_size: 1,
            max_base_asset_reserve: u64::MAX as u128,
            min_base_asset_reserve: 0,
            terminal_quote_asset_reserve: default_reserves,
            peg_multiplier: crate::math::constants::PEG_PRECISION,
            max_fill_reserve_fraction: 1,
            max_spread: 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: PRICE_PRECISION_I64,
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

            base_asset_amount_with_amm: -(AMM_RESERVE_PRECISION as i128),
            mark_std: PRICE_PRECISION as u64,

            quote_asset_amount: 19_000_000_000, // short 1 BTC @ $19000
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: 19_400 * PRICE_PRECISION_I64,
                last_oracle_price_twap: 19_400 * PRICE_PRECISION_I64,
                last_oracle_price_twap_ts: 1662800000_i64,
                ..HistoricalOracleData::default()
            },
            last_mark_price_twap_ts: 1662800000,

            curve_update_intensity: 100,

            base_spread: 250,
            max_spread: 975,
            funding_period: 3600,
            last_oracle_valid: true,
            ..AMM::default()
        }
    }
}
