use crate::controller::position::PositionDirection;
use crate::state::user::{MarketType, OrderTriggerCondition, OrderType};
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

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
