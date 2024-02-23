use std::fmt;
use std::fmt::{Display, Formatter};

use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::{AMM_RESERVE_PRECISION, MARGIN_PRECISION, SPOT_WEIGHT_PRECISION_U128};
#[cfg(test)]
use crate::math::constants::{PRICE_PRECISION_I64, SPOT_CUMULATIVE_INTEREST_PRECISION};
use crate::math::margin::{
    calculate_size_discount_asset_weight, calculate_size_premium_liability_weight,
    MarginRequirementType,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::{calculate_utilization, get_token_amount, get_token_value};

use crate::state::oracle::{HistoricalIndexData, HistoricalOracleData, OracleSource};
use crate::state::paused_operations::SpotOperation;
use crate::state::perp_market::{MarketStatus, PoolBalance};
use crate::state::traits::{MarketIndexOffset, Size};
use crate::validate;

#[account(zero_copy(unsafe))]
#[derive(PartialEq, Eq, Debug)]
#[repr(C)]
pub struct SpotMarket {
    /// The address of the spot market. It is a pda of the market index
    pub pubkey: Pubkey,
    /// The oracle used to price the markets deposits/borrows
    pub oracle: Pubkey,
    /// The token mint of the market
    pub mint: Pubkey,
    /// The vault used to store the market's deposits
    /// The amount in the vault should be equal to or greater than deposits - borrows
    pub vault: Pubkey,
    /// The encoded display name for the market e.g. SOL
    pub name: [u8; 32],
    pub historical_oracle_data: HistoricalOracleData,
    pub historical_index_data: HistoricalIndexData,
    /// Revenue the protocol has collected in this markets token
    /// e.g. for SOL-PERP, funds can be settled in usdc and will flow into the USDC revenue pool
    pub revenue_pool: PoolBalance, // in base asset
    /// The fees collected from swaps between this market and the quote market
    /// Is settled to the quote markets revenue pool
    pub spot_fee_pool: PoolBalance,
    /// Details on the insurance fund covering bankruptcies in this markets token
    /// Covers bankruptcies for borrows with this markets token and perps settling in this markets token
    pub insurance_fund: InsuranceFund,
    /// The total spot fees collected for this market
    /// precision: QUOTE_PRECISION
    pub total_spot_fee: u128,
    /// The sum of the scaled balances for deposits across users and pool balances
    /// To convert to the deposit token amount, multiply by the cumulative deposit interest
    /// precision: SPOT_BALANCE_PRECISION
    pub deposit_balance: u128,
    /// The sum of the scaled balances for borrows across users and pool balances
    /// To convert to the borrow token amount, multiply by the cumulative borrow interest
    /// precision: SPOT_BALANCE_PRECISION
    pub borrow_balance: u128,
    /// The cumulative interest earned by depositors
    /// Used to calculate the deposit token amount from the deposit balance
    /// precision: SPOT_CUMULATIVE_INTEREST_PRECISION
    pub cumulative_deposit_interest: u128,
    /// The cumulative interest earned by borrowers
    /// Used to calculate the borrow token amount from the borrow balance
    /// precision: SPOT_CUMULATIVE_INTEREST_PRECISION
    pub cumulative_borrow_interest: u128,
    /// The total socialized loss from borrows, in the mint's token
    /// precision: token mint precision
    pub total_social_loss: u128,
    /// The total socialized loss from borrows, in the quote market's token
    /// preicision: QUOTE_PRECISION
    pub total_quote_social_loss: u128,
    /// no withdraw limits/guards when deposits below this threshold
    /// precision: token mint precision
    pub withdraw_guard_threshold: u64,
    /// The max amount of token deposits in this market
    /// 0 if there is no limit
    /// precision: token mint precision
    pub max_token_deposits: u64,
    /// 24hr average of deposit token amount
    /// precision: token mint precision
    pub deposit_token_twap: u64,
    /// 24hr average of borrow token amount
    /// precision: token mint precision
    pub borrow_token_twap: u64,
    /// 24hr average of utilization
    /// which is borrow amount over token amount
    /// precision: SPOT_UTILIZATION_PRECISION
    pub utilization_twap: u64,
    /// Last time the cumulative deposit and borrow interest was updated
    pub last_interest_ts: u64,
    /// Last time the deposit/borrow/utilization averages were updated
    pub last_twap_ts: u64,
    /// The time the market is set to expire. Only set if market is in reduce only mode
    pub expiry_ts: i64,
    /// Spot orders must be a multiple of the step size
    /// precision: token mint precision
    pub order_step_size: u64,
    /// Spot orders must be a multiple of the tick size
    /// precision: PRICE_PRECISION
    pub order_tick_size: u64,
    /// The minimum order size
    /// precision: token mint precision
    pub min_order_size: u64,
    /// The maximum spot position size
    /// if the limit is 0, there is no limit
    /// precision: token mint precision
    pub max_position_size: u64,
    /// Every spot trade has a fill record id. This is the next id to use
    pub next_fill_record_id: u64,
    /// Every deposit has a deposit record id. This is the next id to use
    pub next_deposit_record_id: u64,
    /// The initial asset weight used to calculate a deposits contribution to a users initial total collateral
    /// e.g. if the asset weight is .8, $100 of deposits contributes $80 to the users initial total collateral
    /// precision: SPOT_WEIGHT_PRECISION
    pub initial_asset_weight: u32,
    /// The maintenance asset weight used to calculate a deposits contribution to a users maintenance total collateral
    /// e.g. if the asset weight is .9, $100 of deposits contributes $90 to the users maintenance total collateral
    /// precision: SPOT_WEIGHT_PRECISION
    pub maintenance_asset_weight: u32,
    /// The initial liability weight used to calculate a borrows contribution to a users initial margin requirement
    /// e.g. if the liability weight is .9, $100 of borrows contributes $90 to the users initial margin requirement
    /// precision: SPOT_WEIGHT_PRECISION
    pub initial_liability_weight: u32,
    /// The maintenance liability weight used to calculate a borrows contribution to a users maintenance margin requirement
    /// e.g. if the liability weight is .8, $100 of borrows contributes $80 to the users maintenance margin requirement
    /// precision: SPOT_WEIGHT_PRECISION
    pub maintenance_liability_weight: u32,
    /// The initial margin fraction factor. Used to increase liability weight/decrease asset weight for large positions
    /// precision: MARGIN_PRECISION
    pub imf_factor: u32,
    /// The fee the liquidator is paid for taking over borrow/deposit
    /// precision: LIQUIDATOR_FEE_PRECISION
    pub liquidator_fee: u32,
    /// The fee the insurance fund receives from liquidation
    /// precision: LIQUIDATOR_FEE_PRECISION
    pub if_liquidation_fee: u32,
    /// The optimal utilization rate for this market.
    /// Used to determine the markets borrow rate
    /// precision: SPOT_UTILIZATION_PRECISION
    pub optimal_utilization: u32,
    /// The borrow rate for this market when the market has optimal utilization
    /// precision: SPOT_RATE_PRECISION
    pub optimal_borrow_rate: u32,
    /// The borrow rate for this market when the market has 1000 utilization
    /// precision: SPOT_RATE_PRECISION
    pub max_borrow_rate: u32,
    /// The market's token mint's decimals. To from decimals to a precision, 10^decimals
    pub decimals: u32,
    pub market_index: u16,
    /// Whether or not spot trading is enabled
    pub orders_enabled: bool,
    pub oracle_source: OracleSource,
    pub status: MarketStatus,
    /// The asset tier affects how a deposit can be used as collateral and the priority for a borrow being liquidated
    pub asset_tier: AssetTier,
    pub paused_operations: u8,
    pub padding1: [u8; 5],
    /// For swaps, the amount of token loaned out in the begin_swap ix
    /// precision: token mint precision
    pub flash_loan_amount: u64,
    /// For swaps, the amount in the users token account in the begin_swap ix
    /// Used to calculate how much of the token left the system in end_swap ix
    /// precision: token mint precision
    pub flash_loan_initial_token_amount: u64,
    /// The total fees received from swaps
    /// precision: token mint precision
    pub total_swap_fee: u64,
    /// When to begin scaling down the initial asset weight
    /// disabled when 0
    /// precision: QUOTE_PRECISION
    pub scale_initial_asset_weight_start: u64,
    pub padding: [u8; 48],
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
            paused_operations: 0,
            padding1: [0; 5],
            flash_loan_amount: 0,
            flash_loan_initial_token_amount: 0,
            total_swap_fee: 0,
            scale_initial_asset_weight_start: 0,
            padding: [0; 48],
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
    pub fn is_in_settlement(&self, now: i64) -> bool {
        let in_settlement = matches!(
            self.status,
            MarketStatus::Settlement | MarketStatus::Delisted
        );
        let expired = self.expiry_ts != 0 && now >= self.expiry_ts;
        in_settlement || expired
    }

    pub fn is_reduce_only(&self) -> bool {
        self.status == MarketStatus::ReduceOnly
    }

    pub fn is_operation_paused(&self, operation: SpotOperation) -> bool {
        SpotOperation::is_operation_paused(self.paused_operations, operation)
    }

    pub fn fills_enabled(&self) -> bool {
        matches!(self.status, MarketStatus::Active | MarketStatus::ReduceOnly)
            && !self.is_operation_paused(SpotOperation::Fill)
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
        oracle_price: i64,
        margin_requirement_type: &MarginRequirementType,
    ) -> DriftResult<u32> {
        let size_precision = 10_u128.pow(self.decimals);

        let size_in_amm_reserve_precision = if size_precision > AMM_RESERVE_PRECISION {
            size / (size_precision / AMM_RESERVE_PRECISION)
        } else {
            (size * AMM_RESERVE_PRECISION) / size_precision
        };

        let default_asset_weight = match margin_requirement_type {
            MarginRequirementType::Initial => self.get_scaled_initial_asset_weight(oracle_price)?,
            MarginRequirementType::Fill => {
                self.get_scaled_initial_asset_weight(oracle_price)?
                    .safe_add(self.maintenance_asset_weight)?
                    / 2
            }
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

    pub fn get_scaled_initial_asset_weight(&self, oracle_price: i64) -> DriftResult<u32> {
        if self.scale_initial_asset_weight_start == 0 {
            return Ok(self.initial_asset_weight);
        }

        let deposits = self.get_deposits()?;
        let deposit_value =
            get_token_value(deposits.cast()?, self.decimals, oracle_price)?.cast::<u128>()?;

        let scale_initial_asset_weight_start =
            self.scale_initial_asset_weight_start.cast::<u128>()?;
        let asset_weight = if deposit_value < scale_initial_asset_weight_start {
            self.initial_asset_weight
        } else {
            self.initial_asset_weight
                .cast::<u128>()?
                .safe_mul(scale_initial_asset_weight_start)?
                .safe_div(deposit_value)?
                .cast::<u32>()?
        };

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
            MarginRequirementType::Fill => {
                self.initial_liability_weight
                    .safe_add(self.maintenance_liability_weight)?
                    / 2
            }
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
            MarginRequirementType::Fill => return Err(ErrorCode::DefaultError),
            MarginRequirementType::Maintenance => self.maintenance_liability_weight,
        };
        liability_weight.safe_sub(MARGIN_PRECISION)
    }

    pub fn get_deposits(&self) -> DriftResult<u128> {
        get_token_amount(self.deposit_balance, self, &SpotBalanceType::Deposit)
    }

    pub fn get_borrows(&self) -> DriftResult<u128> {
        get_token_amount(self.borrow_balance, self, &SpotBalanceType::Borrow)
    }

    pub fn validate_max_token_deposits(&self) -> DriftResult {
        let deposits = self.get_deposits()?;
        let max_token_deposits = self.max_token_deposits.cast::<u128>()?;

        validate!(
            max_token_deposits == 0 || deposits <= max_token_deposits,
            ErrorCode::MaxDeposit,
            "max token amount ({}) < deposits ({})",
            max_token_deposits,
            deposits,
        )?;

        Ok(())
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
    /// full priviledge
    Collateral,
    /// collateral, but no borrow
    Protected,
    /// not collateral, allow multi-borrow
    Cross,
    /// not collateral, only single borrow
    Isolated,
    /// no privilege
    Unlisted,
}

impl Default for AssetTier {
    fn default() -> Self {
        AssetTier::Unlisted
    }
}

#[zero_copy(unsafe)]
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
