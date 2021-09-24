use anchor_lang::prelude::*;

use crate::PositionDirection;

#[account(zero_copy)]
pub struct TradeHistoryAccount {
    head: u64,
    trade_records: [TradeRecord; 1000],
}

impl Default for TradeHistoryAccount {
    fn default() -> Self {
        return TradeHistoryAccount {
            head: 0,
            trade_records: [TradeRecord::default(); 1000],
        };
    }
}

impl TradeHistoryAccount {
    pub fn append(&mut self, pos: TradeRecord) {
        self.trade_records[TradeHistoryAccount::index_of(self.head)] = pos;
        self.head = (self.head + 1) % 1000;
    }

    pub fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    pub fn next_record_id(&self) -> u128 {
        let prev_trade_id = if self.head == 0 { 999 } else { self.head - 1 };
        let prev_trade = &self.trade_records[TradeHistoryAccount::index_of(prev_trade_id)];
        return prev_trade.record_id + 1;
    }
}

#[zero_copy]
#[derive(Default)]
pub struct TradeRecord {
    pub ts: i64,
    pub record_id: u128,
    pub user_public_key: Pubkey,
    pub user_clearing_house_public_key: Pubkey,
    pub direction: PositionDirection,
    pub base_asset_amount: u128,
    pub quote_asset_notional_amount: u128,
    pub base_asset_price_with_mantissa_before: u128,
    pub base_asset_price_with_mantissa_after: u128,
    pub market_index: u64,
}

#[account(zero_copy)]
pub struct FundingRateHistory {
    head: u64,
    funding_rate_records: [FundingRateRecord; 1000],
}

impl Default for FundingRateHistory {
    fn default() -> Self {
        return FundingRateHistory {
            head: 0,
            funding_rate_records: [FundingRateRecord::default(); 1000],
        };
    }
}

impl FundingRateHistory {
    pub fn append(&mut self, pos: FundingRateRecord) {
        self.funding_rate_records[FundingRateHistory::index_of(self.head)] = pos;
        self.head = (self.head + 1) % 1000;
    }

    pub fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    pub fn next_record_id(&self) -> u128 {
        let prev_record_id = if self.head == 0 { 999 } else { self.head - 1 };
        let prev_record = &self.funding_rate_records[FundingRateHistory::index_of(prev_record_id)];
        return prev_record.record_id + 1;
    }
}

#[zero_copy]
#[derive(Default)]
pub struct FundingRateRecord {
    pub ts: i64,
    pub record_id: u128,
    pub user_public_key: Pubkey,
    pub user_clearing_house_public_key: Pubkey,
    pub market_index: u64,
    pub funding_rate_payment: i128,
    pub base_asset_amount: i128,
    pub user_last_cumulative_funding: i128,
    pub amm_cumulative_funding: i128,
}
