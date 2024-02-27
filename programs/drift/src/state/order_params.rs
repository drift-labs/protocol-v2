use crate::controller::position::PositionDirection;
use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;
use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::events::OrderActionExplanation;
use crate::state::perp_market::{ContractTier, PerpMarket};
use crate::state::user::{MarketType, OrderTriggerCondition, OrderType};
use crate::{PERCENTAGE_PRECISION_U64, PRICE_PRECISION_I64};
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
    pub fn update_perp_auction_params_limit_orders(
        &mut self,
        perp_market: &PerpMarket,
        oracle_price: i64,
    ) -> DriftResult {
        if self.post_only != PostOnlyParam::None {
            return Ok(());
        }

        if self.immediate_or_cancel {
            return Ok(());
        }

        if self.oracle_price_offset.is_some() || self.price == 0 {
            return Ok(());
        }

        let auction_start_price_offset =
            OrderParams::get_perp_baseline_start_price_offset(perp_market, self.direction)?;
        let new_auction_start_price = oracle_price.safe_add(auction_start_price_offset)?;

        if self.auction_duration.is_none() {
            match self.direction {
                PositionDirection::Long => {
                    let ask_premium = perp_market.amm.last_ask_premium()?;
                    let est_ask = oracle_price.safe_add(ask_premium)?.cast()?;
                    if self.price <= est_ask {
                        // if auction duration is empty and limit doesnt cross vamm premium, return early
                        return Ok(());
                    } else {
                        let new_auction_start_price = new_auction_start_price.min(est_ask as i64);
                        msg!(
                            "Updating auction start price to {}",
                            new_auction_start_price
                        );
                        self.auction_start_price = Some(new_auction_start_price);
                        msg!("Updating auction end price to {}", self.price);
                        self.auction_end_price = Some(self.price as i64);
                    }
                }
                PositionDirection::Short => {
                    let bid_discount = perp_market.amm.last_bid_discount()?;
                    let est_bid = oracle_price.safe_sub(bid_discount)?.cast()?;
                    if self.price >= est_bid {
                        // if auction duration is empty and limit doesnt cross vamm discount, return early
                        return Ok(());
                    } else {
                        let new_auction_start_price = new_auction_start_price.max(est_bid as i64);
                        msg!(
                            "Updating auction start price to {}",
                            new_auction_start_price
                        );
                        self.auction_start_price = Some(new_auction_start_price);
                        msg!("Updating auction end price to {}", self.price);
                        self.auction_end_price = Some(self.price as i64);
                    }
                }
            }
        } else {
            match self.auction_start_price {
                Some(auction_start_price) => {
                    let improves_long = self.direction == PositionDirection::Long
                        && new_auction_start_price < auction_start_price;

                    let improves_short = self.direction == PositionDirection::Short
                        && new_auction_start_price > auction_start_price;

                    if improves_long || improves_short {
                        msg!(
                            "Updating auction start price to {}",
                            new_auction_start_price
                        );
                        self.auction_start_price = Some(new_auction_start_price);
                    }
                }
                None => {
                    msg!("Updating auction end price to {}", new_auction_start_price);
                    self.auction_start_price = Some(new_auction_start_price);
                }
            }

            if self.auction_end_price.is_none() {
                msg!("Updating auction end price to {}", new_auction_start_price);
                self.auction_end_price = Some(self.price as i64);
            }
        }

        let auction_duration_before = self.auction_duration;
        let new_auction_duration = get_auction_duration(
            self.auction_end_price
                .safe_unwrap()?
                .safe_sub(self.auction_start_price.safe_unwrap()?)?
                .unsigned_abs(),
            oracle_price.unsigned_abs(),
            perp_market.contract_tier,
        )?;
        self.auction_duration = Some(
            auction_duration_before
                .unwrap_or(0)
                .max(new_auction_duration),
        );

        if auction_duration_before != self.auction_duration {
            msg!(
                "Updating auction duration to {}",
                self.auction_duration.safe_unwrap()?
            );
        }

        Ok(())
    }

    pub fn get_auction_start_price_offset(self, oracle_price: i64) -> DriftResult<i64> {
        let start_offset = if self.order_type == OrderType::Oracle {
            self.auction_start_price.unwrap_or(0)
        } else if let Some(auction_start_price) = self.auction_start_price {
            auction_start_price.safe_sub(oracle_price)?
        } else {
            return Ok(0);
        };

        Ok(start_offset)
    }

    pub fn update_perp_auction_params_market_and_oracle_orders(
        &mut self,
        perp_market: &PerpMarket,
        oracle_price: i64,
        is_market_order: bool,
    ) -> DriftResult {
        if self.auction_duration.is_none()
            || self.auction_start_price.is_none()
            || self.auction_end_price.is_none()
        {
            let (auction_start_price, auction_end_price, auction_duration) = if is_market_order {
                OrderParams::derive_market_order_auction_params(
                    perp_market,
                    self.direction,
                    oracle_price,
                    self.price,
                )?
            } else {
                OrderParams::derive_oracle_order_auction_params(
                    perp_market,
                    self.direction,
                    oracle_price,
                    self.oracle_price_offset,
                )?
            };

            self.auction_start_price = Some(auction_start_price);
            self.auction_end_price = Some(auction_end_price);
            self.auction_duration = Some(auction_duration);

            msg!(
                "Updating auction start price to {}",
                self.auction_start_price.safe_unwrap()?
            );

            msg!(
                "Updating auction end price to {}",
                self.auction_end_price.safe_unwrap()?
            );

            msg!(
                "Updating auction duration to {}",
                self.auction_duration.safe_unwrap()?
            );

            return Ok(());
        }

        // only update auction start price if the contract tier is as safe as B
        if perp_market
            .contract_tier
            .is_as_safe_as_contract(&ContractTier::B)
        {
            let new_start_price_offset =
                OrderParams::get_perp_baseline_start_price_offset(perp_market, self.direction)?;
            match self.direction {
                PositionDirection::Long => {
                    let current_start_price_offset =
                        self.get_auction_start_price_offset(oracle_price)?;
                    if current_start_price_offset > new_start_price_offset {
                        self.auction_start_price = if !is_market_order {
                            Some(new_start_price_offset)
                        } else {
                            Some(new_start_price_offset.safe_add(oracle_price)?)
                        };
                        msg!(
                            "Updating auction start price to {}",
                            self.auction_start_price.safe_unwrap()?
                        );
                    }
                }
                PositionDirection::Short => {
                    let current_start_price_offset =
                        self.get_auction_start_price_offset(oracle_price)?;
                    if current_start_price_offset < new_start_price_offset {
                        self.auction_start_price = if !is_market_order {
                            Some(new_start_price_offset)
                        } else {
                            Some(new_start_price_offset.safe_add(oracle_price)?)
                        };
                        msg!(
                            "Updating auction start price to {}",
                            self.auction_start_price.safe_unwrap()?
                        );
                    }
                }
            }
        }

        let auction_duration_before = self.auction_duration;
        let new_auction_duration = get_auction_duration(
            self.auction_end_price
                .safe_unwrap()?
                .safe_sub(self.auction_start_price.safe_unwrap()?)?
                .unsigned_abs(),
            oracle_price.unsigned_abs(),
            perp_market.contract_tier,
        )?;
        self.auction_duration = Some(
            auction_duration_before
                .unwrap_or(0)
                .max(new_auction_duration),
        );

        if auction_duration_before != self.auction_duration {
            msg!(
                "Updating auction duration to {}",
                self.auction_duration.safe_unwrap()?
            );
        }

        Ok(())
    }

    pub fn derive_market_order_auction_params(
        perp_market: &PerpMarket,
        direction: PositionDirection,
        oracle_price: i64,
        limit_price: u64,
    ) -> DriftResult<(i64, i64, u8)> {
        let (auction_start_price, auction_end_price) = if limit_price != 0 {
            let auction_start_price_offset =
                OrderParams::get_perp_baseline_start_price_offset(perp_market, direction)?;
            let mut auction_start_price = oracle_price.safe_add(auction_start_price_offset)?;

            let limit_price = limit_price as i64;
            if direction == PositionDirection::Long {
                auction_start_price = auction_start_price.min(limit_price)
            } else {
                auction_start_price = auction_start_price.max(limit_price)
            };

            (auction_start_price, limit_price)
        } else {
            let (auction_start_price_offset, auction_end_price_offset) =
                OrderParams::get_perp_baseline_start_end_price_offset(perp_market, direction)?;
            let auction_start_price = oracle_price.safe_add(auction_start_price_offset)?;
            let auction_end_price = oracle_price.safe_add(auction_end_price_offset)?;

            (auction_start_price, auction_end_price)
        };

        let auction_duration = get_auction_duration(
            auction_end_price
                .safe_sub(auction_start_price)?
                .unsigned_abs(),
            oracle_price.unsigned_abs(),
            perp_market.contract_tier,
        )?;

        Ok((auction_start_price, auction_end_price, auction_duration))
    }

    pub fn derive_oracle_order_auction_params(
        perp_market: &PerpMarket,
        direction: PositionDirection,
        oracle_price: i64,
        oracle_price_offset: Option<i32>,
    ) -> DriftResult<(i64, i64, u8)> {
        let (auction_start_price, auction_end_price) =
            if let Some(oracle_price_offset) = oracle_price_offset {
                let mut auction_start_price_offset =
                    OrderParams::get_perp_baseline_start_price_offset(perp_market, direction)?;

                let oracle_price_offset = oracle_price_offset as i64;
                if direction == PositionDirection::Long {
                    auction_start_price_offset = auction_start_price_offset.min(oracle_price_offset)
                } else {
                    auction_start_price_offset = auction_start_price_offset.max(oracle_price_offset)
                };

                (auction_start_price_offset, oracle_price_offset as i64)
            } else {
                let (auction_start_price_offset, auction_end_price_offset) =
                    OrderParams::get_perp_baseline_start_end_price_offset(perp_market, direction)?;

                (auction_start_price_offset, auction_end_price_offset)
            };

        let auction_duration = get_auction_duration(
            auction_end_price
                .safe_sub(auction_start_price)?
                .unsigned_abs(),
            oracle_price.unsigned_abs(),
            perp_market.contract_tier,
        )?;

        Ok((auction_start_price, auction_end_price, auction_duration))
    }

    pub fn update_perp_auction_params(
        &mut self,
        perp_market: &PerpMarket,
        oracle_price: i64,
    ) -> DriftResult {
        #[cfg(feature = "anchor-test")]
        return Ok(());

        match self.order_type {
            OrderType::Limit => {
                self.update_perp_auction_params_limit_orders(perp_market, oracle_price)?;
            }
            OrderType::Market | OrderType::Oracle => {
                self.update_perp_auction_params_market_and_oracle_orders(
                    perp_market,
                    oracle_price,
                    self.order_type == OrderType::Market,
                )?;
            }
            _ => {}
        }

        Ok(())
    }

    pub fn get_perp_baseline_start_price_offset(
        perp_market: &PerpMarket,
        direction: PositionDirection,
    ) -> DriftResult<i64> {
        if perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_ts
            .safe_sub(perp_market.amm.last_mark_price_twap_ts)?
            .abs()
            >= 60
        {
            // if uncertain with timestamp mismatch, enforce within N bps
            let price_divisor = if perp_market
                .contract_tier
                .is_as_safe_as_contract(&ContractTier::B)
            {
                500
            } else {
                100
            };

            return Ok(match direction {
                PositionDirection::Long => {
                    perp_market.amm.last_bid_price_twap.cast::<i64>()? / price_divisor
                }
                PositionDirection::Short => {
                    -(perp_market.amm.last_ask_price_twap.cast::<i64>()? / price_divisor)
                }
            });
        }

        // price offsets baselines for perp market auctions
        let mark_twap_slow = match direction {
            PositionDirection::Long => perp_market.amm.last_bid_price_twap,
            PositionDirection::Short => perp_market.amm.last_ask_price_twap,
        }
        .cast::<i64>()?;

        let baseline_start_price_offset_slow = mark_twap_slow.safe_sub(
            perp_market
                .amm
                .historical_oracle_data
                .last_oracle_price_twap,
        )?;

        let baseline_start_price_offset_fast = perp_market
            .amm
            .last_mark_price_twap_5min
            .cast::<i64>()?
            .safe_sub(
                perp_market
                    .amm
                    .historical_oracle_data
                    .last_oracle_price_twap_5min,
            )?;

        let frac_of_long_spread_in_price: i64 = perp_market
            .amm
            .long_spread
            .cast::<i64>()?
            .safe_mul(mark_twap_slow)?
            .safe_div(PRICE_PRECISION_I64 * 10)?;

        let frac_of_short_spread_in_price: i64 = perp_market
            .amm
            .short_spread
            .cast::<i64>()?
            .safe_mul(mark_twap_slow)?
            .safe_div(PRICE_PRECISION_I64 * 10)?;

        let baseline_start_price_offset = match direction {
            PositionDirection::Long => baseline_start_price_offset_slow
                .safe_add(frac_of_long_spread_in_price)?
                .min(baseline_start_price_offset_fast.safe_sub(frac_of_short_spread_in_price)?),
            PositionDirection::Short => baseline_start_price_offset_slow
                .safe_sub(frac_of_short_spread_in_price)?
                .max(baseline_start_price_offset_fast.safe_add(frac_of_long_spread_in_price)?),
        };

        Ok(baseline_start_price_offset)
    }

    pub fn get_perp_baseline_start_end_price_offset(
        perp_market: &PerpMarket,
        direction: PositionDirection,
    ) -> DriftResult<(i64, i64)> {
        let oracle_twap = perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap
            .unsigned_abs();
        let baseline_start_price_offset =
            OrderParams::get_perp_baseline_start_price_offset(perp_market, direction)?;
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

fn get_auction_duration(
    price_diff: u64,
    price: u64,
    contract_tier: ContractTier,
) -> DriftResult<u8> {
    let percent_diff = price_diff.safe_mul(PERCENTAGE_PRECISION_U64)?.div(price);

    let slots_per_bp = if contract_tier.is_as_safe_as_contract(&ContractTier::B) {
        100
    } else {
        60
    };

    Ok(percent_diff
        .safe_mul(slots_per_bp)?
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
    pub explanation: OrderActionExplanation,
}

impl Default for PlaceOrderOptions {
    fn default() -> Self {
        Self {
            try_expire_orders: true,
            enforce_margin_check: true,
            risk_increasing: false,
            explanation: OrderActionExplanation::None,
        }
    }
}

impl PlaceOrderOptions {
    pub fn update_risk_increasing(&mut self, risk_increasing: bool) {
        self.risk_increasing = self.risk_increasing || risk_increasing;
    }

    pub fn explanation(mut self, explanation: OrderActionExplanation) -> Self {
        self.explanation = explanation;
        self
    }
}
