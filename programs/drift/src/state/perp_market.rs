use anchor_lang::prelude::*;

use std::cmp::max;

use crate::controller::position::{PositionDelta, PositionDirection};
use crate::error::{DriftResult, ErrorCode};
use crate::math::amm;
use crate::math::casting::Cast;
#[cfg(test)]
use crate::math::constants::{
    AMM_RESERVE_PRECISION, MAX_CONCENTRATION_COEFFICIENT, PRICE_PRECISION_I64,
};
use crate::math::constants::{
    AMM_RESERVE_PRECISION_I128, AMM_TO_QUOTE_PRECISION_RATIO, BID_ASK_SPREAD_PRECISION,
    BID_ASK_SPREAD_PRECISION_U128, DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT,
    LIQUIDATION_FEE_PRECISION, LP_FEE_SLICE_DENOMINATOR, LP_FEE_SLICE_NUMERATOR, MARGIN_PRECISION,
    MARGIN_PRECISION_U128, MAX_LIQUIDATION_MULTIPLIER, PEG_PRECISION, PERCENTAGE_PRECISION,
    PERCENTAGE_PRECISION_I128, PERCENTAGE_PRECISION_I64, PERCENTAGE_PRECISION_U64, PRICE_PRECISION,
    SPOT_WEIGHT_PRECISION, TWENTY_FOUR_HOUR,
};
use crate::math::helpers::get_proportion_i128;
use crate::math::margin::{
    calculate_size_discount_asset_weight, calculate_size_premium_liability_weight,
    MarginRequirementType,
};
use crate::math::safe_math::SafeMath;
use crate::math::stats;
use crate::state::events::OrderActionExplanation;
use num_integer::Roots;

use crate::state::oracle::{
    get_prelaunch_price, get_sb_on_demand_price, get_switchboard_price, HistoricalOracleData,
    OracleSource,
};
use crate::state::spot_market::{AssetTier, SpotBalance, SpotBalanceType};
use crate::state::traits::{MarketIndexOffset, Size};
use borsh::{BorshDeserialize, BorshSerialize};

use crate::state::paused_operations::PerpOperation;
use drift_macros::assert_no_slop;
use static_assertions::const_assert_eq;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq, Default)]
pub enum MarketStatus {
    /// warm up period for initialization, fills are paused
    #[default]
    Initialized,
    /// all operations allowed
    Active,
    /// Deprecated in favor of PausedOperations
    FundingPaused,
    /// Deprecated in favor of PausedOperations
    AmmPaused,
    /// Deprecated in favor of PausedOperations
    FillPaused,
    /// Deprecated in favor of PausedOperations
    WithdrawPaused,
    /// fills only able to reduce liability
    ReduceOnly,
    /// market has determined settlement price and positions are expired must be settled
    Settlement,
    /// market has no remaining participants
    Delisted,
}

impl MarketStatus {
    pub fn validate_not_deprecated(&self) -> DriftResult {
        if matches!(
            self,
            MarketStatus::FundingPaused
                | MarketStatus::AmmPaused
                | MarketStatus::FillPaused
                | MarketStatus::WithdrawPaused
        ) {
            msg!("MarketStatus is deprecated");
            Err(ErrorCode::DefaultError)
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq, Default)]
pub enum ContractType {
    #[default]
    Perpetual,
    Future,
    Prediction,
}

#[derive(
    Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq, PartialOrd, Ord, Default,
)]
pub enum ContractTier {
    /// max insurance capped at A level
    A,
    /// max insurance capped at B level
    B,
    /// max insurance capped at C level
    C,
    /// no insurance
    Speculative,
    /// no insurance, another tranches below
    #[default]
    HighlySpeculative,
    /// no insurance, only single position allowed
    Isolated,
}

impl ContractTier {
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

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq, PartialOrd, Ord)]
pub enum AMMLiquiditySplit {
    ProtocolOwned,
    LPOwned,
    Shared,
}

impl AMMLiquiditySplit {
    pub fn get_order_action_explanation(&self) -> OrderActionExplanation {
        match &self {
            AMMLiquiditySplit::ProtocolOwned => OrderActionExplanation::OrderFilledWithAMMJit,
            AMMLiquiditySplit::LPOwned => OrderActionExplanation::OrderFilledWithLPJit,
            AMMLiquiditySplit::Shared => OrderActionExplanation::OrderFilledWithAMMJitLPSplit,
        }
    }
}

#[account(zero_copy(unsafe))]
#[derive(Eq, PartialEq, Debug)]
#[repr(C)]
pub struct PerpMarket {
    /// The perp market's address. It is a pda of the market index
    pub pubkey: Pubkey,
    /// The automated market maker
    pub amm: AMM,
    /// The market's pnl pool. When users settle negative pnl, the balance increases.
    /// When users settle positive pnl, the balance decreases. Can not go negative.
    pub pnl_pool: PoolBalance,
    /// Encoded display name for the perp market e.g. SOL-PERP
    pub name: [u8; 32],
    /// The perp market's claim on the insurance fund
    pub insurance_claim: InsuranceClaim,
    /// The max pnl imbalance before positive pnl asset weight is discounted
    /// pnl imbalance is the difference between long and short pnl. When it's greater than 0,
    /// the amm has negative pnl and the initial asset weight for positive pnl is discounted
    /// precision = QUOTE_PRECISION
    pub unrealized_pnl_max_imbalance: u64,
    /// The ts when the market will be expired. Only set if market is in reduce only mode
    pub expiry_ts: i64,
    /// The price at which positions will be settled. Only set if market is expired
    /// precision = PRICE_PRECISION
    pub expiry_price: i64,
    /// Every trade has a fill record id. This is the next id to be used
    pub next_fill_record_id: u64,
    /// Every funding rate update has a record id. This is the next id to be used
    pub next_funding_rate_record_id: u64,
    /// Every amm k updated has a record id. This is the next id to be used
    pub next_curve_record_id: u64,
    /// The initial margin fraction factor. Used to increase margin ratio for large positions
    /// precision: MARGIN_PRECISION
    pub imf_factor: u32,
    /// The imf factor for unrealized pnl. Used to discount asset weight for large positive pnl
    /// precision: MARGIN_PRECISION
    pub unrealized_pnl_imf_factor: u32,
    /// The fee the liquidator is paid for taking over perp position
    /// precision: LIQUIDATOR_FEE_PRECISION
    pub liquidator_fee: u32,
    /// The fee the insurance fund receives from liquidation
    /// precision: LIQUIDATOR_FEE_PRECISION
    pub if_liquidation_fee: u32,
    /// The margin ratio which determines how much collateral is required to open a position
    /// e.g. margin ratio of .1 means a user must have $100 of total collateral to open a $1000 position
    /// precision: MARGIN_PRECISION
    pub margin_ratio_initial: u32,
    /// The margin ratio which determines when a user will be liquidated
    /// e.g. margin ratio of .05 means a user must have $50 of total collateral to maintain a $1000 position
    /// else they will be liquidated
    /// precision: MARGIN_PRECISION
    pub margin_ratio_maintenance: u32,
    /// The initial asset weight for positive pnl. Negative pnl always has an asset weight of 1
    /// precision: SPOT_WEIGHT_PRECISION
    pub unrealized_pnl_initial_asset_weight: u32,
    /// The maintenance asset weight for positive pnl. Negative pnl always has an asset weight of 1
    /// precision: SPOT_WEIGHT_PRECISION
    pub unrealized_pnl_maintenance_asset_weight: u32,
    /// number of users in a position (base)
    pub number_of_users_with_base: u32,
    /// number of users in a position (pnl) or pnl (quote)
    pub number_of_users: u32,
    pub market_index: u16,
    /// Whether a market is active, reduce only, expired, etc
    /// Affects whether users can open/close positions
    pub status: MarketStatus,
    /// Currently only Perpetual markets are supported
    pub contract_type: ContractType,
    /// The contract tier determines how much insurance a market can receive, with more speculative markets receiving less insurance
    /// It also influences the order perp markets can be liquidated, with less speculative markets being liquidated first
    pub contract_tier: ContractTier,
    pub paused_operations: u8,
    /// The spot market that pnl is settled in
    pub quote_spot_market_index: u16,
    /// Between -100 and 100, represents what % to increase/decrease the fee by
    /// E.g. if this is -50 and the fee is 5bps, the new fee will be 2.5bps
    /// if this is 50 and the fee is 5bps, the new fee will be 7.5bps
    pub fee_adjustment: i16,
    /// fuel multiplier for perp funding
    /// precision: 10
    pub fuel_boost_position: u8,
    /// fuel multiplier for perp taker
    /// precision: 10
    pub fuel_boost_taker: u8,
    /// fuel multiplier for perp maker
    /// precision: 10
    pub fuel_boost_maker: u8,
    pub padding: [u8; 43],
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
            paused_operations: 0,
            quote_spot_market_index: 0,
            fee_adjustment: 0,
            fuel_boost_position: 0,
            fuel_boost_taker: 0,
            fuel_boost_maker: 0,
            padding: [0; 43],
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
    pub fn is_in_settlement(&self, now: i64) -> bool {
        let in_settlement = matches!(
            self.status,
            MarketStatus::Settlement | MarketStatus::Delisted
        );
        let expired = self.expiry_ts != 0 && now >= self.expiry_ts;
        in_settlement || expired
    }

    pub fn is_reduce_only(&self) -> DriftResult<bool> {
        Ok(self.status == MarketStatus::ReduceOnly)
    }

    pub fn is_operation_paused(&self, operation: PerpOperation) -> bool {
        PerpOperation::is_operation_paused(self.paused_operations, operation)
    }

    pub fn has_too_much_drawdown(&self) -> DriftResult<bool> {
        let quote_drawdown_limit_breached = match self.contract_tier {
            ContractTier::A | ContractTier::B => {
                self.amm.net_revenue_since_last_funding
                    <= DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT * 400
            }
            _ => {
                self.amm.net_revenue_since_last_funding
                    <= DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT * 200
            }
        };

        if quote_drawdown_limit_breached {
            let percent_drawdown = self
                .amm
                .net_revenue_since_last_funding
                .cast::<i128>()?
                .safe_mul(PERCENTAGE_PRECISION_I128)?
                .safe_div(self.amm.total_fee_minus_distributions.max(1))?;

            let percent_drawdown_limit_breached = match self.contract_tier {
                ContractTier::A => percent_drawdown <= -PERCENTAGE_PRECISION_I128 / 50,
                ContractTier::B => percent_drawdown <= -PERCENTAGE_PRECISION_I128 / 33,
                ContractTier::C => percent_drawdown <= -PERCENTAGE_PRECISION_I128 / 25,
                _ => percent_drawdown <= -PERCENTAGE_PRECISION_I128 / 20,
            };

            if percent_drawdown_limit_breached {
                msg!("AMM has too much on-the-hour drawdown (percentage={}, quote={}) to accept fills",
                percent_drawdown,
                self.amm.net_revenue_since_last_funding
            );
                return Ok(true);
            }
        }

        Ok(false)
    }

    pub fn get_max_confidence_interval_multiplier(self) -> DriftResult<u64> {
        // assuming validity_guard_rails max confidence pct is 2%
        Ok(match self.contract_tier {
            ContractTier::A => 1,                  // 2%
            ContractTier::B => 1,                  // 2%
            ContractTier::C => 2,                  // 4%
            ContractTier::Speculative => 10,       // 20%
            ContractTier::HighlySpeculative => 50, // 100%
            ContractTier::Isolated => 50,          // 100%
        })
    }

    pub fn get_sanitize_clamp_denominator(self) -> DriftResult<Option<i64>> {
        Ok(match self.contract_tier {
            ContractTier::A => Some(10_i64),         // 10%
            ContractTier::B => Some(5_i64),          // 20%
            ContractTier::C => Some(2_i64),          // 50%
            ContractTier::Speculative => None, // DEFAULT_MAX_TWAP_UPDATE_PRICE_BAND_DENOMINATOR
            ContractTier::HighlySpeculative => None, // DEFAULT_MAX_TWAP_UPDATE_PRICE_BAND_DENOMINATOR
            ContractTier::Isolated => None, // DEFAULT_MAX_TWAP_UPDATE_PRICE_BAND_DENOMINATOR
        })
    }

    pub fn get_auction_end_min_max_divisors(self) -> DriftResult<(u64, u64)> {
        Ok(match self.contract_tier {
            ContractTier::A => (1000, 50),              // 10 bps, 2%
            ContractTier::B => (1000, 20),              // 10 bps, 5%
            ContractTier::C => (500, 20),               // 50 bps, 5%
            ContractTier::Speculative => (100, 10),     // 1%, 10%
            ContractTier::HighlySpeculative => (50, 5), // 2%, 20%
            ContractTier::Isolated => (50, 5),          // 2%, 20%
        })
    }

    pub fn get_max_price_divergence_for_funding_rate(
        self,
        oracle_price_twap: i64,
    ) -> DriftResult<i64> {
        // clamp to to 3% price divergence for safer markets and higher for lower contract tiers
        if self.contract_tier.is_as_safe_as_contract(&ContractTier::B) {
            oracle_price_twap.safe_div(33) // 3%
        } else if self.contract_tier.is_as_safe_as_contract(&ContractTier::C) {
            oracle_price_twap.safe_div(20) // 5%
        } else {
            oracle_price_twap.safe_div(10) // 10%
        }
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
            MarginRequirementType::Fill => {
                self.margin_ratio_initial
                    .safe_add(self.margin_ratio_maintenance)?
                    / 2
            }
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

    pub fn get_max_liquidation_fee(&self) -> DriftResult<u32> {
        let max_liquidation_fee = (self.liquidator_fee.safe_mul(MAX_LIQUIDATION_MULTIPLIER)?).min(
            self.margin_ratio_maintenance
                .safe_mul(LIQUIDATION_FEE_PRECISION / MARGIN_PRECISION)
                .unwrap_or(u32::MAX),
        );
        Ok(max_liquidation_fee)
    }

    pub fn get_unrealized_asset_weight(
        &self,
        unrealized_pnl: i128,
        margin_type: MarginRequirementType,
    ) -> DriftResult<u32> {
        let mut margin_asset_weight = match margin_type {
            MarginRequirementType::Initial | MarginRequirementType::Fill => {
                self.unrealized_pnl_initial_asset_weight
            }
            MarginRequirementType::Maintenance => self.unrealized_pnl_maintenance_asset_weight,
        };

        if margin_asset_weight > 0
            && matches!(
                margin_type,
                MarginRequirementType::Fill | MarginRequirementType::Initial
            )
            && self.unrealized_pnl_max_imbalance > 0
        {
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
                MarginRequirementType::Initial | MarginRequirementType::Fill => {
                    if margin_asset_weight > 0 {
                        calculate_size_discount_asset_weight(
                            unrealized_pnl
                                .unsigned_abs()
                                .safe_mul(AMM_TO_QUOTE_PRECISION_RATIO)?,
                            self.unrealized_pnl_imf_factor,
                            margin_asset_weight,
                        )?
                    } else {
                        0
                    }
                }
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

    pub fn get_market_depth_for_funding_rate(&self) -> DriftResult<u64> {
        // base amount used on user orders for funding calculation

        let open_interest = self.get_open_interest();

        let depth = (open_interest.safe_div(1000)?.cast::<u64>()?).clamp(
            self.amm.min_order_size.safe_mul(100)?,
            self.amm.min_order_size.safe_mul(5000)?,
        );

        Ok(depth)
    }

    pub fn update_market_with_counterparty(
        &mut self,
        delta: &PositionDelta,
        new_settled_base_asset_amount: i64,
    ) -> DriftResult {
        // indicates that position delta is settling lp counterparty
        if delta.remainder_base_asset_amount.is_some() {
            // todo: name for this is confusing, but adding is correct as is
            // definition: net position of users in the market that has the LP as a counterparty (which have NOT settled)
            self.amm.base_asset_amount_with_unsettled_lp = self
                .amm
                .base_asset_amount_with_unsettled_lp
                .safe_add(new_settled_base_asset_amount.cast()?)?;

            self.amm.quote_asset_amount_with_unsettled_lp = self
                .amm
                .quote_asset_amount_with_unsettled_lp
                .safe_add(delta.quote_asset_amount.cast()?)?;
        }

        Ok(())
    }

    pub fn is_price_divergence_ok_for_settle_pnl(&self, oracle_price: i64) -> DriftResult<bool> {
        let oracle_divergence = oracle_price
            .safe_sub(self.amm.historical_oracle_data.last_oracle_price_twap_5min)?
            .safe_mul(PERCENTAGE_PRECISION_I64)?
            .safe_div(
                self.amm
                    .historical_oracle_data
                    .last_oracle_price_twap_5min
                    .min(oracle_price),
            )?
            .unsigned_abs();

        let oracle_divergence_limit = match self.contract_tier {
            ContractTier::A => PERCENTAGE_PRECISION_U64 / 200, // 50 bps
            ContractTier::B => PERCENTAGE_PRECISION_U64 / 200, // 50 bps
            ContractTier::C => PERCENTAGE_PRECISION_U64 / 100, // 100 bps
            ContractTier::Speculative => PERCENTAGE_PRECISION_U64 / 40, // 250 bps
            ContractTier::HighlySpeculative => PERCENTAGE_PRECISION_U64 / 40, // 250 bps
            ContractTier::Isolated => PERCENTAGE_PRECISION_U64 / 40, // 250 bps
        };

        if oracle_divergence >= oracle_divergence_limit {
            msg!(
                "market_index={} price divergence too large to safely settle pnl: {} >= {}",
                self.market_index,
                oracle_divergence,
                oracle_divergence_limit
            );
            return Ok(false);
        }

        let min_price =
            oracle_price.min(self.amm.historical_oracle_data.last_oracle_price_twap_5min);

        let std_limit = match self.contract_tier {
            ContractTier::A => min_price / 50,                 // 200 bps
            ContractTier::B => min_price / 50,                 // 200 bps
            ContractTier::C => min_price / 20,                 // 500 bps
            ContractTier::Speculative => min_price / 10,       // 1000 bps
            ContractTier::HighlySpeculative => min_price / 10, // 1000 bps
            ContractTier::Isolated => min_price / 10,          // 1000 bps
        }
        .unsigned_abs();

        if self.amm.oracle_std.max(self.amm.mark_std) >= std_limit {
            msg!(
                "market_index={} std too large to safely settle pnl: {} >= {}",
                self.market_index,
                self.amm.oracle_std.max(self.amm.mark_std),
                std_limit
            );
            return Ok(false);
        }

        Ok(true)
    }

    pub fn can_sanitize_market_order_auctions(&self) -> bool {
        self.amm.oracle_source != OracleSource::Prelaunch
    }

    pub fn is_prediction_market(&self) -> bool {
        self.contract_type == ContractType::Prediction
    }

    pub fn get_quote_asset_reserve_prediction_market_bounds(
        &self,
        direction: PositionDirection,
    ) -> DriftResult<(u128, u128)> {
        let mut quote_asset_reserve_lower_bound = 0_u128;

        //precision scaling: 1e6 -> 1e12 -> 1e6
        let peg_sqrt = (self
            .amm
            .peg_multiplier
            .safe_mul(PEG_PRECISION)?
            .saturating_add(1))
        .nth_root(2)
        .saturating_add(1);

        // $1 limit
        let mut quote_asset_reserve_upper_bound = self
            .amm
            .sqrt_k
            .safe_mul(peg_sqrt)?
            .safe_div(self.amm.peg_multiplier)?;

        // for price [0,1] maintain following invariants:
        if direction == PositionDirection::Long {
            // lowest ask price is $0.05
            quote_asset_reserve_lower_bound = self
                .amm
                .sqrt_k
                .safe_mul(22361)?
                .safe_mul(peg_sqrt)?
                .safe_div(100000)?
                .safe_div(self.amm.peg_multiplier)?
        } else {
            // highest bid price is $0.95
            quote_asset_reserve_upper_bound = self
                .amm
                .sqrt_k
                .safe_mul(97467)?
                .safe_mul(peg_sqrt)?
                .safe_div(100000)?
                .safe_div(self.amm.peg_multiplier)?
        }

        Ok((
            quote_asset_reserve_lower_bound,
            quote_asset_reserve_upper_bound,
        ))
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

#[zero_copy(unsafe)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct InsuranceClaim {
    /// The amount of revenue last settled
    /// Positive if funds left the perp market,
    /// negative if funds were pulled into the perp market
    /// precision: QUOTE_PRECISION
    pub revenue_withdraw_since_last_settle: i64,
    /// The max amount of revenue that can be withdrawn per period
    /// precision: QUOTE_PRECISION
    pub max_revenue_withdraw_per_period: u64,
    /// The max amount of insurance that perp market can use to resolve bankruptcy and pnl deficits
    /// precision: QUOTE_PRECISION
    pub quote_max_insurance: u64,
    /// The amount of insurance that has been used to resolve bankruptcy and pnl deficits
    /// precision: QUOTE_PRECISION
    pub quote_settled_insurance: u64,
    /// The last time revenue was settled in/out of market
    pub last_revenue_withdraw_ts: i64,
}

#[zero_copy(unsafe)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct PoolBalance {
    /// To get the pool's token amount, you must multiply the scaled balance by the market's cumulative
    /// deposit interest
    /// precision: SPOT_BALANCE_PRECISION
    pub scaled_balance: u128,
    /// The spot market the pool is for
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

#[assert_no_slop]
#[zero_copy(unsafe)]
#[derive(Debug, PartialEq, Eq)]
#[repr(C)]
pub struct AMM {
    /// oracle price data public key
    pub oracle: Pubkey,
    /// stores historically witnessed oracle data
    pub historical_oracle_data: HistoricalOracleData,
    /// accumulated base asset amount since inception per lp share
    /// precision: QUOTE_PRECISION
    pub base_asset_amount_per_lp: i128,
    /// accumulated quote asset amount since inception per lp share
    /// precision: QUOTE_PRECISION
    pub quote_asset_amount_per_lp: i128,
    /// partition of fees from perp market trading moved from pnl settlements
    pub fee_pool: PoolBalance,
    /// `x` reserves for constant product mm formula (x * y = k)
    /// precision: AMM_RESERVE_PRECISION
    pub base_asset_reserve: u128,
    /// `y` reserves for constant product mm formula (x * y = k)
    /// precision: AMM_RESERVE_PRECISION
    pub quote_asset_reserve: u128,
    /// determines how close the min/max base asset reserve sit vs base reserves
    /// allow for decreasing slippage without increasing liquidity and v.v.
    /// precision: PERCENTAGE_PRECISION
    pub concentration_coef: u128,
    /// minimum base_asset_reserve allowed before AMM is unavailable
    /// precision: AMM_RESERVE_PRECISION
    pub min_base_asset_reserve: u128,
    /// maximum base_asset_reserve allowed before AMM is unavailable
    /// precision: AMM_RESERVE_PRECISION
    pub max_base_asset_reserve: u128,
    /// `sqrt(k)` in constant product mm formula (x * y = k). stored to avoid drift caused by integer math issues
    /// precision: AMM_RESERVE_PRECISION
    pub sqrt_k: u128,
    /// normalizing numerical factor for y, its use offers lowest slippage in cp-curve when market is balanced
    /// precision: PEG_PRECISION
    pub peg_multiplier: u128,
    /// y when market is balanced. stored to save computation
    /// precision: AMM_RESERVE_PRECISION
    pub terminal_quote_asset_reserve: u128,
    /// always non-negative. tracks number of total longs in market (regardless of counterparty)
    /// precision: BASE_PRECISION
    pub base_asset_amount_long: i128,
    /// always non-positive. tracks number of total shorts in market (regardless of counterparty)
    /// precision: BASE_PRECISION
    pub base_asset_amount_short: i128,
    /// tracks net position (longs-shorts) in market with AMM as counterparty
    /// precision: BASE_PRECISION
    pub base_asset_amount_with_amm: i128,
    /// tracks net position (longs-shorts) in market with LPs as counterparty
    /// precision: BASE_PRECISION
    pub base_asset_amount_with_unsettled_lp: i128,
    /// max allowed open interest, blocks trades that breach this value
    /// precision: BASE_PRECISION
    pub max_open_interest: u128,
    /// sum of all user's perp quote_asset_amount in market
    /// precision: QUOTE_PRECISION
    pub quote_asset_amount: i128,
    /// sum of all long user's quote_entry_amount in market
    /// precision: QUOTE_PRECISION
    pub quote_entry_amount_long: i128,
    /// sum of all short user's quote_entry_amount in market
    /// precision: QUOTE_PRECISION
    pub quote_entry_amount_short: i128,
    /// sum of all long user's quote_break_even_amount in market
    /// precision: QUOTE_PRECISION
    pub quote_break_even_amount_long: i128,
    /// sum of all short user's quote_break_even_amount in market
    /// precision: QUOTE_PRECISION
    pub quote_break_even_amount_short: i128,
    /// total user lp shares of sqrt_k (protocol owned liquidity = sqrt_k - last_funding_rate)
    /// precision: AMM_RESERVE_PRECISION
    pub user_lp_shares: u128,
    /// last funding rate in this perp market (unit is quote per base)
    /// precision: QUOTE_PRECISION
    pub last_funding_rate: i64,
    /// last funding rate for longs in this perp market (unit is quote per base)
    /// precision: QUOTE_PRECISION
    pub last_funding_rate_long: i64,
    /// last funding rate for shorts in this perp market (unit is quote per base)
    /// precision: QUOTE_PRECISION
    pub last_funding_rate_short: i64,
    /// estimate of last 24h of funding rate perp market (unit is quote per base)
    /// precision: QUOTE_PRECISION
    pub last_24h_avg_funding_rate: i64,
    /// total fees collected by this perp market
    /// precision: QUOTE_PRECISION
    pub total_fee: i128,
    /// total fees collected by the vAMM's bid/ask spread
    /// precision: QUOTE_PRECISION
    pub total_mm_fee: i128,
    /// total fees collected by exchange fee schedule
    /// precision: QUOTE_PRECISION
    pub total_exchange_fee: u128,
    /// total fees minus any recognized upnl and pool withdraws
    /// precision: QUOTE_PRECISION
    pub total_fee_minus_distributions: i128,
    /// sum of all fees from fee pool withdrawn to revenue pool
    /// precision: QUOTE_PRECISION
    pub total_fee_withdrawn: u128,
    /// all fees collected by market for liquidations
    /// precision: QUOTE_PRECISION
    pub total_liquidation_fee: u128,
    /// accumulated funding rate for longs since inception in market
    pub cumulative_funding_rate_long: i128,
    /// accumulated funding rate for shorts since inception in market
    pub cumulative_funding_rate_short: i128,
    /// accumulated social loss paid by users since inception in market
    pub total_social_loss: u128,
    /// transformed base_asset_reserve for users going long
    /// precision: AMM_RESERVE_PRECISION
    pub ask_base_asset_reserve: u128,
    /// transformed quote_asset_reserve for users going long
    /// precision: AMM_RESERVE_PRECISION
    pub ask_quote_asset_reserve: u128,
    /// transformed base_asset_reserve for users going short
    /// precision: AMM_RESERVE_PRECISION
    pub bid_base_asset_reserve: u128,
    /// transformed quote_asset_reserve for users going short
    /// precision: AMM_RESERVE_PRECISION
    pub bid_quote_asset_reserve: u128,
    /// the last seen oracle price partially shrunk toward the amm reserve price
    /// precision: PRICE_PRECISION
    pub last_oracle_normalised_price: i64,
    /// the gap between the oracle price and the reserve price = y * peg_multiplier / x
    pub last_oracle_reserve_price_spread_pct: i64,
    /// average estimate of bid price over funding_period
    /// precision: PRICE_PRECISION
    pub last_bid_price_twap: u64,
    /// average estimate of ask price over funding_period
    /// precision: PRICE_PRECISION
    pub last_ask_price_twap: u64,
    /// average estimate of (bid+ask)/2 price over funding_period
    /// precision: PRICE_PRECISION
    pub last_mark_price_twap: u64,
    /// average estimate of (bid+ask)/2 price over FIVE_MINUTES
    pub last_mark_price_twap_5min: u64,
    /// the last blockchain slot the amm was updated
    pub last_update_slot: u64,
    /// the pct size of the oracle confidence interval
    /// precision: PERCENTAGE_PRECISION
    pub last_oracle_conf_pct: u64,
    /// the total_fee_minus_distribution change since the last funding update
    /// precision: QUOTE_PRECISION
    pub net_revenue_since_last_funding: i64,
    /// the last funding rate update unix_timestamp
    pub last_funding_rate_ts: i64,
    /// the peridocity of the funding rate updates
    pub funding_period: i64,
    /// the base step size (increment) of orders
    /// precision: BASE_PRECISION
    pub order_step_size: u64,
    /// the price tick size of orders
    /// precision: PRICE_PRECISION
    pub order_tick_size: u64,
    /// the minimum base size of an order
    /// precision: BASE_PRECISION
    pub min_order_size: u64,
    /// the max base size a single user can have
    /// precision: BASE_PRECISION
    pub max_position_size: u64,
    /// estimated total of volume in market
    /// QUOTE_PRECISION
    pub volume_24h: u64,
    /// the volume intensity of long fills against AMM
    pub long_intensity_volume: u64,
    /// the volume intensity of short fills against AMM
    pub short_intensity_volume: u64,
    /// the blockchain unix timestamp at the time of the last trade
    pub last_trade_ts: i64,
    /// estimate of standard deviation of the fill (mark) prices
    /// precision: PRICE_PRECISION
    pub mark_std: u64,
    /// estimate of standard deviation of the oracle price at each update
    /// precision: PRICE_PRECISION
    pub oracle_std: u64,
    /// the last unix_timestamp the mark twap was updated
    pub last_mark_price_twap_ts: i64,
    /// the minimum spread the AMM can quote. also used as step size for some spread logic increases.
    pub base_spread: u32,
    /// the maximum spread the AMM can quote
    pub max_spread: u32,
    /// the spread for asks vs the reserve price
    pub long_spread: u32,
    /// the spread for bids vs the reserve price
    pub short_spread: u32,
    /// the count intensity of long fills against AMM
    pub long_intensity_count: u32,
    /// the count intensity of short fills against AMM
    pub short_intensity_count: u32,
    /// the fraction of total available liquidity a single fill on the AMM can consume
    pub max_fill_reserve_fraction: u16,
    /// the maximum slippage a single fill on the AMM can push
    pub max_slippage_ratio: u16,
    /// the update intensity of AMM formulaic updates (adjusting k). 0-100
    pub curve_update_intensity: u8,
    /// the jit intensity of AMM. larger intensity means larger participation in jit. 0 means no jit participation.
    /// (0, 100] is intensity for protocol-owned AMM. (100, 200] is intensity for user LP-owned AMM.
    pub amm_jit_intensity: u8,
    /// the oracle provider information. used to decode/scale the oracle public key
    pub oracle_source: OracleSource,
    /// tracks whether the oracle was considered valid at the last AMM update
    pub last_oracle_valid: bool,
    /// the target value for `base_asset_amount_per_lp`, used during AMM JIT with LP split
    /// precision: BASE_PRECISION
    pub target_base_asset_amount_per_lp: i32,
    /// expo for unit of per_lp, base 10 (if per_lp_base=X, then per_lp unit is 10^X)
    pub per_lp_base: i8,
    pub padding1: u8,
    pub padding2: u16,
    pub total_fee_earned_per_lp: u64,
    pub net_unsettled_funding_pnl: i64,
    pub quote_asset_amount_with_unsettled_lp: i64,
    pub reference_price_offset: i32,
    pub padding: [u8; 12],
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
            target_base_asset_amount_per_lp: 0,
            per_lp_base: 0,
            padding1: 0,
            padding2: 0,
            total_fee_earned_per_lp: 0,
            net_unsettled_funding_pnl: 0,
            quote_asset_amount_with_unsettled_lp: 0,
            reference_price_offset: 0,
            padding: [0; 12],
        }
    }
}

impl AMM {
    pub fn get_fallback_price(
        self,
        direction: &PositionDirection,
        amm_available_liquidity: u64,
        oracle_price: i64,
        seconds_til_order_expiry: i64,
    ) -> DriftResult<u64> {
        // PRICE_PRECISION
        if direction.eq(&PositionDirection::Long) {
            // pick amm ask + buffer if theres liquidity
            // otherwise be aggressive vs oracle + 1hr premium
            if amm_available_liquidity >= self.min_order_size {
                let reserve_price = self.reserve_price()?;
                let amm_ask_price: i64 = self.ask_price(reserve_price)?.cast()?;
                amm_ask_price
                    .safe_add(amm_ask_price / (seconds_til_order_expiry * 20).clamp(100, 200))?
                    .cast::<u64>()
            } else {
                oracle_price
                    .safe_add(
                        self.last_ask_price_twap
                            .cast::<i64>()?
                            .safe_sub(self.historical_oracle_data.last_oracle_price_twap)?
                            .max(0),
                    )?
                    .safe_add(oracle_price / (seconds_til_order_expiry * 2).clamp(10, 50))?
                    .cast::<u64>()
            }
        } else {
            // pick amm bid - buffer if theres liquidity
            // otherwise be aggressive vs oracle + 1hr bid premium
            if amm_available_liquidity >= self.min_order_size {
                let reserve_price = self.reserve_price()?;
                let amm_bid_price: i64 = self.bid_price(reserve_price)?.cast()?;
                amm_bid_price
                    .safe_sub(amm_bid_price / (seconds_til_order_expiry * 20).clamp(100, 200))?
                    .cast::<u64>()
            } else {
                oracle_price
                    .safe_add(
                        self.last_bid_price_twap
                            .cast::<i64>()?
                            .safe_sub(self.historical_oracle_data.last_oracle_price_twap)?
                            .min(0),
                    )?
                    .safe_sub(oracle_price / (seconds_til_order_expiry * 2).clamp(10, 50))?
                    .max(0)
                    .cast::<u64>()
            }
        }
    }

    pub fn get_lower_bound_sqrt_k(self) -> DriftResult<u128> {
        Ok(self.sqrt_k.min(
            self.user_lp_shares
                .safe_add(self.user_lp_shares.safe_div(1000)?)?
                .max(self.min_order_size.cast()?)
                .max(self.base_asset_amount_with_amm.unsigned_abs().cast()?),
        ))
    }

    pub fn get_protocol_owned_position(self) -> DriftResult<i64> {
        self.base_asset_amount_with_amm
            .safe_add(self.base_asset_amount_with_unsettled_lp)?
            .cast::<i64>()
    }

    pub fn get_max_reference_price_offset(self) -> DriftResult<i64> {
        if self.curve_update_intensity <= 100 {
            return Ok(0);
        }

        let lower_bound_multiplier: i64 =
            self.curve_update_intensity.safe_sub(100)?.cast::<i64>()?;

        // always allow 1-100 bps of price offset, up to a fifth of the market's max_spread
        let lb_bps =
            (PERCENTAGE_PRECISION.cast::<i64>()? / 10000).safe_mul(lower_bound_multiplier)?;
        let max_offset = (self.max_spread.cast::<i64>()? / 5).max(lb_bps);

        Ok(max_offset)
    }

    pub fn get_per_lp_base_unit(self) -> DriftResult<i128> {
        let scalar: i128 = 10_i128.pow(self.per_lp_base.abs().cast()?);

        if self.per_lp_base > 0 {
            AMM_RESERVE_PRECISION_I128.safe_mul(scalar)
        } else {
            AMM_RESERVE_PRECISION_I128.safe_div(scalar)
        }
    }

    pub fn calculate_lp_base_delta(
        &self,
        per_lp_delta_base: i128,
        base_unit: i128,
    ) -> DriftResult<i128> {
        // calculate dedicated for user lp shares
        let lp_delta_base =
            get_proportion_i128(per_lp_delta_base, self.user_lp_shares, base_unit.cast()?)?;

        Ok(lp_delta_base)
    }

    pub fn calculate_per_lp_delta(
        &self,
        delta: &PositionDelta,
        fee_to_market: i128,
        liquidity_split: AMMLiquiditySplit,
        base_unit: i128,
    ) -> DriftResult<(i128, i128, i128)> {
        let total_lp_shares = if liquidity_split == AMMLiquiditySplit::LPOwned {
            self.user_lp_shares
        } else {
            self.sqrt_k
        };

        // update Market per lp position
        let per_lp_delta_base = get_proportion_i128(
            delta.base_asset_amount.cast()?,
            base_unit.cast()?,
            total_lp_shares, //.safe_div_ceil(rebase_divisor.cast()?)?,
        )?;

        let mut per_lp_delta_quote = get_proportion_i128(
            delta.quote_asset_amount.cast()?,
            base_unit.cast()?,
            total_lp_shares, //.safe_div_ceil(rebase_divisor.cast()?)?,
        )?;

        // user position delta is short => lp position delta is long
        if per_lp_delta_base < 0 {
            // add one => lp subtract 1
            per_lp_delta_quote = per_lp_delta_quote.safe_add(1)?;
        }

        // 1/5 of fee auto goes to market
        // the rest goes to lps/market proportional
        let per_lp_fee: i128 = if fee_to_market > 0 {
            get_proportion_i128(
                fee_to_market,
                LP_FEE_SLICE_NUMERATOR,
                LP_FEE_SLICE_DENOMINATOR,
            )?
            .safe_mul(base_unit)?
            .safe_div(total_lp_shares.cast::<i128>()?)?
        } else {
            0
        };

        Ok((per_lp_delta_base, per_lp_delta_quote, per_lp_fee))
    }

    pub fn get_target_base_asset_amount_per_lp(&self) -> DriftResult<i128> {
        if self.target_base_asset_amount_per_lp == 0 {
            return Ok(0_i128);
        }

        let target_base_asset_amount_per_lp: i128 = if self.per_lp_base > 0 {
            let rebase_divisor = 10_i128.pow(self.per_lp_base.abs().cast()?);
            self.target_base_asset_amount_per_lp
                .cast::<i128>()?
                .safe_mul(rebase_divisor)?
        } else if self.per_lp_base < 0 {
            let rebase_divisor = 10_i128.pow(self.per_lp_base.abs().cast()?);
            self.target_base_asset_amount_per_lp
                .cast::<i128>()?
                .safe_div(rebase_divisor)?
        } else {
            self.target_base_asset_amount_per_lp.cast::<i128>()?
        };

        Ok(target_base_asset_amount_per_lp)
    }

    pub fn imbalanced_base_asset_amount_with_lp(&self) -> DriftResult<i128> {
        let target_lp_gap = self
            .base_asset_amount_per_lp
            .safe_sub(self.get_target_base_asset_amount_per_lp()?)?;

        let base_unit = self.get_per_lp_base_unit()?.cast()?;

        get_proportion_i128(target_lp_gap, self.user_lp_shares, base_unit)
    }

    pub fn amm_wants_to_jit_make(&self, taker_direction: PositionDirection) -> DriftResult<bool> {
        let amm_wants_to_jit_make = match taker_direction {
            PositionDirection::Long => {
                self.base_asset_amount_with_amm < -(self.order_step_size.cast()?)
            }
            PositionDirection::Short => {
                self.base_asset_amount_with_amm > (self.order_step_size.cast()?)
            }
        };
        Ok(amm_wants_to_jit_make && self.amm_jit_is_active())
    }

    pub fn amm_lp_wants_to_jit_make(
        &self,
        taker_direction: PositionDirection,
    ) -> DriftResult<bool> {
        if self.user_lp_shares == 0 {
            return Ok(false);
        }

        let amm_lp_wants_to_jit_make = match taker_direction {
            PositionDirection::Long => {
                self.base_asset_amount_per_lp > self.get_target_base_asset_amount_per_lp()?
            }
            PositionDirection::Short => {
                self.base_asset_amount_per_lp < self.get_target_base_asset_amount_per_lp()?
            }
        };
        Ok(amm_lp_wants_to_jit_make && self.amm_lp_jit_is_active())
    }

    pub fn amm_lp_allowed_to_jit_make(&self, amm_wants_to_jit_make: bool) -> DriftResult<bool> {
        // only allow lps to make when the amm inventory is below a certain level of available liquidity
        // i.e. 10%
        if amm_wants_to_jit_make {
            // inventory scale
            let (max_bids, max_asks) = amm::_calculate_market_open_bids_asks(
                self.base_asset_reserve,
                self.min_base_asset_reserve,
                self.max_base_asset_reserve,
            )?;

            let min_side_liquidity = max_bids.min(max_asks.abs());
            let protocol_owned_min_side_liquidity = get_proportion_i128(
                min_side_liquidity,
                self.sqrt_k.safe_sub(self.user_lp_shares)?,
                self.sqrt_k,
            )?;

            Ok(self.base_asset_amount_with_amm.abs()
                < protocol_owned_min_side_liquidity.safe_div(10)?)
        } else {
            Ok(true)
        }
    }

    pub fn amm_jit_is_active(&self) -> bool {
        self.amm_jit_intensity > 0
    }

    pub fn amm_lp_jit_is_active(&self) -> bool {
        self.amm_jit_intensity > 100
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

    pub fn last_ask_premium(&self) -> DriftResult<i64> {
        let reserve_price = self.reserve_price()?;
        let ask_price = self.ask_price(reserve_price)?.cast::<i64>()?;
        ask_price.safe_sub(self.historical_oracle_data.last_oracle_price)
    }

    pub fn last_bid_discount(&self) -> DriftResult<i64> {
        let reserve_price = self.reserve_price()?;
        let bid_price = self.bid_price(reserve_price)?.cast::<i64>()?;
        self.historical_oracle_data
            .last_oracle_price
            .safe_sub(bid_price)
    }

    pub fn can_lower_k(&self) -> DriftResult<bool> {
        let (max_bids, max_asks) = amm::calculate_market_open_bids_asks(self)?;
        let can_lower = self.base_asset_amount_with_amm.unsigned_abs()
            < max_bids.unsigned_abs().min(max_asks.unsigned_abs())
            && self.base_asset_amount_with_amm.unsigned_abs()
                < self.sqrt_k.safe_sub(self.user_lp_shares)?;
        Ok(can_lower)
    }

    pub fn get_oracle_twap(
        &self,
        price_oracle: &AccountInfo,
        slot: u64,
    ) -> DriftResult<Option<i64>> {
        match self.oracle_source {
            OracleSource::Pyth | OracleSource::PythStableCoin => {
                Ok(Some(self.get_pyth_twap(price_oracle, 1, false)?))
            }
            OracleSource::Pyth1K => Ok(Some(self.get_pyth_twap(price_oracle, 1000, false)?)),
            OracleSource::Pyth1M => Ok(Some(self.get_pyth_twap(price_oracle, 1000000, false)?)),
            OracleSource::Switchboard => Ok(Some(get_switchboard_price(price_oracle, slot)?.price)),
            OracleSource::SwitchboardOnDemand => {
                Ok(Some(get_sb_on_demand_price(price_oracle, slot)?.price))
            }
            OracleSource::QuoteAsset => {
                msg!("Can't get oracle twap for quote asset");
                Err(ErrorCode::DefaultError)
            }
            OracleSource::Prelaunch => Ok(Some(get_prelaunch_price(price_oracle, slot)?.price)),
            OracleSource::PythPull | OracleSource::PythStableCoinPull => {
                Ok(Some(self.get_pyth_twap(price_oracle, 1, true)?))
            }
            OracleSource::Pyth1KPull => Ok(Some(self.get_pyth_twap(price_oracle, 1000, true)?)),
            OracleSource::Pyth1MPull => {
                Ok(Some(self.get_pyth_twap(price_oracle, 1000000, true)?))
            }
        }
    }

    pub fn get_pyth_twap(
        &self,
        price_oracle: &AccountInfo,
        multiple: u128,
        is_pull_oracle: bool,
    ) -> DriftResult<i64> {
        let mut pyth_price_data: &[u8] = &price_oracle
            .try_borrow_data()
            .or(Err(ErrorCode::UnableToLoadOracle))?;

        let oracle_price: i64;
        let oracle_twap: i64;
        let oracle_exponent: i32;

        if is_pull_oracle {
            let price_message =
                pyth_solana_receiver_sdk::price_update::PriceUpdateV2::try_deserialize(
                    &mut pyth_price_data,
                )
                .or(Err(crate::error::ErrorCode::UnableToLoadOracle))?;
            oracle_price = price_message.price_message.price;
            oracle_twap = price_message.price_message.ema_price;
            oracle_exponent = price_message.price_message.exponent;
        } else {
            let price_data = pyth_client::cast::<pyth_client::Price>(pyth_price_data);
            oracle_price = price_data.agg.price;
            oracle_twap = price_data.twap.val;
            oracle_exponent = price_data.expo;
        }

        assert!(oracle_twap > oracle_price / 10);

        let oracle_precision = 10_u128
            .pow(oracle_exponent.unsigned_abs())
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

    pub fn get_new_oracle_conf_pct(
        &self,
        confidence: u64,    // price precision
        reserve_price: u64, // price precision
        now: i64,
    ) -> DriftResult<u64> {
        // use previous value decayed as lower bound to avoid shrinking too quickly
        let upper_bound_divisor = 21_u64;
        let lower_bound_divisor = 5_u64;
        let since_last = now
            .safe_sub(self.historical_oracle_data.last_oracle_price_twap_ts)?
            .max(0);

        let confidence_lower_bound = if since_last > 0 {
            let confidence_divisor = upper_bound_divisor
                .saturating_sub(since_last.cast::<u64>()?)
                .max(lower_bound_divisor);
            self.last_oracle_conf_pct
                .safe_sub(self.last_oracle_conf_pct / confidence_divisor)?
        } else {
            self.last_oracle_conf_pct
        };

        Ok(confidence
            .safe_mul(BID_ASK_SPREAD_PRECISION)?
            .safe_div(reserve_price)?
            .max(confidence_lower_bound))
    }

    pub fn is_recent_oracle_valid(&self, current_slot: u64) -> DriftResult<bool> {
        Ok(self.last_oracle_valid && current_slot == self.last_update_slot)
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
