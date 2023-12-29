use crate::controller::position::PositionDirection;
use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;
use crate::state::perp_market::PerpMarket;
use crate::state::user::{MarketType, OrderTriggerCondition, OrderType};
use crate::PERCENTAGE_PRECISION_U64;
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use std::ops::Div;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, Copy)]
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
    pub oracle_price_offset: Option<i32>,
    pub auction_duration: Option<u8>,
    pub auction_start_price: Option<i64>,
    pub auction_end_price: Option<i64>,
}

impl OrderParams {
    pub fn update_perp_auction_params(
        &mut self,
        perp_market: &PerpMarket,
        oracle_price: i64,
    ) -> DriftResult {
        if self.order_type != OrderType::Limit {
            return Ok(());
        }

        if self.auction_duration.is_some() {
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

        match self.direction {
            PositionDirection::Long => {
                let ask_premium = perp_market.amm.last_ask_premium()?;
                let est_ask = oracle_price.safe_add(ask_premium)?.cast()?;
                if self.price > est_ask {
                    let auction_duration =
                        get_auction_duration(self.price.safe_sub(est_ask)?, self.price)?;
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
                        get_auction_duration(est_bid.safe_sub(self.price)?, self.price)?;
                    let auction_start_price = est_bid as i64;
                    let auction_end_price = self.price as i64;
                    msg!("derived auction params for limit order. duration = {} start_price = {} end_price = {}", auction_duration, auction_start_price, auction_end_price);
                    self.auction_duration = Some(auction_duration);
                    self.auction_start_price = Some(auction_start_price);
                    self.auction_end_price = Some(auction_end_price);
                }
            }
        }

        Ok(())
    }
}

fn get_auction_duration(price_diff: u64, price: u64) -> DriftResult<u8> {
    let percent_diff = price_diff.safe_mul(PERCENTAGE_PRECISION_U64)?.div(price);

    Ok(percent_diff
        .safe_mul(60)?
        .safe_div(PERCENTAGE_PRECISION_U64 / 100)? // 1% = 60 seconds
        .clamp(10, 60) as u8)
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
