use std::fmt;
use std::fmt::{Display, Formatter};

use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

use crate::error::ClearingHouseResult;
use crate::instructions::SpotFulfillmentType;
#[cfg(test)]
use crate::math::constants::SPOT_CUMULATIVE_INTEREST_PRECISION;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, LIQUIDATION_FEE_PRECISION, MARGIN_PRECISION, SPOT_WEIGHT_PRECISION,
};
use crate::math::margin::{
    calculate_size_discount_asset_weight, calculate_size_premium_liability_weight,
    MarginRequirementType,
};
use crate::math::spot_balance::get_token_amount;
use crate::math_error;
use crate::state::oracle::{HistoricalIndexData, HistoricalOracleData, OracleSource};
use crate::state::perp_market::{MarketStatus, PoolBalance};
use solana_program::msg;

#[account(zero_copy)]
#[derive(Default, PartialEq, Eq, Debug)]
#[repr(C)]
pub struct SpotMarket {
    pub pubkey: Pubkey,
    pub oracle: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub historical_oracle_data: HistoricalOracleData,
    pub historical_index_data: HistoricalIndexData,
    pub revenue_pool: PoolBalance,  // in base asset
    pub spot_fee_pool: PoolBalance, // in quote asset
    pub insurance_fund: InsuranceFund,
    pub initial_asset_weight: u128,
    pub maintenance_asset_weight: u128,
    pub initial_liability_weight: u128,
    pub maintenance_liability_weight: u128,
    pub imf_factor: u128,
    pub liquidator_fee: u128,
    pub if_liquidation_fee: u128, // percentage of liquidation transfer for total insurance
    pub withdraw_guard_threshold: u128, // no withdraw limits/guards when deposits below this threshold
    pub total_spot_fee: u128,
    pub deposit_balance: u128,
    pub borrow_balance: u128,
    pub max_token_deposits: u128,
    pub deposit_token_twap: u128, // 24 hour twap
    pub borrow_token_twap: u128,  // 24 hour twap
    pub utilization_twap: u128,   // 24 hour twap
    pub cumulative_deposit_interest: u128,
    pub cumulative_borrow_interest: u128,
    pub last_interest_ts: u64,
    pub last_twap_ts: u64,
    pub expiry_ts: i64, // iff market in reduce only mode
    pub order_step_size: u64,
    pub order_tick_size: u64,
    pub min_order_size: u64,
    pub max_position_size: u64,
    pub next_fill_record_id: u64,
    pub optimal_utilization: u32,
    pub optimal_borrow_rate: u32,
    pub max_borrow_rate: u32,
    pub market_index: u16,
    pub decimals: u8,
    pub oracle_source: OracleSource,
    pub status: MarketStatus,
    pub asset_tier: AssetTier,
    pub padding: [u8; 6],
}

impl SpotMarket {
    pub fn is_active(&self, now: i64) -> ClearingHouseResult<bool> {
        let status_ok = !matches!(
            self.status,
            MarketStatus::Settlement | MarketStatus::Delisted
        );
        let not_expired = self.expiry_ts == 0 || now < self.expiry_ts;
        Ok(status_ok && not_expired)
    }

    pub fn is_reduce_only(&self) -> ClearingHouseResult<bool> {
        Ok(self.status == MarketStatus::ReduceOnly)
    }

    pub fn get_asset_weight(
        &self,
        size: u128,
        margin_requirement_type: &MarginRequirementType,
    ) -> ClearingHouseResult<u128> {
        let size_precision = 10_u128.pow(self.decimals as u32);

        let size_in_amm_reserve_precision = if size_precision > AMM_RESERVE_PRECISION {
            size / (size_precision / AMM_RESERVE_PRECISION)
        } else {
            (size * AMM_RESERVE_PRECISION) / size_precision
        };
        let asset_weight = match margin_requirement_type {
            MarginRequirementType::Initial => calculate_size_discount_asset_weight(
                size_in_amm_reserve_precision,
                self.imf_factor,
                self.initial_asset_weight,
            )?,
            MarginRequirementType::Maintenance => self.maintenance_asset_weight,
        };
        Ok(asset_weight)
    }

    pub fn get_liability_weight(
        &self,
        size: u128,
        margin_requirement_type: &MarginRequirementType,
    ) -> ClearingHouseResult<u128> {
        let size_precision = 10_u128.pow(self.decimals as u32);

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
            SPOT_WEIGHT_PRECISION,
        )?;

        let liability_weight = size_based_liability_weight.max(default_liability_weight);

        Ok(liability_weight)
    }

    pub fn get_liquidation_fee_multiplier(
        &self,
        balance_type: SpotBalanceType,
    ) -> ClearingHouseResult<u128> {
        match balance_type {
            SpotBalanceType::Deposit => LIQUIDATION_FEE_PRECISION
                .checked_add(self.liquidator_fee)
                .ok_or_else(math_error!()),
            SpotBalanceType::Borrow => LIQUIDATION_FEE_PRECISION
                .checked_sub(self.liquidator_fee)
                .ok_or_else(math_error!()),
        }
    }

    // get liability weight as if it were perp market margin requirement
    pub fn get_margin_ratio(
        &self,
        margin_requirement_type: &MarginRequirementType,
    ) -> ClearingHouseResult<u128> {
        let liability_weight = match margin_requirement_type {
            MarginRequirementType::Initial => self.initial_liability_weight,
            MarginRequirementType::Maintenance => self.maintenance_liability_weight,
        };
        liability_weight
            .checked_sub(MARGIN_PRECISION)
            .ok_or_else(math_error!())
    }

    pub fn get_available_deposits(&self) -> ClearingHouseResult<u128> {
        let deposit_token_amount =
            get_token_amount(self.deposit_balance, self, &SpotBalanceType::Deposit)?;

        let borrow_token_amount =
            get_token_amount(self.borrow_balance, self, &SpotBalanceType::Borrow)?;

        deposit_token_amount
            .checked_sub(borrow_token_amount)
            .ok_or_else(math_error!())
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

    fn increase_balance(&mut self, delta: u128) -> ClearingHouseResult;

    fn decrease_balance(&mut self, delta: u128) -> ClearingHouseResult;

    fn update_balance_type(&mut self, balance_type: SpotBalanceType) -> ClearingHouseResult;
}

#[account(zero_copy)]
#[derive(Default, PartialEq, Eq, Debug)]
#[repr(C)]
pub struct SerumV3FulfillmentConfig {
    pub pubkey: Pubkey,
    pub serum_program_id: Pubkey,
    pub serum_market: Pubkey,
    pub serum_request_queue: Pubkey,
    pub serum_event_queue: Pubkey,
    pub serum_bids: Pubkey,
    pub serum_asks: Pubkey,
    pub serum_base_vault: Pubkey,
    pub serum_quote_vault: Pubkey,
    pub serum_open_orders: Pubkey,
    pub serum_signer_nonce: u64,
    pub market_index: u16,
    pub fulfillment_type: SpotFulfillmentType,
    pub status: SpotFulfillmentStatus,
    pub padding: [u8; 4],
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum SpotFulfillmentStatus {
    Enabled,
    Disabled,
}

impl Default for SpotFulfillmentStatus {
    fn default() -> Self {
        SpotFulfillmentStatus::Enabled
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
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
