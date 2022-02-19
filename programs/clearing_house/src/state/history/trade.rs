use anchor_lang::prelude::*;

use crate::PositionDirection;

#[account(zero_copy)]
pub struct TradeHistory {
    head: u64,
    trade_records: [TradeRecord; 1024],
}

impl TradeHistory {
    pub fn append(&mut self, pos: TradeRecord) {
        self.trade_records[TradeHistory::index_of(self.head)] = pos;
        self.head = (self.head + 1) % 1024;
    }

    pub fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    pub fn next_record_id(&self) -> u128 {
        let prev_trade_id = if self.head == 0 { 1023 } else { self.head - 1 };
        let prev_trade = &self.trade_records[TradeHistory::index_of(prev_trade_id)];
        prev_trade.record_id + 1
    }
}

#[zero_copy]
#[derive(Default)]
pub struct TradeRecord {
    pub ts: i64,
    pub record_id: u128,
    pub user_authority: Pubkey,
    pub user: Pubkey,
    pub direction: PositionDirection,
    pub base_asset_amount: u128,
    pub quote_asset_amount: u128,
    pub mark_price_before: u128,
    pub mark_price_after: u128,
    pub fee: u128,
    pub referrer_reward: u128,
    pub referee_discount: u128,
    pub token_discount: u128,
    pub liquidation: bool,
    pub market_index: u64,
    pub oracle_price: i128,
}
