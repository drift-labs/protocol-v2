use std::fmt;
use std::fmt::{Display, Formatter};

use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::constants::{AMM_RESERVE_PRECISION, MARGIN_PRECISION, SPOT_WEIGHT_PRECISION_U128};
#[cfg(test)]
use crate::math::constants::{PRICE_PRECISION_I64, SPOT_CUMULATIVE_INTEREST_PRECISION};
use crate::math::margin::{
    calculate_size_discount_asset_weight, calculate_size_premium_liability_weight,
    MarginRequirementType,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::{calculate_utilization, get_token_amount};

use crate::state::oracle::{HistoricalIndexData, HistoricalOracleData, OracleSource};
use crate::state::perp_market::{MarketStatus, PoolBalance};
use crate::state::traits::{MarketIndexOffset, Size};

#[account(zero_copy)]
#[derive(PartialEq, Eq, Debug)]
#[repr(C)]
pub struct SpotMarket {
    pub pubkey: Pubkey,
    pub oracle: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub name: [u8; 32], // 256 bits
    pub historical_oracle_data: HistoricalOracleData,
    pub historical_index_data: HistoricalIndexData,
    pub revenue_pool: PoolBalance,  // in base asset
    pub spot_fee_pool: PoolBalance, // in quote asset
    pub insurance_fund: InsuranceFund,
    pub total_spot_fee: u128,
    pub deposit_balance: u128,
    pub borrow_balance: u128,
    pub cumulative_deposit_interest: u128,
    pub cumulative_borrow_interest: u128,
    pub total_social_loss: u128,
    pub total_quote_social_loss: u128,
    pub withdraw_guard_threshold: u64, // no withdraw limits/guards when deposits below this threshold
    pub max_token_deposits: u64,
    pub deposit_token_twap: u64, // 24 hour twap
    pub borrow_token_twap: u64,  // 24 hour twap
    pub utilization_twap: u64,   // 24 hour twap
    pub last_interest_ts: u64,
    pub last_twap_ts: u64,
    pub expiry_ts: i64, // iff market in reduce only mode
    pub order_step_size: u64,
    pub order_tick_size: u64,
    pub min_order_size: u64,
    pub max_position_size: u64,
    pub next_fill_record_id: u64,
    pub next_deposit_record_id: u64,
    pub initial_asset_weight: u32,
    pub maintenance_asset_weight: u32,
    pub initial_liability_weight: u32,
    pub maintenance_liability_weight: u32,
    pub imf_factor: u32,
    pub liquidator_fee: u32,
    pub if_liquidation_fee: u32, // percentage of liquidation transfer for total insurance
    pub optimal_utilization: u32, //
    pub optimal_borrow_rate: u32,
    pub max_borrow_rate: u32,
    pub decimals: u32,
    pub market_index: u16,
    pub orders_enabled: bool,
    pub oracle_source: OracleSource,
    pub status: MarketStatus,
    pub asset_tier: AssetTier,
    pub padding: [u8; 86],
}

impl Default for SpotMarket {
    fn default() -> Self {
        SpotMarket {
            pubkey: Pubkey::default(),
            oracle: Pubkey::default(),
            mint: Pubkey::default(),
            vault: Pubkey::default(),
            name: [0; 32],
            historical_oracle_data: HistoricalOracleData::default(),
            historical_index_data: HistoricalIndexData::default(),
            revenue_pool: PoolBalance::default(),
            spot_fee_pool: PoolBalance::default(),
            insurance_fund: InsuranceFund::default(),
            total_spot_fee: 0,
            deposit_balance: 0,
            borrow_balance: 0,
            cumulative_deposit_interest: 0,
            cumulative_borrow_interest: 0,
            total_social_loss: 0,
            total_quote_social_loss: 0,
            withdraw_guard_threshold: 0,
            max_token_deposits: 0,
            deposit_token_twap: 0,
            borrow_token_twap: 0,
            utilization_twap: 0,
            last_interest_ts: 0,
            last_twap_ts: 0,
            expiry_ts: 0,
            order_step_size: 1,
            order_tick_size: 0,
            min_order_size: 0,
            max_position_size: 0,
            next_fill_record_id: 0,
            next_deposit_record_id: 0,
            initial_asset_weight: 0,
            maintenance_asset_weight: 0,
            initial_liability_weight: 0,
            maintenance_liability_weight: 0,
            imf_factor: 0,
            liquidator_fee: 0,
            if_liquidation_fee: 0,
            optimal_utilization: 0,
            optimal_borrow_rate: 0,
            max_borrow_rate: 0,
            decimals: 0,
            market_index: 0,
            orders_enabled: false,
            oracle_source: OracleSource::default(),
            status: MarketStatus::default(),
            asset_tier: AssetTier::default(),
            padding: [0; 86],
        }
    }
}

impl Size for SpotMarket {
    const SIZE: usize = 776;
}

impl MarketIndexOffset for SpotMarket {
    const MARKET_INDEX_OFFSET: usize = 684;
}

impl SpotMarket {
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

    pub fn get_sanitize_clamp_denominator(&self) -> DriftResult<Option<i64>> {
        Ok(match self.asset_tier {
            AssetTier::Collateral => Some(10), // 10%
            AssetTier::Protected => Some(10),  // 10%
            AssetTier::Cross => Some(5),       // 20%
            AssetTier::Isolated => Some(3),    // 50%
            AssetTier::Unlisted => None,       // DEFAULT_MAX_TWAP_UPDATE_PRICE_BAND_DENOMINATOR
        })
    }

    pub fn get_asset_weight(
        &self,
        size: u128,
        margin_requirement_type: &MarginRequirementType,
    ) -> DriftResult<u32> {
        let size_precision = 10_u128.pow(self.decimals);

        let size_in_amm_reserve_precision = if size_precision > AMM_RESERVE_PRECISION {
            size / (size_precision / AMM_RESERVE_PRECISION)
        } else {
            (size * AMM_RESERVE_PRECISION) / size_precision
        };

        let default_asset_weight = match margin_requirement_type {
            MarginRequirementType::Initial => self.initial_asset_weight,
            MarginRequirementType::Maintenance => self.maintenance_asset_weight,
        };

        let size_based_asset_weight = calculate_size_discount_asset_weight(
            size_in_amm_reserve_precision,
            self.imf_factor,
            default_asset_weight,
        )?;

        let asset_weight = size_based_asset_weight.min(default_asset_weight);

        Ok(asset_weight)
    }

    pub fn get_liability_weight(
        &self,
        size: u128,
        margin_requirement_type: &MarginRequirementType,
    ) -> DriftResult<u32> {
        let size_precision = 10_u128.pow(self.decimals);

        let size_in_amm_reserve_precision = if size_precision > AMM_RESERVE_PRECISION {
            size / (size_precision / AMM_RESERVE_PRECISION)
        } else {
            (size * AMM_RESERVE_PRECISION) / size_precision
        };

        let default_liability_weight = match margin_requirement_type {
            MarginRequirementType::Initial => self.initial_liability_weight,
            MarginRequirementType::Maintenance => self.maintenance_liability_weight,
        };

        let size_based_liability_weight = calculate_size_premium_liability_weight(
            size_in_amm_reserve_precision,
            self.imf_factor,
            default_liability_weight,
            SPOT_WEIGHT_PRECISION_U128,
        )?;

        let liability_weight = size_based_liability_weight.max(default_liability_weight);

        Ok(liability_weight)
    }

    // get liability weight as if it were perp market margin requirement
    pub fn get_margin_ratio(
        &self,
        margin_requirement_type: &MarginRequirementType,
    ) -> DriftResult<u32> {
        let liability_weight = match margin_requirement_type {
            MarginRequirementType::Initial => self.initial_liability_weight,
            MarginRequirementType::Maintenance => self.maintenance_liability_weight,
        };
        liability_weight.safe_sub(MARGIN_PRECISION)
    }

    pub fn get_deposits(&self) -> DriftResult<u128> {
        get_token_amount(self.deposit_balance, self, &SpotBalanceType::Deposit)
    }

    pub fn get_available_deposits(&self) -> DriftResult<u128> {
        let deposit_token_amount =
            get_token_amount(self.deposit_balance, self, &SpotBalanceType::Deposit)?;

        let borrow_token_amount =
            get_token_amount(self.borrow_balance, self, &SpotBalanceType::Borrow)?;

        deposit_token_amount.safe_sub(borrow_token_amount)
    }

    pub fn get_precision(self) -> u64 {
        10_u64.pow(self.decimals)
    }

    pub fn get_utilization(self) -> DriftResult<u128> {
        let deposit_token_amount =
            get_token_amount(self.deposit_balance, &self, &SpotBalanceType::Deposit)?;

        let borrow_token_amount =
            get_token_amount(self.borrow_balance, &self, &SpotBalanceType::Borrow)?;
        calculate_utilization(deposit_token_amount, borrow_token_amount)
    }

    pub fn is_healthy_utilization(self) -> DriftResult<bool> {
        let unhealthy_utilization = 800000; // 80%
        let utilization: u64 = self.get_utilization()?.cast()?;
        Ok(self.utilization_twap <= unhealthy_utilization && utilization <= unhealthy_utilization)
    }
}

#[cfg(test)]
impl SpotMarket {
    pub fn default_base_market() -> Self {
        SpotMarket {
            market_index: 1,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            initial_liability_weight: 12000,
            maintenance_liability_weight: 11000,
            initial_asset_weight: 8000,
            maintenance_asset_weight: 9000,
            decimals: 9,
            order_step_size: 1,
            order_tick_size: 1,
            status: MarketStatus::Active,
            ..SpotMarket::default()
        }
    }

    pub fn default_quote_market() -> Self {
        SpotMarket {
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_liability_weight: 10000,
            maintenance_liability_weight: 10000,
            initial_asset_weight: 10000,
            maintenance_asset_weight: 10000,
            order_tick_size: 1,
            status: MarketStatus::Active,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        }
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Eq, Debug)]
pub enum SpotBalanceType {
    Deposit,
    Borrow,
}

impl Display for SpotBalanceType {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        match self {
            SpotBalanceType::Deposit => write!(f, "SpotBalanceType::Deposit"),
            SpotBalanceType::Borrow => write!(f, "SpotBalanceType::Borrow"),
        }
    }
}

impl Default for SpotBalanceType {
    fn default() -> Self {
        SpotBalanceType::Deposit
    }
}

pub trait SpotBalance {
    fn market_index(&self) -> u16;

    fn balance_type(&self) -> &SpotBalanceType;

    fn balance(&self) -> u128;

    fn increase_balance(&mut self, delta: u128) -> DriftResult;

    fn decrease_balance(&mut self, delta: u128) -> DriftResult;

    fn update_balance_type(&mut self, balance_type: SpotBalanceType) -> DriftResult;
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum SpotFulfillmentConfigStatus {
    Enabled,
    Disabled,
}

impl Default for SpotFulfillmentConfigStatus {
    fn default() -> Self {
        SpotFulfillmentConfigStatus::Enabled
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq, PartialOrd, Ord)]
pub enum AssetTier {
    Collateral, // full priviledge
    Protected,  // collateral, but no borrow
    Cross,      // not collateral, allow multi-borrow
    Isolated,   // not collateral, only single borrow
    Unlisted,   // no priviledge
}

impl Default for AssetTier {
    fn default() -> Self {
        AssetTier::Unlisted
    }
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct InsuranceFund {
    pub vault: Pubkey,
    pub total_shares: u128,
    pub user_shares: u128,
    pub shares_base: u128,     // exponent for lp shares (for rebasing)
    pub unstaking_period: i64, // if_unstaking_period
    pub last_revenue_settle_ts: i64,
    pub revenue_settle_period: i64,
    pub total_factor: u32, // percentage of interest for total insurance
    pub user_factor: u32,  // percentage of interest for user staked insurance
}
