//! Market and oracle data used to drive offchain margin calculations.
//!
//! All inner maps are `Vec<Option<T>>` indexed by `market_index`, which is a
//! dense small `u16`, so lookups are array indexing and clones are
//! contiguous memcpy (no allocator per-entry traffic).
//! [`MarketState`] holds one `ArcSwap<MarketStateData>` for lock-free reads.
use arc_swap::ArcSwap;

use drift::{
    math::{
        constants::{
            MARGIN_PRECISION_I128, MARGIN_PRECISION_U128, OPEN_ORDER_MARGIN_REQUIREMENT,
            QUOTE_SPOT_MARKET_INDEX,
        },
        margin::calculate_perp_position_value_and_pnl,
        spot_balance::{get_strict_token_value, get_token_amount},
    },
    state::{
        oracle::StrictOraclePrice,
        perp_market::ContractTier,
        spot_market::{AssetTier, SpotBalanceType},
        user::OrderFillSimulation,
    },
};

use crate::{
    types::{
        accounts::{PerpMarket, SpotMarket, User},
        MarginRequirementType, SpotPosition,
    },
    OraclePriceData, SdkError, SdkResult,
};
use std::{cmp::Ordering as CmpOrdering, sync::Arc};

/// Market + oracle state for offchain margin calculations.
///
/// All inner maps are `Vec<Option<T>>` indexed by `market_index`.
#[derive(Clone, Default)]
pub struct MarketStateData {
    pub spot_markets: Vec<Option<SpotMarket>>,
    pub perp_markets: Vec<Option<PerpMarket>>,
    pub spot_oracle_prices: Vec<Option<OraclePriceData>>,
    pub perp_oracle_prices: Vec<Option<OraclePriceData>>,
    /// Override spot oracle with pyth price.
    pub spot_pyth_prices: Vec<Option<i64>>,
    /// Override perp oracle with pyth price.
    pub perp_pyth_prices: Vec<Option<i64>>,
    /// Min bps diff required to prefer pyth over oracle. `0` = always prefer pyth when set.
    pub pyth_oracle_diff_threshold_bps: u64,
}

fn slot_mut<T>(v: &mut Vec<Option<T>>, idx: u16) -> &mut Option<T> {
    let i = idx as usize;
    if i >= v.len() {
        v.resize_with(i + 1, || None);
    }
    &mut v[i]
}

fn slot_ref<T>(v: &[Option<T>], idx: u16) -> Option<&T> {
    v.get(idx as usize).and_then(|s| s.as_ref())
}

impl MarketStateData {
    pub fn set_spot_market(&mut self, market: SpotMarket) {
        *slot_mut(&mut self.spot_markets, market.market_index) = Some(market);
    }

    pub fn set_perp_market(&mut self, market: PerpMarket) {
        *slot_mut(&mut self.perp_markets, market.market_index) = Some(market);
    }

    pub fn set_spot_oracle_price(&mut self, market_index: u16, price: OraclePriceData) {
        *slot_mut(&mut self.spot_oracle_prices, market_index) = Some(price);
    }

    pub fn set_perp_oracle_price(&mut self, market_index: u16, price: OraclePriceData) {
        *slot_mut(&mut self.perp_oracle_prices, market_index) = Some(price);
    }

    pub fn set_spot_pyth_price(&mut self, market_index: u16, price: i64) {
        *slot_mut(&mut self.spot_pyth_prices, market_index) = Some(price);
    }

    pub fn set_perp_pyth_price(&mut self, market_index: u16, price: i64) {
        *slot_mut(&mut self.perp_pyth_prices, market_index) = Some(price);
    }

    pub fn spot_market(&self, market_index: u16) -> Option<&SpotMarket> {
        slot_ref(&self.spot_markets, market_index)
    }

    pub fn perp_market(&self, market_index: u16) -> Option<&PerpMarket> {
        slot_ref(&self.perp_markets, market_index)
    }

    pub fn spot_oracle(&self, market_index: u16) -> Option<&OraclePriceData> {
        slot_ref(&self.spot_oracle_prices, market_index)
    }

    pub fn perp_oracle(&self, market_index: u16) -> Option<&OraclePriceData> {
        slot_ref(&self.perp_oracle_prices, market_index)
    }

    pub fn spot_pyth(&self, market_index: u16) -> Option<i64> {
        slot_ref(&self.spot_pyth_prices, market_index).copied()
    }

    pub fn perp_pyth(&self, market_index: u16) -> Option<i64> {
        slot_ref(&self.perp_pyth_prices, market_index).copied()
    }
}

/// Resolve oracle vs pyth override using the threshold. Returns the price to use.
fn resolve_oracle_price(
    oracle: &OraclePriceData,
    pyth: Option<i64>,
    threshold_bps: u64,
) -> OraclePriceData {
    match pyth {
        Some(pyth_price) if pyth_price != 0 && oracle.price == 0 => OraclePriceData {
            price: pyth_price,
            confidence: 0,
            delay: 0,
            has_sufficient_number_of_data_points: true,
            sequence_id: None,
        },
        Some(pyth_price) if pyth_price != 0 && oracle.price != 0 => {
            let diff_bps =
                (pyth_price.abs_diff(oracle.price) * 10_000) / oracle.price.unsigned_abs();
            if diff_bps > threshold_bps {
                OraclePriceData {
                    price: pyth_price,
                    confidence: 0,
                    delay: 0,
                    has_sufficient_number_of_data_points: true,
                    sequence_id: None,
                }
            } else {
                *oracle
            }
        }
        _ => *oracle,
    }
}

/// Lock-free snapshot of market + oracle data for offchain margin calculations.
///
/// Readers observe a consistent snapshot via `load()`. Writers use an RCU
/// update (clone-modify-publish). Concurrent writers are last-writer-wins
/// internally via `ArcSwap::rcu`, which retries on contention.
pub struct MarketState {
    state: ArcSwap<MarketStateData>,
}

impl MarketState {
    pub fn new(data: MarketStateData) -> Self {
        Self {
            state: ArcSwap::from_pointee(data),
        }
    }

    /// Cheap snapshot of the current state (one atomic load on the fast path).
    pub fn load(&self) -> Arc<MarketStateData> {
        self.state.load_full()
    }

    pub fn set_spot_market(&self, market: SpotMarket) {
        self.state.rcu(|cur| {
            let mut next = (**cur).clone();
            next.set_spot_market(market);
            next
        });
    }

    pub fn set_perp_market(&self, market: PerpMarket) {
        self.state.rcu(|cur| {
            let mut next = (**cur).clone();
            next.set_perp_market(market);
            next
        });
    }

    pub fn set_spot_oracle_price(&self, market_index: u16, price: OraclePriceData) {
        self.state.rcu(|cur| {
            let mut next = (**cur).clone();
            next.set_spot_oracle_price(market_index, price);
            next
        });
    }

    pub fn set_perp_oracle_price(&self, market_index: u16, price: OraclePriceData) {
        self.state.rcu(|cur| {
            let mut next = (**cur).clone();
            next.set_perp_oracle_price(market_index, price);
            next
        });
    }

    pub fn set_spot_pyth_price(&self, market_index: u16, price: i64) {
        self.state.rcu(|cur| {
            let mut next = (**cur).clone();
            next.set_spot_pyth_price(market_index, price);
            next
        });
    }

    pub fn set_perp_pyth_price(&self, market_index: u16, price: i64) {
        self.state.rcu(|cur| {
            let mut next = (**cur).clone();
            next.set_perp_pyth_price(market_index, price);
            next
        });
    }

    pub fn get_perp_oracle_price(&self, market_index: u16) -> Option<OraclePriceData> {
        self.state.load().perp_oracle(market_index).copied()
    }

    pub fn get_spot_oracle_price(&self, market_index: u16) -> Option<OraclePriceData> {
        self.state.load().spot_oracle(market_index).copied()
    }

    pub fn get_spot_pyth_price(&self, market_index: u16) -> Option<OraclePriceData> {
        self.state
            .load()
            .spot_pyth(market_index)
            .map(|price| OraclePriceData {
                price,
                confidence: 0,
                delay: 0,
                has_sufficient_number_of_data_points: true,
                sequence_id: None,
            })
    }

    pub fn get_perp_pyth_price(&self, market_index: u16) -> Option<OraclePriceData> {
        self.state
            .load()
            .perp_pyth(market_index)
            .map(|price| OraclePriceData {
                price,
                confidence: 0,
                delay: 0,
                has_sufficient_number_of_data_points: true,
                sequence_id: None,
            })
    }
}

impl Default for MarketState {
    fn default() -> Self {
        Self::new(MarketStateData::default())
    }
}

/// Per-isolated-market margin result, sized to drift's isolated position limit.
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Default)]
pub struct IsolatedMarginCalculation {
    pub market_index: u16,
    pub margin_requirement: u128,
    pub total_collateral: i128,
    pub total_collateral_buffer: i128,
    pub margin_requirement_plus_buffer: u128,
}

impl IsolatedMarginCalculation {
    pub fn is_empty(&self) -> bool {
        self.margin_requirement == 0 && self.total_collateral == 0
    }

    pub fn get_total_collateral_plus_buffer(&self) -> i128 {
        self.total_collateral
            .saturating_add(self.total_collateral_buffer)
    }

    pub fn meets_margin_requirement(&self) -> bool {
        self.total_collateral >= self.margin_requirement as i128
    }

    pub fn meets_margin_requirement_with_buffer(&self) -> bool {
        self.get_total_collateral_plus_buffer() >= self.margin_requirement_plus_buffer as i128
    }

    pub fn margin_shortage(&self) -> u128 {
        (self.margin_requirement_plus_buffer as i128)
            .saturating_sub(self.get_total_collateral_plus_buffer())
            .max(0) as u128
    }
}

/// Result of [`MarketState::calculate_simplified_margin_requirement`].
#[repr(C, align(16))]
#[derive(Debug, Clone)]
pub struct SimplifiedMarginCalculation {
    pub total_collateral: i128,
    pub total_collateral_buffer: i128,
    pub margin_requirement: u128,
    pub margin_requirement_plus_buffer: u128,
    pub isolated_margin_calculations: [IsolatedMarginCalculation; 8],
    pub with_perp_isolated_liability: bool,
    pub with_spot_isolated_liability: bool,
}

impl SimplifiedMarginCalculation {
    pub fn free_collateral(&self) -> i128 {
        self.total_collateral - self.margin_requirement as i128
    }

    pub fn get_total_collateral_plus_buffer(&self) -> i128 {
        self.total_collateral
            .saturating_add(self.total_collateral_buffer)
    }

    pub fn free_collateral_with_buffer(&self) -> i128 {
        self.get_total_collateral_plus_buffer() - self.margin_requirement_plus_buffer as i128
    }

    pub fn meets_cross_margin_requirement(&self) -> bool {
        self.total_collateral >= self.margin_requirement as i128
    }

    pub fn meets_cross_margin_requirement_with_buffer(&self) -> bool {
        self.get_total_collateral_plus_buffer() >= self.margin_requirement_plus_buffer as i128
    }

    pub fn meets_margin_requirement(&self) -> bool {
        if !self.meets_cross_margin_requirement() {
            return false;
        }
        for calc in &self.isolated_margin_calculations {
            if !calc.is_empty() && !calc.meets_margin_requirement() {
                return false;
            }
        }
        true
    }

    pub fn meets_margin_requirement_with_buffer(&self) -> bool {
        if !self.meets_cross_margin_requirement_with_buffer() {
            return false;
        }
        for calc in &self.isolated_margin_calculations {
            if !calc.is_empty() && !calc.meets_margin_requirement_with_buffer() {
                return false;
            }
        }
        true
    }

    pub fn has_isolated_margin_calculation(&self, market_index: u16) -> bool {
        self.isolated_margin_calculations
            .iter()
            .any(|c| c.market_index == market_index && !c.is_empty())
    }

    pub fn get_isolated_margin_calculation(
        &self,
        market_index: u16,
    ) -> Option<&IsolatedMarginCalculation> {
        self.isolated_margin_calculations
            .iter()
            .find(|c| c.market_index == market_index && !c.is_empty())
    }

    pub fn get_isolated_free_collateral(&self, market_index: u16) -> Option<i128> {
        self.get_isolated_margin_calculation(market_index)
            .map(|c| c.total_collateral - c.margin_requirement as i128)
    }

    pub fn meets_isolated_margin_requirement(&self, market_index: u16) -> Option<bool> {
        self.get_isolated_margin_calculation(market_index)
            .map(|c| c.meets_margin_requirement())
    }
}

fn calculate_token_value(token_amount: i128, price: i64, decimals: u32) -> i128 {
    let strict_price = StrictOraclePrice {
        current: price,
        twap_5min: None,
    };
    get_strict_token_value(token_amount, decimals, &strict_price).unwrap()
}

fn calculate_spot_open_order_margin(position: &SpotPosition) -> u128 {
    (position.open_orders as u128) * OPEN_ORDER_MARGIN_REQUIREMENT
}

fn anchor_err(e: drift::error::ErrorCode) -> SdkError {
    SdkError::Anchor(Box::new(e.into()))
}

impl MarketState {
    /// Calculate margin requirement for `user`.
    ///
    /// Offchain-optimized alternative to the program's
    /// `calculate_margin_requirement_and_total_collateral_and_liability_info` —
    /// drops `MarketMap`/`OracleMap` indirection and fuel accounting, and
    /// supports overriding oracle prices with pyth prices via [`MarketStateData`].
    pub fn calculate_simplified_margin_requirement(
        &self,
        user: &User,
        margin_type: MarginRequirementType,
        margin_buffer: Option<u32>,
    ) -> SdkResult<SimplifiedMarginCalculation> {
        let snapshot = self.load();
        calculate_simplified_margin_requirement(
            user,
            &snapshot,
            margin_type,
            margin_buffer.unwrap_or(0),
        )
    }
}

/// See [`MarketState::calculate_simplified_margin_requirement`].
pub fn calculate_simplified_margin_requirement(
    user: &User,
    market_state: &MarketStateData,
    margin_type: MarginRequirementType,
    margin_buffer: u32,
) -> SdkResult<SimplifiedMarginCalculation> {
    let mut total_collateral = 0i128;
    let mut total_collateral_buffer = 0i128;
    let mut margin_requirement = 0u128;
    let mut margin_requirement_plus_buffer = 0u128;
    let margin_buffer = margin_buffer as u128;

    let mut isolated_margin_calculations = [IsolatedMarginCalculation::default(); 8];
    let mut with_perp_isolated_liability = false;
    let mut with_spot_isolated_liability = false;

    let user_custom_margin_ratio = if margin_type == MarginRequirementType::Initial {
        user.max_margin_ratio
    } else {
        0_u32
    };

    for spot_position in &user.spot_positions {
        if spot_position.is_available() {
            continue;
        }

        let spot_market =
            market_state
                .spot_market(spot_position.market_index)
                .ok_or(SdkError::NoMarketData(crate::MarketId::spot(
                    spot_position.market_index,
                )))?;
        let oracle = market_state
            .spot_oracle(spot_position.market_index)
            .ok_or_else(|| anchor_err(drift::error::ErrorCode::OracleNotFound))?;

        let oracle_price = resolve_oracle_price(
            oracle,
            market_state.spot_pyth(spot_position.market_index),
            market_state.pyth_oracle_diff_threshold_bps,
        );

        let signed_token_amount = spot_position
            .get_signed_token_amount(spot_market)
            .map_err(|e| SdkError::Anchor(Box::new(e.into())))?;

        // usdc deposit in pool 1 doesn't count as collateral
        let skip_token_value =
            user.pool_id == 1 && spot_market.market_index == 0 && !spot_position.is_borrow();

        if spot_market.market_index == QUOTE_SPOT_MARKET_INDEX {
            let mut token_value = calculate_token_value(
                signed_token_amount,
                oracle_price.price,
                spot_market.decimals,
            );

            match spot_position.balance_type {
                SpotBalanceType::Deposit => {
                    if skip_token_value {
                        token_value = 0;
                    }
                    total_collateral += token_value;
                }
                SpotBalanceType::Borrow => {
                    let liability_value = token_value.unsigned_abs();
                    margin_requirement += liability_value;
                    margin_requirement_plus_buffer +=
                        liability_value + (liability_value * margin_buffer) / MARGIN_PRECISION_U128;
                }
            }
        } else {
            let strict_oracle_price = StrictOraclePrice {
                current: oracle_price.price,
                twap_5min: None,
            };

            let OrderFillSimulation {
                orders_value: worst_case_orders_value,
                token_value: worst_case_token_value,
                weighted_token_value: worst_case_weighted_token_value,
                ..
            } = spot_position
                .get_worst_case_fill_simulation(
                    spot_market,
                    &strict_oracle_price,
                    Some(signed_token_amount),
                    margin_type,
                )
                .map_err(|e| SdkError::Anchor(Box::new(e.into())))?
                .apply_user_custom_margin_ratio(
                    spot_market,
                    strict_oracle_price.current,
                    user_custom_margin_ratio,
                )
                .map_err(|e| SdkError::Anchor(Box::new(e.into())))?;

            let open_order_margin = calculate_spot_open_order_margin(spot_position);
            margin_requirement += open_order_margin;

            match worst_case_token_value.cmp(&0) {
                CmpOrdering::Greater => {
                    total_collateral += worst_case_weighted_token_value;
                }
                CmpOrdering::Less => {
                    let liability_value = worst_case_weighted_token_value.unsigned_abs();
                    margin_requirement += liability_value;
                    margin_requirement_plus_buffer += liability_value
                        + (worst_case_token_value.unsigned_abs() * margin_buffer)
                            / MARGIN_PRECISION_U128;

                    if spot_market.asset_tier == AssetTier::Isolated {
                        with_spot_isolated_liability = true;
                    }
                }
                CmpOrdering::Equal => {
                    if spot_position.has_open_order()
                        && spot_market.asset_tier == AssetTier::Isolated
                    {
                        with_spot_isolated_liability = true;
                    }
                }
            }

            match worst_case_orders_value.cmp(&0) {
                CmpOrdering::Greater => {
                    total_collateral += worst_case_orders_value;
                }
                CmpOrdering::Less => {
                    let liability_value = worst_case_orders_value.unsigned_abs();
                    margin_requirement += liability_value;
                    margin_requirement_plus_buffer +=
                        liability_value + (liability_value * margin_buffer) / MARGIN_PRECISION_U128;
                }
                CmpOrdering::Equal => {}
            }
        }
    }

    for perp_position in &user.perp_positions {
        if perp_position.is_available() {
            continue;
        }

        let perp_market =
            market_state
                .perp_market(perp_position.market_index)
                .ok_or(SdkError::NoMarketData(crate::MarketId::perp(
                    perp_position.market_index,
                )))?;

        let oracle = market_state
            .perp_oracle(perp_position.market_index)
            .ok_or_else(|| anchor_err(drift::error::ErrorCode::OracleNotFound))?;
        let oracle_price = resolve_oracle_price(
            oracle,
            market_state.perp_pyth(perp_position.market_index),
            market_state.pyth_oracle_diff_threshold_bps,
        );

        let strict_quote_price = {
            let quote_price_data = market_state
                .spot_oracle(perp_market.quote_spot_market_index)
                .ok_or_else(|| anchor_err(drift::error::ErrorCode::OracleNotFound))?;
            StrictOraclePrice {
                current: quote_price_data.price,
                twap_5min: None,
            }
        };

        let perp_position_custom_margin_ratio = if margin_type == MarginRequirementType::Initial {
            perp_position.max_margin_ratio as u32
        } else {
            0_u32
        };

        let (perp_margin_requirement, weighted_pnl, worst_case_liability_value, _base_asset_value) =
            calculate_perp_position_value_and_pnl(
                perp_position,
                perp_market,
                &oracle_price,
                &strict_quote_price,
                margin_type,
                user_custom_margin_ratio.max(perp_position_custom_margin_ratio),
            )
            .map_err(|e| SdkError::Anchor(Box::new(e.into())))?;

        if perp_position.is_isolated() {
            let quote_spot_market = market_state
                .spot_market(perp_market.quote_spot_market_index)
                .ok_or(SdkError::NoMarketData(crate::MarketId::spot(
                    perp_market.quote_spot_market_index,
                )))?;

            let quote_token_amount = get_token_amount(
                perp_position.isolated_position_scaled_balance as u128,
                quote_spot_market,
                &SpotBalanceType::Deposit,
            )
            .map_err(|e| SdkError::Anchor(Box::new(e.into())))?;

            let quote_token_value = get_strict_token_value(
                quote_token_amount as i128,
                quote_spot_market.decimals,
                &strict_quote_price,
            )
            .map_err(|e| SdkError::Anchor(Box::new(e.into())))?;

            let iso_total_collateral = quote_token_value + weighted_pnl;

            let iso_total_collateral_buffer = if margin_buffer > 0 && weighted_pnl < 0 {
                (weighted_pnl * margin_buffer as i128) / MARGIN_PRECISION_I128
            } else {
                0
            };

            let iso_margin_requirement_plus_buffer = if margin_buffer > 0 {
                perp_margin_requirement
                    + (worst_case_liability_value * margin_buffer) / MARGIN_PRECISION_U128
            } else {
                0
            };

            if let Some(slot) = isolated_margin_calculations
                .iter_mut()
                .find(|c| c.is_empty())
            {
                *slot = IsolatedMarginCalculation {
                    market_index: perp_position.market_index,
                    margin_requirement: perp_margin_requirement,
                    total_collateral: iso_total_collateral,
                    total_collateral_buffer: iso_total_collateral_buffer,
                    margin_requirement_plus_buffer: iso_margin_requirement_plus_buffer,
                };
            }

            with_perp_isolated_liability = true;
        } else {
            margin_requirement += perp_margin_requirement;
            margin_requirement_plus_buffer += perp_margin_requirement
                + (worst_case_liability_value * margin_buffer) / MARGIN_PRECISION_U128;

            total_collateral += weighted_pnl;
            if weighted_pnl < 0 {
                total_collateral_buffer +=
                    (weighted_pnl * margin_buffer as i128) / MARGIN_PRECISION_I128;
            }
        }

        let has_perp_liability = perp_position.base_asset_amount != 0
            || perp_position.quote_asset_amount < 0
            || perp_position.has_open_order();

        if has_perp_liability && perp_market.contract_tier == ContractTier::Isolated {
            with_perp_isolated_liability = true;
        }
    }

    Ok(SimplifiedMarginCalculation {
        total_collateral,
        margin_requirement,
        total_collateral_buffer,
        margin_requirement_plus_buffer,
        isolated_margin_calculations,
        with_perp_isolated_liability,
        with_spot_isolated_liability,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        math::constants::{
            BASE_PRECISION_I64, LIQUIDATION_FEE_PRECISION, MARGIN_PRECISION, PERCENTAGE_PRECISION,
            QUOTE_PRECISION, SPOT_BALANCE_PRECISION, SPOT_CUMULATIVE_INTEREST_PRECISION,
            SPOT_WEIGHT_PRECISION,
        },
        types::{
            accounts::{PerpMarket, SpotMarket, User},
            MarginRequirementType, OracleSource, PerpPosition, SpotBalanceType, SpotPosition,
        },
        OraclePriceData,
    };
    use drift::state::oracle::HistoricalOracleData;

    fn sol_spot_market() -> SpotMarket {
        SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: solana_pubkey::pubkey!("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"),
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            deposit_balance: 1_000 * SPOT_BALANCE_PRECISION,
            order_step_size: 1_000,
            order_tick_size: 1_000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap_5min: 240_000_000_000,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn usdc_spot_market() -> SpotMarket {
        SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 100_000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            order_step_size: 1_000,
            order_tick_size: 1_000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap_5min: 1_000_000,
                ..Default::default()
            },
            ..SpotMarket::default()
        }
    }

    #[test]
    fn calculate_simplified_margin_requirement_works() {
        let btc_perp_index = 1_u16;
        let mut user = User::default();
        user.spot_positions[1] = SpotPosition {
            market_index: 1,
            scaled_balance: (1_000 * SPOT_BALANCE_PRECISION) as u64,
            balance_type: SpotBalanceType::Deposit,
            ..Default::default()
        };
        user.perp_positions[0] = PerpPosition {
            market_index: btc_perp_index,
            base_asset_amount: 100 * BASE_PRECISION_I64,
            quote_asset_amount: -5_000 * QUOTE_PRECISION as i64,
            ..Default::default()
        };

        let mut market_state_data = MarketStateData::default();
        market_state_data.set_spot_market(usdc_spot_market());
        market_state_data.set_spot_market(sol_spot_market());

        let perp_market = PerpMarket {
            market_index: btc_perp_index,
            margin_ratio_initial: 1_000 * MARGIN_PRECISION, // 10%
            margin_ratio_maintenance: 500,                  // 5%
            ..Default::default()
        };
        market_state_data.set_perp_market(perp_market);

        let sol_oracle_price = OraclePriceData {
            price: 240 * QUOTE_PRECISION as i64,
            confidence: 99 * PERCENTAGE_PRECISION as u64,
            delay: 2,
            has_sufficient_number_of_data_points: true,
            sequence_id: None,
        };
        let btc_oracle_price = OraclePriceData {
            price: 120_000 * QUOTE_PRECISION as i64,
            confidence: 99 * PERCENTAGE_PRECISION as u64,
            delay: 2,
            has_sufficient_number_of_data_points: true,
            sequence_id: None,
        };
        let usdc_oracle_price = OraclePriceData {
            price: QUOTE_PRECISION as i64,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
            sequence_id: None,
        };

        market_state_data.set_spot_oracle_price(0, usdc_oracle_price);
        market_state_data.set_spot_oracle_price(1, sol_oracle_price);
        market_state_data.set_perp_oracle_price(btc_perp_index, btc_oracle_price);

        let state = MarketState::new(market_state_data);

        for margin_type in [
            MarginRequirementType::Initial,
            MarginRequirementType::Maintenance,
        ] {
            let result = state
                .calculate_simplified_margin_requirement(&user, margin_type, None)
                .unwrap_or_else(|e| panic!("calc failed for {:?}: {e:?}", margin_type));

            assert!(
                result.total_collateral != 0,
                "total_collateral should be non-zero for {:?}",
                margin_type
            );
            assert!(
                result.margin_requirement > 0,
                "margin_requirement should be positive for {:?}",
                margin_type
            );
        }
    }
}
