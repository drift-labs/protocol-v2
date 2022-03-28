use crate::state::user_orders::Order;
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

#[account(zero_copy)]
pub struct OrderHistory {
    head: u64,
    pub last_order_id: u128,
    order_records: [OrderRecord; 1024],
}

impl OrderHistory {
    pub fn append(&mut self, record: OrderRecord) {
        self.order_records[OrderHistory::index_of(self.head)] = record;
        self.head = (self.head + 1) % 1024;
    }

    pub fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    pub fn next_record_id(&self) -> u128 {
        let prev_record_id = if self.head == 0 { 1023 } else { self.head - 1 };
        let prev_record = &self.order_records[OrderHistory::index_of(prev_record_id)];
        prev_record.record_id + 1
    }

    pub fn next_order_id(&mut self) -> u128 {
        let next_order_id = self.last_order_id + 1;
        self.last_order_id = next_order_id;
        next_order_id
    }
}

#[zero_copy]
#[derive(Default)]
pub struct OrderRecord {
    pub ts: i64,
    pub record_id: u128,
    pub user: Pubkey,
    pub authority: Pubkey,
    pub order: Order,
    pub action: OrderAction,
    pub filler: Pubkey,
    pub trade_record_id: u128,
    pub base_asset_amount_filled: u128,
    pub quote_asset_amount_filled: u128,
    pub fee: u128,
    pub filler_reward: u128,
    pub quote_asset_amount_surplus: u128,
    pub padding: [u64; 8],
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum OrderAction {
    Place,
    Cancel,
    Fill,
    Expire,
}

impl Default for OrderAction {
    // UpOnly
    fn default() -> Self {
        OrderAction::Place
    }
}
