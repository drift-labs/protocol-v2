use std::cmp::{max, min};

use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;

use crate::controller::position::{get_position_index, PositionDirection};
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::auction::calculate_auction_price;
use crate::math::constants::QUOTE_ASSET_BANK_INDEX;
use crate::math_error;
use crate::state::bank::{BankBalance, BankBalanceType};

#[account(zero_copy)]
#[derive(Default)]
#[repr(packed)]
pub struct User {
    pub authority: Pubkey,
    pub user_id: u8,
    pub name: [u8; 32],
    pub bank_balances: [UserBankBalance; 8],
    pub total_fee_paid: u64,
    pub total_fee_rebate: u64,
    pub total_token_discount: u128,
    pub total_referral_reward: u128,
    pub total_referee_discount: u128,
    pub next_order_id: u64,
    pub positions: [MarketPosition; 5],
    pub orders: [Order; 32],
}

impl User {
    pub fn get_bank_balance_mut(&mut self, bank_index: u64) -> Option<&mut UserBankBalance> {
        // first bank balance is always quote asset, which is
        if bank_index == 0 {
            return Some(&mut self.bank_balances[0]);
        }

        self.bank_balances
            .iter_mut()
            .find(|bank_balance| bank_balance.bank_index == bank_index)
    }

    pub fn get_quote_asset_bank_balance_mut(&mut self) -> &mut UserBankBalance {
        self.get_bank_balance_mut(QUOTE_ASSET_BANK_INDEX).unwrap()
    }

    pub fn get_next_available_bank_balance(&mut self) -> Option<&mut UserBankBalance> {
        let mut next_available_balance = None;

        for (i, bank_balance) in self.bank_balances.iter_mut().enumerate() {
            if i != 0 && bank_balance.bank_index == 0 {
                next_available_balance = Some(bank_balance);
                break;
            }
        }

        next_available_balance
    }

    pub fn add_bank_balance(
        &mut self,
        bank_index: u64,
        balance_type: BankBalanceType,
    ) -> ClearingHouseResult<&mut UserBankBalance> {
        let next_balance = self
            .get_next_available_bank_balance()
            .ok_or(ErrorCode::NoUserBankBalanceAvailable)?;

        *next_balance = UserBankBalance {
            bank_index,
            balance_type,
            balance: 0,
        };

        Ok(next_balance)
    }

    pub fn get_position_mut(
        &mut self,
        market_index: u64,
    ) -> ClearingHouseResult<&mut MarketPosition> {
        Ok(&mut self.positions[get_position_index(&self.positions, market_index)?])
    }

    pub fn get_order_index(&self, order_id: u64) -> ClearingHouseResult<usize> {
        self.orders
            .iter()
            .position(|order| order.order_id == order_id)
            .ok_or(ErrorCode::OrderDoesNotExist)
    }
}

#[zero_copy]
#[derive(Default)]
#[repr(packed)]
pub struct UserBankBalance {
    pub bank_index: u64,
    pub balance_type: BankBalanceType,
    pub balance: u128,
}

impl BankBalance for UserBankBalance {
    fn balance_type(&self) -> &BankBalanceType {
        &self.balance_type
    }

    fn balance(&self) -> u128 {
        self.balance
    }

    fn increase_balance(&mut self, delta: u128) -> ClearingHouseResult {
        self.balance = self.balance.checked_add(delta).ok_or_else(math_error!())?;
        Ok(())
    }

    fn decrease_balance(&mut self, delta: u128) -> ClearingHouseResult {
        self.balance = self.balance.checked_sub(delta).ok_or_else(math_error!())?;
        Ok(())
    }

    fn update_balance_type(&mut self, balance_type: BankBalanceType) -> ClearingHouseResult {
        self.balance_type = balance_type;
        Ok(())
    }
}

#[zero_copy]
#[derive(Default, Debug)]
#[repr(packed)]
pub struct MarketPosition {
    pub market_index: u64,
    pub base_asset_amount: i128,
    pub quote_asset_amount: u128,
    pub quote_entry_amount: u128,
    pub last_cumulative_funding_rate: i128,
    pub last_cumulative_repeg_rebate: u128,
    pub last_funding_rate_ts: i64,
    pub open_orders: u128,
    pub unsettled_pnl: i128,
    pub open_bids: i128,
    pub open_asks: i128,

    // upgrade-ability
    pub padding0: u128,
    pub padding1: u128,
    pub padding2: u128,
    pub padding3: u128,
    pub padding4: u128,
}

impl MarketPosition {
    pub fn is_for(&self, market_index: u64) -> bool {
        self.market_index == market_index
            && (self.is_open_position() || self.has_open_order() || self.has_unsettled_pnl())
    }

    pub fn is_available(&self) -> bool {
        !self.is_open_position() && !self.has_open_order() && !self.has_unsettled_pnl()
    }

    pub fn is_open_position(&self) -> bool {
        self.base_asset_amount != 0
    }

    pub fn has_open_order(&self) -> bool {
        self.open_orders != 0 || self.open_bids != 0 || self.open_asks != 0
    }

    pub fn has_unsettled_pnl(&self) -> bool {
        self.unsettled_pnl != 0
    }

    pub fn worst_case_base_asset_amount(&self) -> ClearingHouseResult<i128> {
        let base_asset_amount_all_bids_fill = self
            .base_asset_amount
            .checked_add(self.open_bids)
            .ok_or_else(math_error!())?;
        let base_asset_amount_all_asks_fill = self
            .base_asset_amount
            .checked_add(self.open_asks)
            .ok_or_else(math_error!())?;

        if base_asset_amount_all_bids_fill
            .checked_abs()
            .ok_or_else(math_error!())?
            > base_asset_amount_all_asks_fill
                .checked_abs()
                .ok_or_else(math_error!())?
        {
            Ok(base_asset_amount_all_bids_fill)
        } else {
            Ok(base_asset_amount_all_asks_fill)
        }
    }
}

pub type UserPositions = [MarketPosition; 5];

#[zero_copy]
#[repr(packed)]
#[derive(AnchorSerialize, AnchorDeserialize, PartialEq, Debug)]
pub struct Order {
    pub status: OrderStatus,
    pub order_type: OrderType,
    pub ts: i64,
    pub order_id: u64,
    pub user_order_id: u8,
    pub market_index: u64,
    pub price: u128,
    pub existing_position_direction: PositionDirection,
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
    pub auction_start_price: u128,
    pub auction_end_price: u128,
    pub auction_duration: u8,
    pub padding: [u16; 3],
}

impl Order {
    pub fn has_oracle_price_offset(self) -> bool {
        self.oracle_price_offset != 0
    }

    pub fn get_limit_price(
        &self,
        valid_oracle_price: Option<i128>,
        now: i64,
    ) -> ClearingHouseResult<u128> {
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
        } else if self.order_type == OrderType::Market {
            calculate_auction_price(self, now)?
        } else {
            self.price
        };

        Ok(price)
    }

    pub fn get_base_asset_amount_unfilled(&self) -> ClearingHouseResult<u128> {
        self.base_asset_amount
            .checked_sub(self.base_asset_amount_filled)
            .ok_or_else(math_error!())
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
            existing_position_direction: PositionDirection::Long,
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
            auction_start_price: 0,
            auction_end_price: 0,
            auction_duration: 0,
            padding: [0; 3],
        }
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub enum OrderStatus {
    Init,
    Open,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub enum OrderType {
    Market,
    Limit,
    TriggerMarket,
    TriggerLimit,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub enum OrderDiscountTier {
    None,
    First,
    Second,
    Third,
    Fourth,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug)]
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
