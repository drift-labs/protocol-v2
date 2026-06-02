use anchor_lang::prelude::{
    borsh::{BorshDeserialize, BorshSerialize},
    *,
};

use super::oracle_map::OracleIdentifier;
#[cfg(test)]
use crate::math::constants::{AMM_RESERVE_PRECISION, MAX_CONCENTRATION_COEFFICIENT};
use crate::{
    amm::math::amm::{self},
    error::{DriftResult, ErrorCode},
    math::{
        casting::Cast,
        constants::{
            AMM_TO_QUOTE_PRECISION_RATIO, DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT,
            FUNDING_RATE_BUFFER_I128, FUNDING_RATE_OFFSET_PERCENTAGE, LIQUIDATION_FEE_PRECISION,
            MARGIN_PRECISION, MARGIN_PRECISION_U128, MAX_LIQUIDATION_MULTIPLIER,
            PERCENTAGE_PRECISION_I128, PERCENTAGE_PRECISION_I64, PERCENTAGE_PRECISION_U64,
            PRICE_PRECISION_I128, SPOT_WEIGHT_PRECISION,
        },
        margin::{
            calculate_size_discount_asset_weight, calculate_size_premium_liability_weight,
            MarginRequirementType,
        },
        oracle::{
            is_oracle_valid_for_action, oracle_validity, DriftAction, LogMode, OracleValidity,
        },
        safe_math::SafeMath,
    },
    msg,
    state::{
        fill_mode::FillMode,
        market_status::MarketStatus,
        oracle::{HistoricalOracleData, MMOraclePriceData, OraclePriceData, OracleSource},
        paused_operations::PerpOperation,
        spot_market::{AssetTier, SpotBalance, SpotBalanceType},
        state::{State, ValidityGuardRails},
        traits::{MarketIndexOffset, Size},
        user::{MarketType, Order},
    },
};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq, Default)]
pub enum LpStatus {
    /// Not considered
    #[default]
    Uncollateralized,
    /// all operations allowed
    Active,
    /// Decommissioning
    Decommissioning,
}

impl LpStatus {
    pub fn is_collateralized(&self) -> bool {
        !matches!(self, LpStatus::Uncollateralized)
    }
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq, Default)]
pub enum ContractType {
    #[default]
    Perpetual,
    DeprecatedFuture,
    DeprecatedPrediction,
}

#[derive(
    Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq, PartialOrd, Ord, Default,
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

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum MarketConfigFlag {
    DisableFormulaicKUpdate = 0b00000001,
}

#[account(zero_copy(unsafe))]
#[derive(Eq, PartialEq, Debug)]
#[repr(C)]
pub struct PerpMarket {
    /// The perp market's address. It is a pda of the market index
    pub pubkey: Pubkey,
    // u128/i128 fields placed first so the zero-copy struct's u128 fields hit
    // 16-byte alignment. Group: protocol-wide position counters / open interest.
    /// always non-negative. tracks number of total longs in market (regardless of counterparty)
    /// precision: BASE_PRECISION
    pub base_asset_amount_long: i128,
    /// always non-positive. tracks number of total shorts in market (regardless of counterparty)
    /// precision: BASE_PRECISION
    pub base_asset_amount_short: i128,
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
    /// max allowed open interest, blocks trades that breach this value
    /// precision: BASE_PRECISION
    pub max_open_interest: u128,
    /// accumulated social loss paid by users since inception in market
    /// precision: QUOTE_PRECISION
    pub total_social_loss: u128,
    /// accumulated funding rate for longs since inception in market
    pub cumulative_funding_rate_long: i128,
    /// accumulated funding rate for shorts since inception in market
    pub cumulative_funding_rate_short: i128,
    /// total fees collected by exchange fee schedule
    /// precision: QUOTE_PRECISION
    pub total_exchange_fee: u128,
    /// all fees collected by market for liquidations
    /// precision: QUOTE_PRECISION
    pub total_liquidation_fee: u128,
    /// oracle price data public key
    pub oracle: Pubkey,
    /// The market's pnl pool. When users settle negative pnl, the balance increases.
    /// When users settle positive pnl, the balance decreases. Can not go negative.
    pub pnl_pool: PoolBalance,
    /// Encoded display name for the perp market e.g. SOL-PERP
    pub name: [u8; 32],
    /// The perp market's claim on the insurance fund
    pub insurance_claim: InsuranceClaim,
    /// last funding rate in this perp market (unit is quote per base)
    /// precision: FUNDING_RATE_PRECISION
    pub last_funding_rate: i64,
    /// last funding rate for longs in this perp market (unit is quote per base)
    /// precision: FUNDING_RATE_PRECISION
    pub last_funding_rate_long: i64,
    /// last funding rate for shorts in this perp market (unit is quote per base)
    /// precision: QUOTE_PRECISION
    pub last_funding_rate_short: i64,
    /// the last funding rate update unix_timestamp
    pub last_funding_rate_ts: i64,
    /// unsettled funding pnl across the market (protocol-wide)
    pub net_unsettled_funding_pnl: i64,
    /// oracle TWAP captured at last funding update
    pub last_funding_oracle_twap: i64,
    /// the base step size (increment) of orders
    /// precision: BASE_PRECISION
    pub order_step_size: u64,
    /// the price tick size of orders
    /// precision: PRICE_PRECISION
    pub order_tick_size: u64,
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
    /// Explicit padding so the IDL records the 6 bytes the Rust compiler
    /// inserts to 8-align `last_fill_price`. Without this the JS borsh
    /// decoder (which reads sequentially after the variable-span enum
    /// `status`) reads every field past `fee_adjustment` 6 bytes early.
    pub _padding_align_lfp: [u8; 6],
    pub last_fill_price: u64,
    pub pool_id: u8,
    pub _padding_pmm: [u8; 2],
    pub lp_fee_transfer_scalar: u8,
    pub lp_status: u8,
    pub lp_paused_operations: u8,
    pub lp_exchange_fee_excluscion_scalar: u8,
    pub lp_pool_id: u8,
    pub market_config: u8,
    /// the oracle provider information. used to decode/scale the oracle public key
    pub oracle_source: OracleSource,
    /// override for the per-fill slot delay required from the oracle (default -1 = use state default)
    pub oracle_slot_delay_override: i8,
    /// the override for the state.min_perp_auction_duration
    /// 0 is no override, -1 is disable speed bump, 1-100 is literal speed bump
    pub oracle_low_risk_slot_delay_override: i8,
    /// Trailing padding so `market_stats` lands at the offset Rust naturally
    /// computes via `repr(C)` alignment and the `(SIZE - 8) % 16 == 0`
    /// invariant holds. Bumped to 36 bytes (was 28) when `next_curve_record_id`
    /// was removed.
    pub padding: [u8; 36],
    /// Market-wide stats shared across all makers: mark/oracle TWAPs, std,
    /// volume, intensity, mm-oracle snapshot, `historical_oracle_data`,
    /// `last_oracle_normalised_price`, `last_oracle_valid`. Writers (e.g.
    /// `MarketStats::update_mark_std`, `update_volume_24h`, native
    /// `handle_update_mm_oracle_native`) update this directly.
    pub market_stats: MarketStats,
    /// 8 bytes of explicit padding so MarketStats (216 bytes) plus this
    /// padding equals 224 bytes — the offset Rust naturally inserts to
    /// 16-align AMM's leading u128. Making it explicit keeps the IDL byte
    /// layout aligned with `repr(C)`.
    pub _padding_align_amm: [u8; 8],
    /// The automated market maker. Last field so a future excision into a
    /// dedicated AMM program is a clean truncate at this offset — `PerpMarket`
    /// minus the trailing `AMM` bytes equals the future "orderbook-only"
    /// account layout.
    pub amm: AMM,
}

impl Default for PerpMarket {
    fn default() -> Self {
        PerpMarket {
            pubkey: Pubkey::default(),
            base_asset_amount_long: 0,
            base_asset_amount_short: 0,
            quote_asset_amount: 0,
            quote_entry_amount_long: 0,
            quote_entry_amount_short: 0,
            quote_break_even_amount_long: 0,
            quote_break_even_amount_short: 0,
            max_open_interest: 0,
            total_social_loss: 0,
            cumulative_funding_rate_long: 0,
            cumulative_funding_rate_short: 0,
            total_exchange_fee: 0,
            total_liquidation_fee: 0,
            oracle: Pubkey::default(),
            pnl_pool: PoolBalance::default(),
            name: [0; 32],
            insurance_claim: InsuranceClaim::default(),
            last_funding_rate: 0,
            last_funding_rate_long: 0,
            last_funding_rate_short: 0,
            last_funding_rate_ts: 0,
            net_unsettled_funding_pnl: 0,
            last_funding_oracle_twap: 0,
            order_step_size: 0,
            order_tick_size: 0,
            unrealized_pnl_max_imbalance: 0,
            expiry_ts: 0,
            expiry_price: 0,
            next_fill_record_id: 0,
            next_funding_rate_record_id: 0,
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
            _padding_align_lfp: [0; 6],
            pool_id: 0,
            _padding_pmm: [0; 2],
            lp_fee_transfer_scalar: 0,
            lp_status: 0,
            lp_exchange_fee_excluscion_scalar: 0,
            lp_paused_operations: 0,
            last_fill_price: 0,
            lp_pool_id: 0,
            market_config: 0,
            oracle_source: OracleSource::default(),
            oracle_slot_delay_override: -1,
            oracle_low_risk_slot_delay_override: 0,
            padding: [0; 36],
            market_stats: MarketStats::default(),
            _padding_align_amm: [0; 8],
            amm: AMM::default(),
        }
    }
}

impl Size for PerpMarket {
    // 1104-byte struct + 8-byte discriminator. AMM-decoupling Step A2
    // deleted 8 cached/derived AMM fields (4×u128 spread reserves, 1×i64
    // last_oracle_reserve_price_spread_pct, 2×u32 long/short_spread, 1×i32
    // reference_price_offset) — 80 bytes of cache that's now computed on
    // demand via `math::amm_spread::compute_amm_quote_state`.
    const SIZE: usize = 1128;
}

impl MarketIndexOffset for PerpMarket {
    // Account-byte offset (includes the 8-byte Anchor discriminator). Used
    // by callers that read `market_index` straight out of the account-bytes
    // slice without deserialising the full struct.
    const MARKET_INDEX_OFFSET: usize = 8 + std::mem::offset_of!(PerpMarket, market_index);
}

impl PerpMarket {
    pub fn oracle_id(&self) -> OracleIdentifier {
        (self.oracle, self.oracle_source)
    }

    pub fn has_market_config_flag(&self, flag: MarketConfigFlag) -> bool {
        self.market_config & flag as u8 != 0
    }

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

    pub fn can_skip_auction_duration(
        &self,
        state: &State,
        amm_has_low_enough_inventory: bool,
    ) -> DriftResult<bool> {
        if state.amm_immediate_fill_paused()? {
            return Ok(false);
        }

        let amm_low_inventory_and_profitable = self.amm.net_revenue_since_last_funding
            >= DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT
            && amm_has_low_enough_inventory;

        if amm_low_inventory_and_profitable {
            msg!("market {} amm skipping auction duration", self.market_index);
        }

        Ok(amm_low_inventory_and_profitable)
    }

    pub fn has_too_much_drawdown(&self) -> DriftResult<bool> {
        self.amm.has_too_much_drawdown(self.contract_tier)
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

    /// PerpMarket-level oracle bookkeeping: refresh the oracle TWAPs,
    /// cache the latest reference-price-offset (used by the next quote's
    /// smoothing branch), and stamp `last_oracle_valid`. Called from the
    /// `update_amms` keeper crank and the funding-rate / bid-ask-twap
    /// keeper ixs. This is a PerpMarket-side concern — it does NOT
    /// mutate AMM fields. It does read the AMM (for `reserve_price` and
    /// the spread snapshot used to derive the offset).
    pub fn update_oracle_derived_stats(
        &mut self,
        mm_oracle_price_data: &crate::state::oracle::MMOraclePriceData,
        oracle_validity: Option<crate::math::oracle::OracleValidity>,
        now: i64,
        clock_slot: u64,
    ) -> DriftResult<()> {
        let Some(oracle_validity) = oracle_validity else {
            return Ok(());
        };

        let reserve_price_after = self.amm.reserve_price()?;

        if crate::math::oracle::is_oracle_valid_for_action(
            oracle_validity,
            Some(crate::math::oracle::DriftAction::UpdateTwap),
        )? {
            let sanitize_clamp_denominator = self.get_sanitize_clamp_denominator()?;
            let funding_period = self.market_stats.funding_period;
            let PerpMarket {
                amm, market_stats, ..
            } = self;
            market_stats.update_oracle_twap(
                amm,
                now,
                mm_oracle_price_data,
                Some(reserve_price_after),
                sanitize_clamp_denominator,
                funding_period,
            )?;
        }

        // Cache the fresh reference_price_offset so the next quote can
        // smooth-transition off the previous value.
        let amm_quote_state = crate::amm::math::spread::compute_amm_quote_state(
            &self.amm,
            &self.market_stats,
            mm_oracle_price_data,
            reserve_price_after,
            clock_slot,
        )?;
        self.market_stats.last_reference_price_offset = amm_quote_state.reference_price_offset;

        self.market_stats.last_oracle_valid = crate::math::oracle::is_oracle_valid_for_action(
            oracle_validity,
            Some(crate::math::oracle::DriftAction::FillOrderAmmLowRisk),
        )?;

        Ok(())
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
        // clamp to 3% price divergence for safer markets and higher for lower contract tiers
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
            return Ok(0);
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
            true,
        )?;

        let margin_ratio = default_margin_ratio.max(size_adj_margin_ratio);

        Ok(margin_ratio)
    }

    pub fn get_base_liquidator_fee(&self) -> u32 {
        self.liquidator_fee
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
                self.market_stats.historical_oracle_data.last_oracle_price,
                self.quote_asset_amount,
                self.net_unsettled_funding_pnl,
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
        self.base_asset_amount_long
            .abs()
            .max(self.base_asset_amount_short.abs())
            .unsigned_abs()
    }

    pub fn get_market_depth_for_funding_rate(&self) -> DriftResult<u64> {
        // base amount used on user orders for funding calculation

        let open_interest = self.get_open_interest();

        let depth = (open_interest.safe_div(1000)?.cast::<u64>()?).clamp(
            self.market_stats.min_order_size.safe_mul(100)?,
            self.market_stats.min_order_size.safe_mul(5000)?,
        );

        Ok(depth)
    }

    pub fn is_price_divergence_ok_for_settle_pnl(&self, oracle_price: i64) -> DriftResult<bool> {
        let oracle_divergence = oracle_price
            .safe_sub(
                self.market_stats
                    .historical_oracle_data
                    .last_oracle_price_twap_5min,
            )?
            .safe_mul(PERCENTAGE_PRECISION_I64)?
            .safe_div(
                self.market_stats
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

        let min_price = oracle_price.min(
            self.market_stats
                .historical_oracle_data
                .last_oracle_price_twap_5min,
        );

        let std_limit = match self.contract_tier {
            ContractTier::A => min_price / 50,                 // 200 bps
            ContractTier::B => min_price / 50,                 // 200 bps
            ContractTier::C => min_price / 20,                 // 500 bps
            ContractTier::Speculative => min_price / 10,       // 1000 bps
            ContractTier::HighlySpeculative => min_price / 10, // 1000 bps
            ContractTier::Isolated => min_price / 10,          // 1000 bps
        }
        .unsigned_abs();

        if self.market_stats.oracle_std.max(self.market_stats.mark_std) >= std_limit {
            msg!(
                "market_index={} std too large to safely settle pnl: {} >= {}",
                self.market_index,
                self.market_stats.oracle_std.max(self.market_stats.mark_std),
                std_limit
            );
            return Ok(false);
        }

        Ok(true)
    }

    pub fn can_sanitize_market_order_auctions(&self) -> bool {
        self.oracle_source != OracleSource::Prelaunch
    }

    pub fn get_trigger_price(
        &self,
        oracle_price: i64,
        now: i64,
        use_median_price: bool,
    ) -> DriftResult<u64> {
        if !use_median_price {
            return oracle_price.cast::<u64>();
        }

        let last_fill_price = self.last_fill_price;

        let mark_price_5min_twap = self.market_stats.last_mark_price_twap_5min;
        let last_oracle_price_twap_5min = self
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap_5min;

        let basis_5min = mark_price_5min_twap
            .cast::<i64>()?
            .safe_sub(last_oracle_price_twap_5min)?;

        let oracle_plus_basis_5min = oracle_price.safe_add(basis_5min)?.cast::<u64>()?;

        let last_funding_basis = self.get_last_funding_basis(oracle_price, now)?;

        let oracle_plus_funding_basis = oracle_price.safe_add(last_funding_basis)?.cast::<u64>()?;

        let median_price = if last_fill_price > 0 {
            msg!(
                "last_fill_price: {} oracle_plus_funding_basis: {} oracle_plus_basis_5min: {}",
                last_fill_price,
                oracle_plus_funding_basis,
                oracle_plus_basis_5min
            );
            let mut prices = [
                last_fill_price,
                oracle_plus_funding_basis,
                oracle_plus_basis_5min,
            ];
            prices.sort_unstable();

            prices[1]
        } else {
            let mut prices = [
                oracle_price.unsigned_abs(),
                oracle_plus_funding_basis,
                oracle_plus_basis_5min,
            ];
            prices.sort_unstable();

            prices[1]
        };

        self.clamp_trigger_price(oracle_price.unsigned_abs(), median_price)
    }

    #[inline(always)]
    fn get_last_funding_basis(&self, oracle_price: i64, now: i64) -> DriftResult<i64> {
        if self.last_funding_oracle_twap > 0 {
            let last_funding_rate = self
                .last_funding_rate
                .cast::<i128>()?
                .safe_mul(PRICE_PRECISION_I128)?
                .safe_div(self.last_funding_oracle_twap.cast::<i128>()?)?
                .safe_mul(24)?;
            let last_funding_rate_pre_adj =
                last_funding_rate.safe_sub(FUNDING_RATE_OFFSET_PERCENTAGE as i128)?;

            let funding_period = self.market_stats.funding_period;
            let time_left_until_funding_update =
                now.safe_sub(self.last_funding_rate_ts)?.min(funding_period);

            let last_funding_basis = oracle_price
                .cast::<i128>()?
                .safe_mul(last_funding_rate_pre_adj)?
                .safe_div(PERCENTAGE_PRECISION_I128)?
                .safe_mul(
                    funding_period
                        .safe_sub(time_left_until_funding_update)?
                        .cast::<i128>()?,
                )?
                .safe_div(funding_period.cast::<i128>()?)?
                / FUNDING_RATE_BUFFER_I128;

            last_funding_basis.cast::<i64>()
        } else {
            Ok(0)
        }
    }

    #[inline(always)]
    fn clamp_trigger_price(&self, oracle_price: u64, median_price: u64) -> DriftResult<u64> {
        let max_bps_diff = if matches!(self.contract_tier, ContractTier::A | ContractTier::B) {
            500 // 20 BPS
        } else if matches!(self.contract_tier, ContractTier::C) {
            100 // 100 BPS
        } else {
            40 // 250 BPS
        };
        let max_oracle_diff = oracle_price / max_bps_diff;

        Ok(median_price.clamp(
            oracle_price.safe_sub(max_oracle_diff)?,
            oracle_price.safe_add(max_oracle_diff)?,
        ))
    }

    /// Whether the oracle was valid at the last AMM update AND the AMM was
    /// updated in the current slot.
    pub fn is_recent_oracle_valid(&self, current_slot: u64) -> DriftResult<bool> {
        Ok(self.market_stats.last_oracle_valid && self.amm.is_fresh_at(current_slot))
    }

    #[inline(always)]
    pub fn get_mm_oracle_price_data(
        &self,
        oracle_price_data: OraclePriceData,
        clock_slot: u64,
        oracle_guard_rails: &ValidityGuardRails,
    ) -> DriftResult<MMOraclePriceData> {
        let delay = clock_slot
            .cast::<i64>()?
            .safe_sub(self.market_stats.mm_oracle_slot.cast::<i64>()?)?;
        let oracle_data = OraclePriceData {
            price: self.market_stats.mm_oracle_price,
            delay,
            sequence_id: None,
            confidence: oracle_price_data.confidence,
            has_sufficient_number_of_data_points: true,
        };
        let oracle_validity = if self.market_stats.mm_oracle_price == 0 {
            OracleValidity::NonPositive
        } else {
            oracle_validity(
                MarketType::Perp,
                self.market_index,
                self.market_stats
                    .historical_oracle_data
                    .last_oracle_price_twap,
                &oracle_data,
                oracle_guard_rails,
                self.get_max_confidence_interval_multiplier()?,
                &self.oracle_source,
                LogMode::MMOracle,
                self.oracle_slot_delay_override,
                self.oracle_low_risk_slot_delay_override,
            )?
        };
        MMOraclePriceData::new(
            self.market_stats.mm_oracle_price,
            delay,
            self.market_stats.mm_oracle_sequence_id,
            oracle_validity,
            oracle_price_data,
        )
    }

    pub fn amm_can_fill_order(
        &self,
        order: &Order,
        clock_slot: u64,
        fill_mode: FillMode,
        state: &State,
        safe_oracle_validity: OracleValidity,
        user_can_skip_auction_duration: bool,
        mm_oracle_price_data: &MMOraclePriceData,
    ) -> DriftResult<bool> {
        if self.is_operation_paused(PerpOperation::AmmFill) {
            msg!("AMM cannot fill order: AMM fill operation is paused");
            return Ok(false);
        }

        if self.has_too_much_drawdown()? {
            msg!("AMM cannot fill order: has too much drawdown");
            return Ok(false);
        }

        // We are already using safe oracle data from MM oracle.
        // But AMM isnt available if we could have used MM oracle but fell back due to price diff
        // This is basically early volatility protection
        let mm_oracle_not_too_volatile =
            if mm_oracle_price_data.is_enabled() && mm_oracle_price_data.is_mm_oracle_as_recent() {
                !mm_oracle_price_data.is_mm_exchange_diff_bps_high()
            } else {
                true
            };

        if !mm_oracle_not_too_volatile {
            msg!("AMM cannot fill order: MM oracle too volatile compared to exchange oracle");
            return Ok(false);
        }

        // Determine if order is fillable with low risk
        let oracle_valid_for_amm_fill_low_risk = is_oracle_valid_for_action(
            safe_oracle_validity,
            Some(DriftAction::FillOrderAmmLowRisk),
        )?;
        if !oracle_valid_for_amm_fill_low_risk {
            msg!("AMM cannot fill order: oracle not valid for low risk fills");
            return Ok(false);
        }
        let safe_oracle_price_data = mm_oracle_price_data.get_safe_oracle_price_data();
        let can_fill_low_risk = order.is_low_risk_for_amm(
            safe_oracle_price_data.delay,
            clock_slot,
            fill_mode.is_liquidation(),
            user_can_skip_auction_duration,
        )?;

        // Proceed if order is low risk and we can fill it. Otherwise check if we can higher risk order immediately
        let can_fill_order = if can_fill_low_risk {
            true
        } else {
            if !user_can_skip_auction_duration {
                msg!("AMM cannot fill order: user has paused operations");
                return Ok(false);
            }

            let oracle_valid_for_can_fill_immediately = is_oracle_valid_for_action(
                safe_oracle_validity,
                Some(DriftAction::FillOrderAmmImmediate),
            )?;
            if !oracle_valid_for_can_fill_immediately {
                msg!("AMM cannot fill order: oracle not valid for immediate fills");
                return Ok(false);
            }
            let amm_wants_to_jit_make = self
                .amm
                .amm_wants_to_jit_make(order.direction, self.order_step_size)?;
            if !amm_wants_to_jit_make {
                msg!("AMM cannot fill order: AMM does not want to JIT make");
                return Ok(false);
            }

            let amm_has_low_enough_inventory = self
                .amm
                .amm_has_low_enough_inventory(amm_wants_to_jit_make)?;

            if !amm_has_low_enough_inventory {
                msg!("AMM cannot fill order: AMM has too much inventory");
                return Ok(false);
            }

            let amm_can_skip_duration =
                self.can_skip_auction_duration(state, amm_has_low_enough_inventory)?;

            if !amm_can_skip_duration {
                msg!("AMM cannot fill order: AMM cannot skip duration");
                return Ok(false);
            }

            true
        };

        Ok(can_fill_order)
    }
}

#[cfg(test)]
impl PerpMarket {
    pub fn default_test() -> Self {
        use crate::math::constants::PRICE_PRECISION_I64;
        let amm = AMM::default_test();
        PerpMarket {
            market_stats: MarketStats {
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: PRICE_PRECISION_I64,
                    ..HistoricalOracleData::default()
                },
                last_oracle_valid: true,
                ..MarketStats::default()
            },
            amm,
            order_step_size: 1,
            order_tick_size: 1,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            ..PerpMarket::default()
        }
    }

    pub fn default_btc_test() -> Self {
        use crate::math::constants::{PRICE_PRECISION, PRICE_PRECISION_I64};
        let amm = AMM::default_btc_test();
        PerpMarket {
            market_stats: MarketStats {
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: 19_400 * PRICE_PRECISION_I64,
                    last_oracle_price_twap: 19_400 * PRICE_PRECISION_I64,
                    last_oracle_price_twap_5min: 19_400 * PRICE_PRECISION_I64,
                    last_oracle_price_twap_ts: 1_662_800_000_i64,
                    ..HistoricalOracleData::default()
                },
                last_mark_price_twap_ts: 1_662_800_000,
                mark_std: PRICE_PRECISION as u64,
                last_oracle_valid: true,
                funding_period: 3600,
                ..MarketStats::default()
            },
            amm,
            quote_asset_amount: 19_000_000_000, // short 1 BTC @ $19000
            margin_ratio_initial: 1000,         // 10x
            margin_ratio_maintenance: 500,      // 5x
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
    pub padding: [u8; 14],
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
        Err(ErrorCode::CantUpdateSpotBalanceType)
    }
}

/// Historic market data shared across all makers, updated on every fill
/// regardless of which maker filled (vAMM, DLOB resting order, JIT participant,
/// future quoter types). Holds mark/oracle TWAPs, rolling std, volume,
/// intensity, mm-oracle snapshot, `historical_oracle_data`,
/// `last_oracle_normalised_price`, `last_oracle_valid`.
///
/// Update-cadence rule: anything that needs to refresh on every market event
/// lives here. Anything AMM-private (reserves, peg, spreads — only matters
/// when the AMM specifically is the counterparty) lives on `AMM`. See
/// `docs/amm-decoupling-and-maker-interface.md`.
#[zero_copy(unsafe)]
#[derive(Debug, PartialEq, Eq)]
#[repr(C)]
pub struct MarketStats {
    /// Average estimate of (bid+ask)/2 price over funding_period.
    /// precision: PRICE_PRECISION
    pub last_mark_price_twap: u64,
    /// Average estimate of (bid+ask)/2 price over FIVE_MINUTES.
    pub last_mark_price_twap_5min: u64,
    /// The last unix_timestamp the mark twap was updated.
    pub last_mark_price_twap_ts: i64,
    /// Average estimate of bid price over funding_period.
    /// precision: PRICE_PRECISION
    pub last_bid_price_twap: u64,
    /// Average estimate of ask price over funding_period.
    /// precision: PRICE_PRECISION
    pub last_ask_price_twap: u64,
    /// Estimate of standard deviation of fill (mark) prices.
    /// precision: PRICE_PRECISION
    pub mark_std: u64,
    /// Estimate of standard deviation of the oracle price at each update.
    /// precision: PRICE_PRECISION
    pub oracle_std: u64,
    /// The pct size of the oracle confidence interval.
    /// precision: PERCENTAGE_PRECISION
    pub last_oracle_conf_pct: u64,
    /// Estimated total of volume in market.
    /// QUOTE_PRECISION
    pub volume_24h: u64,
    /// The volume intensity of long fills (across all makers).
    pub long_intensity_volume: u64,
    /// The volume intensity of short fills (across all makers).
    pub short_intensity_volume: u64,
    /// The blockchain unix_timestamp at the time of the last trade.
    pub last_trade_ts: i64,
    /// estimate of last 24h of funding rate perp market (unit is quote per base)
    /// Market-wide config / rolling stat — read by the AMM when computing
    /// `reference_price_offset` and by funding-rate updates. Migrated from
    /// `PerpMarket` so the AMM reads only from `MarketStats`.
    /// precision: QUOTE_PRECISION
    pub last_24h_avg_funding_rate: i64,
    /// the periodicity of the funding rate updates. Market-wide config used
    /// across the funding path. Migrated from `PerpMarket`.
    pub funding_period: i64,
    /// the minimum base size of an order. Market-wide config read by the AMM
    /// when computing fallback prices / spread reserves. Migrated from
    /// `PerpMarket`.
    /// precision: BASE_PRECISION
    pub min_order_size: u64,
    /// MM oracle price snapshot (set by the native handler).
    pub mm_oracle_price: i64,
    /// Slot at which the mm_oracle_* fields were last updated.
    pub mm_oracle_slot: u64,
    /// Monotonically increasing sequence id for mm_oracle updates.
    pub mm_oracle_sequence_id: u64,
    /// Canonical sanitised/clamped oracle price — the latest oracle reading
    /// after normalisation (any quoter's view, not AMM-specific).
    pub last_oracle_normalised_price: i64,
    /// Previous reference price offset, written by `_update_amm` after a
    /// successful repeg/k_update. Read by `compute_amm_quote_state` to
    /// implement the legacy time-decayed reference-price-offset smoothing
    /// transition — when the freshly computed offset's sign flips relative
    /// to this cached value AND `curve_update_intensity > 100`, the
    /// transition is clamped per-slot rather than snapping. Migrated from
    /// `AMM.reference_price_offset` (which was deleted in the AMM-decoupling
    /// refactor) so the smoothing behaviour is preserved across cranks.
    /// precision: PRICE_PRECISION
    pub last_reference_price_offset: i32,
    /// Whether the oracle was valid at the most recent `_update_amm`.
    /// Read by settlement and fill paths to gate operations.
    pub last_oracle_valid: bool,
    /// Padding so historical_oracle_data is 8-aligned.
    pub padding: [u8; 11],
    /// Historical oracle readings — TWAPs, last raw price, confidence, delay,
    /// timestamp. Market-wide data (any quoter would want it), updated by
    /// `_update_amm` / funding paths. Migrated from AMM.
    pub historical_oracle_data: HistoricalOracleData,
}

impl Default for MarketStats {
    fn default() -> Self {
        // `min_order_size: 1` preserves the old `PerpMarket::default` behaviour
        // (the field used to live on `PerpMarket`). All other fields are zero.
        Self {
            last_mark_price_twap: 0,
            last_mark_price_twap_5min: 0,
            last_mark_price_twap_ts: 0,
            last_bid_price_twap: 0,
            last_ask_price_twap: 0,
            mark_std: 0,
            oracle_std: 0,
            last_oracle_conf_pct: 0,
            volume_24h: 0,
            long_intensity_volume: 0,
            short_intensity_volume: 0,
            last_trade_ts: 0,
            last_24h_avg_funding_rate: 0,
            funding_period: 0,
            min_order_size: 1,
            mm_oracle_price: 0,
            mm_oracle_slot: 0,
            mm_oracle_sequence_id: 0,
            last_oracle_normalised_price: 0,
            last_reference_price_offset: 0,
            last_oracle_valid: false,
            padding: [0; 11],
            historical_oracle_data: HistoricalOracleData::default(),
        }
    }
}

impl crate::state::traits::Size for MarketStats {
    const SIZE: usize = 216;
}

impl MarketStats {
    /// Update the mark-price rolling-std estimate.
    pub fn update_mark_std(
        &mut self,
        now: i64,
        price: u64,
        ewma: u64,
        ewma_5min: u64,
    ) -> crate::error::DriftResult<()> {
        self.mark_std = crate::amm::math::amm::update_amm_mark_std(
            self.mark_std,
            self.last_mark_price_twap_ts,
            now,
            price,
            ewma,
            ewma_5min,
        )?;
        Ok(())
    }

    /// Update the oracle-price rolling-std estimate.
    pub fn update_oracle_std(
        &mut self,
        now: i64,
        price: u64,
        ewma: u64,
        ewma_5min: u64,
    ) -> crate::error::DriftResult<()> {
        self.oracle_std = crate::amm::math::amm::update_amm_oracle_std(
            self.oracle_std,
            self.historical_oracle_data.last_oracle_price_twap_ts,
            now,
            price,
            ewma,
            ewma_5min,
        )?;
        Ok(())
    }

    /// Update the oracle-confidence percentage estimate using the previous
    /// value decayed as a lower bound.
    pub fn update_oracle_conf_pct(
        &mut self,
        confidence: u64,
        reserve_price: u64,
        now: i64,
    ) -> crate::error::DriftResult<()> {
        use crate::math::constants::BID_ASK_SPREAD_PRECISION;
        use crate::math::safe_math::SafeMath;
        let upper_bound_divisor = 21_u64;
        let lower_bound_divisor = 5_u64;
        let since_last = now
            .safe_sub(self.historical_oracle_data.last_oracle_price_twap_ts)?
            .max(0);

        let confidence_lower_bound = if since_last > 0 {
            let confidence_divisor = upper_bound_divisor
                .saturating_sub(since_last as u64)
                .max(lower_bound_divisor);
            self.last_oracle_conf_pct
                .safe_sub(self.last_oracle_conf_pct / confidence_divisor)?
        } else {
            self.last_oracle_conf_pct
        };

        self.last_oracle_conf_pct = confidence
            .safe_mul(BID_ASK_SPREAD_PRECISION)?
            .safe_div(reserve_price)?
            .max(confidence_lower_bound);
        Ok(())
    }

    /// Update volume / long-short intensity rolling sums and the last-trade
    /// timestamp on this `MarketStats`. Called from every fill path so the
    /// stats reflect total market activity across all makers.
    pub fn update_volume_24h(
        &mut self,
        quote_asset_amount: u64,
        position_direction: crate::controller::position::PositionDirection,
        now: i64,
    ) -> crate::error::DriftResult<()> {
        use crate::math::constants::{ONE_HOUR, TWENTY_FOUR_HOUR};
        use crate::math::safe_math::SafeMath;
        use crate::math::stats;

        let since_last = core::cmp::max(1_i64, now.safe_sub(self.last_trade_ts)?);

        let (long_quote_amount, short_quote_amount) =
            if position_direction == crate::controller::position::PositionDirection::Long {
                (quote_asset_amount, 0_u64)
            } else {
                (0_u64, quote_asset_amount)
            };

        self.long_intensity_volume = stats::calculate_rolling_sum(
            self.long_intensity_volume,
            long_quote_amount,
            since_last,
            ONE_HOUR,
        )?;

        self.short_intensity_volume = stats::calculate_rolling_sum(
            self.short_intensity_volume,
            short_quote_amount,
            since_last,
            ONE_HOUR,
        )?;

        self.volume_24h = stats::calculate_rolling_sum(
            self.volume_24h,
            quote_asset_amount,
            since_last,
            TWENTY_FOUR_HOUR,
        )?;

        self.last_trade_ts = now;

        Ok(())
    }

    /// Update the bid/ask/mid mark-price TWAPs (funding-period and 5-minute)
    /// from a freshly-observed bid/ask pair. Pure MarketStats mutation —
    /// callers compute `bid_price` / `ask_price` from whichever liquidity
    /// source produced the fill (vAMM quote, DLOB, JIT participant).
    pub fn update_mark_twap(
        &mut self,
        now: i64,
        bid_price: u64,
        ask_price: u64,
        precomputed_trade_price: Option<u64>,
        sanitize_clamp: Option<i64>,
        funding_period: i64,
    ) -> crate::error::DriftResult<u64> {
        use crate::amm::math::amm::sanitize_new_price;
        use crate::math::casting::Cast;
        use crate::math::constants::{FIVE_MINUTE, ONE_MINUTE};
        use crate::math::safe_math::SafeMath;
        use crate::math::stats::{calculate_new_twap, calculate_weighted_average};
        use crate::validate;
        use core::cmp::max;

        let (bid_price_capped_update, ask_price_capped_update) = (
            sanitize_new_price(
                bid_price.cast()?,
                self.last_bid_price_twap.cast()?,
                sanitize_clamp,
            )?,
            sanitize_new_price(
                ask_price.cast()?,
                self.last_ask_price_twap.cast()?,
                sanitize_clamp,
            )?,
        );

        validate!(
            bid_price_capped_update <= ask_price_capped_update,
            crate::error::ErrorCode::InvalidMarkTwapUpdateDetected,
            "bid_price_capped_update not <= ask_price_capped_update,"
        )?;

        let last_valid_trade_since_oracle_twap_update = self
            .historical_oracle_data
            .last_oracle_price_twap_ts
            .safe_sub(self.last_mark_price_twap_ts)?;

        // if delayed more than ONE_MINUTE or 60th of funding period, shrink toward oracle_twap
        let (last_bid_price_twap, last_ask_price_twap) =
            if last_valid_trade_since_oracle_twap_update
                > funding_period.safe_div(60)?.max(ONE_MINUTE.cast()?)
            {
                crate::msg!(
                    "correcting mark twap update (oracle previously invalid for {:?} seconds)",
                    last_valid_trade_since_oracle_twap_update
                );

                let from_start_valid = max(
                    0,
                    funding_period.safe_sub(last_valid_trade_since_oracle_twap_update)?,
                );
                (
                    calculate_weighted_average(
                        self.historical_oracle_data
                            .last_oracle_price_twap
                            .cast::<i64>()?,
                        self.last_bid_price_twap.cast()?,
                        last_valid_trade_since_oracle_twap_update,
                        from_start_valid,
                        Some(
                            self.historical_oracle_data
                                .last_oracle_price_twap
                                .safe_sub(self.last_bid_price_twap.cast()?)?
                                .signum(),
                        ),
                    )?,
                    calculate_weighted_average(
                        self.historical_oracle_data
                            .last_oracle_price_twap
                            .cast::<i64>()?,
                        self.last_ask_price_twap.cast()?,
                        last_valid_trade_since_oracle_twap_update,
                        from_start_valid,
                        Some(
                            self.historical_oracle_data
                                .last_oracle_price_twap
                                .safe_sub(self.last_ask_price_twap.cast()?)?
                                .signum(),
                        ),
                    )?,
                )
            } else {
                (
                    self.last_bid_price_twap.cast()?,
                    self.last_ask_price_twap.cast()?,
                )
            };

        let bid_twap = calculate_new_twap(
            bid_price_capped_update,
            now,
            last_bid_price_twap,
            self.last_mark_price_twap_ts,
            funding_period,
        )?;
        self.last_bid_price_twap = bid_twap.cast()?;

        let ask_twap = calculate_new_twap(
            ask_price_capped_update,
            now,
            last_ask_price_twap,
            self.last_mark_price_twap_ts,
            funding_period,
        )?;
        self.last_ask_price_twap = ask_twap.cast()?;

        let mid_twap = bid_twap.safe_add(ask_twap)? / 2;

        let trade_price: u64 = match precomputed_trade_price {
            Some(trade_price) => trade_price,
            None => bid_price.safe_add(ask_price)?.safe_div(2)?,
        };
        self.update_mark_std(
            now,
            trade_price,
            self.last_mark_price_twap,
            self.last_mark_price_twap_5min,
        )?;

        self.last_mark_price_twap = mid_twap.cast()?;
        self.last_mark_price_twap_5min = calculate_new_twap(
            bid_price_capped_update
                .safe_add(ask_price_capped_update)?
                .safe_div(2)?
                .cast()?,
            now,
            self.last_mark_price_twap_5min.cast()?,
            self.last_mark_price_twap_ts,
            FIVE_MINUTE as i64,
        )?
        .cast()?;

        self.last_mark_price_twap_ts = now;

        mid_twap.cast()
    }

    /// Update the mark-price TWAP by first estimating today's best bid/ask
    /// from the AMM's quote state (and an optional trade-price hint).
    /// `amm` is read-only; only `self` is mutated.
    /// Test-only convenience that derives the bid/ask inputs from a `&AMM`
    /// borrow and forwards to [`update_mark_twap_with_amm_bid_ask`]. Real
    /// callers (orchestrator, funding) read the bid/ask themselves and call
    /// the data-only entrypoint — in the future-AMM model those reads are
    /// CPIs and the AMM is no longer reachable as a Rust struct.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn update_mark_twap_from_estimates(
        &mut self,
        amm: &AMM,
        amm_quote_state: &crate::amm::math::spread::AmmQuoteState,
        now: i64,
        precomputed_trade_price: Option<u64>,
        direction: Option<crate::controller::position::PositionDirection>,
        sanitize_clamp: Option<i64>,
        funding_period: i64,
        order_tick_size: u64,
    ) -> crate::error::DriftResult<u64> {
        let reserve_price = amm.reserve_price()?;
        let (amm_bid_price, amm_ask_price) = amm.bid_ask_price(
            reserve_price,
            amm_quote_state.long_spread,
            amm_quote_state.short_spread,
            amm_quote_state.reference_price_offset,
        )?;
        self.update_mark_twap_with_amm_bid_ask(
            amm_bid_price,
            amm_ask_price,
            amm.base_spread,
            amm_quote_state,
            now,
            precomputed_trade_price,
            direction,
            sanitize_clamp,
            funding_period,
            order_tick_size,
        )
    }

    /// Update the mark TWAP using AMM-derived bid/ask + base spread plus an
    /// optional trade-price hint. Pure-data entrypoint: no `&AMM` borrow
    /// (the AMM-derived scalars come from the caller — today via direct
    /// reads, in the future-AMM model via CPI to the AMM program).
    #[allow(clippy::too_many_arguments)]
    pub fn update_mark_twap_with_amm_bid_ask(
        &mut self,
        amm_bid_price: u64,
        amm_ask_price: u64,
        amm_base_spread: u32,
        amm_quote_state: &crate::amm::math::spread::AmmQuoteState,
        now: i64,
        precomputed_trade_price: Option<u64>,
        direction: Option<crate::controller::position::PositionDirection>,
        sanitize_clamp: Option<i64>,
        funding_period: i64,
        order_tick_size: u64,
    ) -> crate::error::DriftResult<u64> {
        let (bid_price, ask_price) = crate::amm::math::amm::estimate_best_bid_ask_price(
            amm_bid_price,
            amm_ask_price,
            amm_base_spread,
            amm_quote_state,
            &self.historical_oracle_data,
            precomputed_trade_price,
            direction,
            order_tick_size,
        )?;
        self.update_mark_twap(
            now,
            bid_price,
            ask_price,
            precomputed_trade_price,
            sanitize_clamp,
            funding_period,
        )
    }

    /// Update the mark-price TWAP using the *best* of (vAMM bid/ask, DLOB
    /// bid/ask). Used by the explicit mark-twap crank to fold DLOB liquidity
    /// into the on-chain TWAP estimate.
    pub fn update_mark_twap_crank(
        &mut self,
        amm: &AMM,
        now: i64,
        oracle_price_data: &crate::state::oracle::OraclePriceData,
        amm_quote_state: &crate::amm::math::spread::AmmQuoteState,
        best_dlob_bid_price: Option<u64>,
        best_dlob_ask_price: Option<u64>,
        sanitize_clamp: Option<i64>,
        funding_period: i64,
    ) -> crate::error::DriftResult<()> {
        use crate::math::casting::Cast;
        use crate::math::safe_math::SafeMath;

        let amm_reserve_price = amm.reserve_price()?;
        let (amm_bid_price, amm_ask_price) = amm.bid_ask_price(
            amm_reserve_price,
            amm_quote_state.long_spread,
            amm_quote_state.short_spread,
            amm_quote_state.reference_price_offset,
        )?;

        let mut best_bid_price = match best_dlob_bid_price {
            Some(best_dlob_bid_price) => best_dlob_bid_price.max(amm_bid_price),
            None => amm_bid_price,
        };
        let mut best_ask_price = match best_dlob_ask_price {
            Some(best_dlob_ask_price) => best_dlob_ask_price.min(amm_ask_price),
            None => amm_ask_price,
        };

        if best_bid_price > best_ask_price {
            let market_basis = self
                .last_mark_price_twap_5min
                .cast::<i64>()?
                .safe_sub(self.historical_oracle_data.last_oracle_price_twap_5min)?
                .clamp(
                    -oracle_price_data.price / 100,
                    oracle_price_data.price / 100,
                );
            if best_bid_price >= oracle_price_data.price.safe_add(market_basis)?.cast()? {
                best_bid_price = best_ask_price;
            } else {
                best_ask_price = best_bid_price;
            }
        }

        self.update_mark_twap(
            now,
            best_bid_price,
            best_ask_price,
            None,
            sanitize_clamp,
            funding_period,
        )?;
        Ok(())
    }

    /// Update the oracle-price TWAP and rolling oracle-confidence stats.
    /// `amm` is read-only — only used to fall back to `amm.reserve_price()`
    /// when `precomputed_reserve_price` is `None`. Only `self` is mutated.
    pub fn update_oracle_twap(
        &mut self,
        amm: &AMM,
        now: i64,
        mm_oracle_price_data: &crate::state::oracle::MMOraclePriceData,
        precomputed_reserve_price: Option<u64>,
        sanitize_clamp: Option<i64>,
        funding_period: i64,
    ) -> crate::error::DriftResult<i64> {
        use crate::amm::math::amm::{
            calculate_new_oracle_price_twap, normalise_oracle_price, sanitize_new_price, TwapPeriod,
        };
        use crate::math::casting::Cast;

        let reserve_price = match precomputed_reserve_price {
            Some(reserve_price) => reserve_price,
            None => amm.reserve_price()?,
        };

        let oracle_confidence = mm_oracle_price_data.get_confidence();
        let oracle_price = normalise_oracle_price(
            &mm_oracle_price_data.get_exchange_oracle_price_data(),
            reserve_price,
        )?;

        let capped_oracle_update_price = sanitize_new_price(
            oracle_price,
            self.historical_oracle_data.last_oracle_price_twap,
            sanitize_clamp,
        )?;

        let oracle_price_twap: i64;
        if capped_oracle_update_price > 0 && oracle_price > 0 {
            oracle_price_twap = calculate_new_oracle_price_twap(
                self,
                now,
                capped_oracle_update_price,
                TwapPeriod::FundingPeriod,
                funding_period,
            )?;

            let oracle_price_twap_5min = calculate_new_oracle_price_twap(
                self,
                now,
                capped_oracle_update_price,
                TwapPeriod::FiveMin,
                funding_period,
            )?;

            self.last_oracle_normalised_price = capped_oracle_update_price;
            self.historical_oracle_data.last_oracle_price =
                mm_oracle_price_data.get_exchange_oracle_price_data().price;

            let prev_oracle_twap = self.historical_oracle_data.last_oracle_price_twap;
            let prev_oracle_twap_5min = self.historical_oracle_data.last_oracle_price_twap_5min;

            self.update_oracle_conf_pct(oracle_confidence, reserve_price, now)?;

            self.historical_oracle_data.last_oracle_delay =
                mm_oracle_price_data.get_exchange_oracle_price_data().delay;

            self.update_oracle_std(
                now,
                oracle_price.cast()?,
                prev_oracle_twap.cast()?,
                prev_oracle_twap_5min.cast()?,
            )?;

            self.historical_oracle_data.last_oracle_price_twap_5min = oracle_price_twap_5min;
            self.historical_oracle_data.last_oracle_price_twap = oracle_price_twap;
            self.historical_oracle_data.last_oracle_price_twap_ts = now;
        } else {
            oracle_price_twap = self.historical_oracle_data.last_oracle_price_twap;
        }

        Ok(oracle_price_twap)
    }
}

pub use crate::amm::state::AMM;
