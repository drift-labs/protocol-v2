use crate::controller::position::PositionDirection;
use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;
use crate::state::perp_market::{ContractTier, PerpMarket};
use crate::state::user::{MarketType, OrderTriggerCondition, OrderType};
use crate::PERCENTAGE_PRECISION_U64;
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use std::ops::Div;

#[cfg(test)]
mod tests;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, Copy, Eq, PartialEq, Debug)]
pub struct OrderParams {
    pub order_type: OrderType,
    pub market_type: MarketType,
    pub direction: PositionDirection,
    pub user_order_id: u8,
    pub base_asset_amount: u64,
    pub price: u64,
    pub market_index: u16,
    pub reduce_only: bool,
    pub post_only: PostOnlyParam,
    pub immediate_or_cancel: bool,
    pub max_ts: Option<i64>,
    pub trigger_price: Option<u64>,
    pub trigger_condition: OrderTriggerCondition,
    pub oracle_price_offset: Option<i32>, // price offset from oracle for order (~ +/- 2147 max)
    pub auction_duration: Option<u8>,     // specified in slots
    pub auction_start_price: Option<i64>, // specified in price or oracle_price_offset
    pub auction_end_price: Option<i64>,   // specified in price or oracle_price_offset
}

impl OrderParams {
    pub fn get_auction_start_price_offset(self, oracle_price: i64) -> DriftResult<i64> {
        let start_offset = if self.price == 0 && self.oracle_price_offset.is_some() {
            self.auction_start_price.unwrap_or(0)
        } else {
            if let Some(auction_start_price) = self.auction_start_price {
                auction_start_price.safe_sub(oracle_price)?
            } else {
                return Ok(0);
            }
        };

        Ok(start_offset)
    }

    pub fn update_perp_auction_params_limit_orders(
        &mut self,
        perp_market: &PerpMarket,
        oracle_price: i64,
    ) -> DriftResult {
        if self.order_type != OrderType::Limit {
            return Ok(());
        }

        if self.post_only != PostOnlyParam::None {
            return Ok(());
        }
        if self.immediate_or_cancel {
            return Ok(());
        }
        if self.oracle_price_offset.is_some() || self.price == 0 {
            return Ok(());
        }

        if self.post_only == PostOnlyParam::None && !self.immediate_or_cancel {
            if self.oracle_price_offset.is_some() || self.price == 0 {
                return Ok(());
            }

            match self.direction {
                PositionDirection::Long => {
                    let ask_premium = perp_market.amm.last_ask_premium()?;
                    let est_ask = oracle_price.safe_add(ask_premium)?.cast()?;
                    if self.price > est_ask {
                        let auction_duration =
                            get_auction_duration(self.price.safe_sub(est_ask)?, est_ask)?;
                        let auction_start_price = est_ask as i64;
                        let auction_end_price = self.price as i64;
                        msg!("derived auction params for limit order. duration = {} start_price = {} end_price = {}", auction_duration, auction_start_price, auction_end_price);
                        self.auction_duration = Some(auction_duration);
                        self.auction_start_price = Some(auction_start_price);
                        self.auction_end_price = Some(auction_end_price);
                    }
                }
                PositionDirection::Short => {
                    let bid_discount = perp_market.amm.last_bid_discount()?;
                    let est_bid = oracle_price.safe_sub(bid_discount)?.cast()?;
                    if self.price < est_bid {
                        let auction_duration =
                            get_auction_duration(est_bid.safe_sub(self.price)?, est_bid)?;
                        let auction_start_price = est_bid as i64;
                        let auction_end_price = self.price as i64;
                        msg!("derived auction params for limit order. duration = {} start_price = {} end_price = {}", auction_duration, auction_start_price, auction_end_price);
                        self.auction_duration = Some(auction_duration);
                        self.auction_start_price = Some(auction_start_price);
                        self.auction_end_price = Some(auction_end_price);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn update_perp_auction_params_market_orders(
        &mut self,
        perp_market: &PerpMarket,
        oracle_price: i64,
    ) -> DriftResult {
        if self.auction_duration.is_some()
            && perp_market
                .contract_tier
                .is_as_safe_as_contract(&ContractTier::B)
        {
            let (auction_start_price, _auction_end_price) =
                OrderParams::get_perp_baseline_start_end_price_offset(perp_market, self.direction)?;
            match self.direction {
                PositionDirection::Long => {
                    let a = self.get_auction_start_price_offset(oracle_price)?;
                    if a > auction_start_price {
                        self.auction_start_price = if self.order_type == OrderType::Oracle {
                            Some(auction_start_price)
                        } else {
                            Some(auction_start_price.safe_add(oracle_price)?)
                        };
                        if let (Some(start_price), Some(end_price)) =
                            (self.auction_start_price, self.auction_end_price)
                        {
                            self.auction_duration = Some(get_auction_duration(
                                end_price.safe_sub(start_price)?.unsigned_abs(),
                                oracle_price.unsigned_abs(),
                            )?);
                        }
                    }
                }
                PositionDirection::Short => {
                    let a = self.get_auction_start_price_offset(oracle_price)?;
                    if a < auction_start_price {
                        self.auction_start_price = if self.order_type == OrderType::Oracle {
                            Some(auction_start_price)
                        } else {
                            Some(auction_start_price.safe_add(oracle_price)?)
                        };

                        if let (Some(start_price), Some(end_price)) =
                            (self.auction_start_price, self.auction_end_price)
                        {
                            self.auction_duration = Some(get_auction_duration(
                                end_price.safe_sub(start_price)?.unsigned_abs(),
                                oracle_price.unsigned_abs(),
                            )?);
                        }
                    }
                }
            }
        }
        Ok(())
    }
    pub fn update_perp_auction_params(
        &mut self,
        perp_market: &PerpMarket,
        oracle_price: i64,
    ) -> DriftResult {
        match self.order_type {
            OrderType::Limit => {
                self.update_perp_auction_params_limit_orders(perp_market, oracle_price)?;
            }
            OrderType::Market => {
                self.update_perp_auction_params_market_orders(perp_market, oracle_price)?;
            }
            OrderType::Oracle => {
                self.update_perp_auction_params_market_orders(perp_market, oracle_price)?;
            }
            _ => {}
        }

        Ok(())
    }

    pub fn get_perp_baseline_start_end_price_offset(
        perp_market: &PerpMarket,
        direction: PositionDirection,
    ) -> DriftResult<(i64, i64)> {
        // price offsets baselines for perp market auctions

        let mark_twap = perp_market
            .amm
            .last_ask_price_twap
            .safe_add(perp_market.amm.last_bid_price_twap)?
            .safe_div(2)?;
        let oracle_twap = perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap
            .unsigned_abs();

        let baseline_start_price_offset = mark_twap.cast::<i64>()?.safe_sub(
            perp_market
                .amm
                .historical_oracle_data
                .last_oracle_price_twap,
        )?;

        let (min_divisor, max_divisor) = perp_market.get_auction_end_min_max_divisors()?;

        let amm_spread_side_pct = if direction == PositionDirection::Short {
            perp_market.amm.short_spread
        } else {
            perp_market.amm.long_spread
        };

        let baseline_end_price_buffer = perp_market
            .amm
            .mark_std
            .max(perp_market.amm.oracle_std)
            .max(
                amm_spread_side_pct
                    .cast::<u64>()?
                    .safe_mul(oracle_twap)?
                    .safe_div(PERCENTAGE_PRECISION_U64)?,
            )
            .clamp(oracle_twap / min_divisor, oracle_twap / max_divisor);

        let baseline_end_price_offset = if direction == PositionDirection::Short {
            let auction_end_price = perp_market
                .amm
                .last_bid_price_twap
                .safe_sub(baseline_end_price_buffer)?
                .cast::<i64>()?
                .safe_sub(
                    perp_market
                        .amm
                        .historical_oracle_data
                        .last_oracle_price_twap,
                )?;
            auction_end_price.min(baseline_start_price_offset)
        } else {
            let auction_end_price = perp_market
                .amm
                .last_ask_price_twap
                .safe_add(baseline_end_price_buffer)?
                .cast::<i64>()?
                .safe_sub(
                    perp_market
                        .amm
                        .historical_oracle_data
                        .last_oracle_price_twap,
                )?;

            auction_end_price.max(baseline_start_price_offset)
        };

        Ok((baseline_start_price_offset, baseline_end_price_offset))
    }

    pub fn get_close_perp_params(
        market: &PerpMarket,
        direction_to_close: PositionDirection,
        base_asset_amount: u64,
    ) -> DriftResult<OrderParams> {
        let (auction_start_price, auction_end_price) =
            OrderParams::get_perp_baseline_start_end_price_offset(market, direction_to_close)?;

        let params = OrderParams {
            market_type: MarketType::Perp,
            direction: direction_to_close,
            order_type: OrderType::Oracle,
            market_index: market.market_index,
            base_asset_amount,
            reduce_only: true,
            auction_start_price: Some(auction_start_price),
            auction_end_price: Some(auction_end_price),
            auction_duration: Some(80),
            oracle_price_offset: Some(auction_end_price.cast()?),
            ..OrderParams::default()
        };

        Ok(params)
    }
}

fn get_auction_duration(price_diff: u64, price: u64) -> DriftResult<u8> {
    let percent_diff = price_diff.safe_mul(PERCENTAGE_PRECISION_U64)?.div(price);

    Ok(percent_diff
        .safe_mul(60)?
        .safe_div_ceil(PERCENTAGE_PRECISION_U64 / 100)? // 1% = 60 slots
        .clamp(10, 180) as u8) // 180 slots max
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum PostOnlyParam {
    None,
    MustPostOnly, // Tx fails if order can't be post only
    TryPostOnly,  // Tx succeeds and order not placed if can't be post only
    Slide,        // Modify price to be post only if can't be post only
}

impl Default for PostOnlyParam {
    fn default() -> Self {
        PostOnlyParam::None
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ModifyOrderParams {
    pub direction: Option<PositionDirection>,
    pub base_asset_amount: Option<u64>,
    pub price: Option<u64>,
    pub reduce_only: Option<bool>,
    pub post_only: Option<PostOnlyParam>,
    pub immediate_or_cancel: Option<bool>,
    pub max_ts: Option<i64>,
    pub trigger_price: Option<u64>,
    pub trigger_condition: Option<OrderTriggerCondition>,
    pub oracle_price_offset: Option<i32>,
    pub auction_duration: Option<u8>,
    pub auction_start_price: Option<i64>,
    pub auction_end_price: Option<i64>,
    pub policy: Option<ModifyOrderPolicy>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Eq, PartialEq)]
pub enum ModifyOrderPolicy {
    TryModify,
    MustModify,
}

impl Default for ModifyOrderPolicy {
    fn default() -> Self {
        Self::TryModify
    }
}

pub struct PlaceOrderOptions {
    pub try_expire_orders: bool,
    pub enforce_margin_check: bool,
    pub risk_increasing: bool,
}

impl Default for PlaceOrderOptions {
    fn default() -> Self {
        Self {
            try_expire_orders: true,
            enforce_margin_check: true,
            risk_increasing: false,
        }
    }
}

impl PlaceOrderOptions {
    pub fn update_risk_increasing(&mut self, risk_increasing: bool) {
        self.risk_increasing = self.risk_increasing || risk_increasing;
    }
}
