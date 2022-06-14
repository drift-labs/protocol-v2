use std::cmp::{max, min};

use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;

use crate::controller::position::PositionDirection;
use crate::error::ClearingHouseResult;
use crate::math_error;

#[account(zero_copy)]
#[derive(Default)]
#[repr(packed)]
pub struct User {
    pub authority: Pubkey,
    pub collateral: u128,
    pub cumulative_deposits: i128,
    pub total_fee_paid: u64,
    pub total_fee_rebate: u64,
    pub total_token_discount: u128,
    pub total_referral_reward: u128,
    pub total_referee_discount: u128,
    pub next_order_id: u64,
    pub positions: [MarketPosition; 5],
    pub orders: [Order; 32],
}

// SPACE: 1040
#[zero_copy]
#[derive(Default)]
#[repr(packed)]
pub struct MarketPosition {
    pub market_index: u64,
    pub base_asset_amount: i128,
    pub quote_asset_amount: u128,
    pub last_cumulative_funding_rate: i128,
    pub last_cumulative_repeg_rebate: u128,
    pub last_funding_rate_ts: i64,
    pub open_orders: u128,

    // upgrade-ability
    pub padding0: u128,
    pub padding1: u128,
    pub padding2: u128,
    pub padding3: u128,
    pub padding4: u128,
    pub padding5: u128,
    pub padding6: u128,
}

impl MarketPosition {
    pub fn is_for(&self, market_index: u64) -> bool {
        self.market_index == market_index && (self.is_open_position() || self.has_open_order())
    }

    pub fn is_available(&self) -> bool {
        !self.is_open_position() && !self.has_open_order()
    }

    pub fn is_open_position(&self) -> bool {
        self.base_asset_amount != 0
    }

    pub fn has_open_order(&self) -> bool {
        self.open_orders != 0
    }
}

pub type UserPositions = [MarketPosition; 5];

// SPACE: 7136
#[zero_copy]
#[repr(packed)]
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct Order {
    pub status: OrderStatus,
    pub order_type: OrderType,
    pub ts: i64,
    pub order_id: u64,
    pub user_order_id: u8,
    pub market_index: u64,
    pub price: u128,
    pub user_base_asset_amount: i128,
    pub quote_asset_amount: u128,
    pub base_asset_amount: u128,
    pub base_asset_amount_filled: u128,
    pub quote_asset_amount_filled: u128,
    pub fee: i128,
    pub direction: PositionDirection,
    pub reduce_only: bool,
    pub post_only: bool,
    pub immediate_or_cancel: bool,
    pub discount_tier: OrderDiscountTier,
    pub trigger_price: u128,
    pub trigger_condition: OrderTriggerCondition,
    pub referrer: Pubkey,
    pub oracle_price_offset: i128,
    pub padding: [u16; 3],
}

impl Order {
    pub fn has_oracle_price_offset(self) -> bool {
        self.oracle_price_offset != 0
    }

    pub fn get_limit_price(self, valid_oracle_price: Option<i128>) -> ClearingHouseResult<u128> {
        // the limit price can be hardcoded on order or derived from oracle_price + oracle_price_offset
        let price = if self.has_oracle_price_offset() {
            if let Some(oracle_price) = valid_oracle_price {
                let limit_price = oracle_price
                    .checked_add(self.oracle_price_offset)
                    .ok_or_else(math_error!())?;

                if limit_price <= 0 {
                    msg!("Oracle offset limit price below zero: {}", limit_price);
                    return Err(crate::error::ErrorCode::InvalidOracleOffset);
                }

                // if the order is post only, a limit price must also be specified with oracle offset
                if self.post_only {
                    match self.direction {
                        PositionDirection::Long => min(self.price, limit_price.unsigned_abs()),
                        PositionDirection::Short => max(self.price, limit_price.unsigned_abs()),
                    }
                } else {
                    limit_price.unsigned_abs()
                }
            } else {
                msg!("Could not find oracle too calculate oracle offset limit price");
                return Err(crate::error::ErrorCode::OracleNotFound);
            }
        } else {
            self.price
        };

        Ok(price)
    }
}

impl Default for Order {
    fn default() -> Self {
        Self {
            status: OrderStatus::Init,
            order_type: OrderType::Limit,
            ts: 0,
            order_id: 0,
            user_order_id: 0,
            market_index: 0,
            price: 0,
            user_base_asset_amount: 0,
            base_asset_amount: 0,
            quote_asset_amount: 0,
            base_asset_amount_filled: 0,
            quote_asset_amount_filled: 0,
            fee: 0,
            direction: PositionDirection::Long,
            reduce_only: false,
            post_only: false,
            immediate_or_cancel: false,
            discount_tier: OrderDiscountTier::None,
            trigger_price: 0,
            trigger_condition: OrderTriggerCondition::Above,
            referrer: Pubkey::default(),
            oracle_price_offset: 0,
            padding: [0; 3],
        }
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum OrderStatus {
    Init,
    Open,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum OrderType {
    Market,
    Limit,
    TriggerMarket,
    TriggerLimit,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum OrderDiscountTier {
    None,
    First,
    Second,
    Third,
    Fourth,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum OrderTriggerCondition {
    Above,
    Below,
}

impl Default for OrderTriggerCondition {
    // UpOnly
    fn default() -> Self {
        OrderTriggerCondition::Above
    }
}
