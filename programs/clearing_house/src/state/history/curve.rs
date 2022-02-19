use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

#[account(zero_copy)]
#[derive(Default)]
pub struct CurveHistory {
    pub head: u64,
    pub curve_records: [CurveRecord; 32],
}

impl CurveHistory {
    pub fn append(&mut self, pos: CurveRecord) {
        self.curve_records[CurveHistory::index_of(self.head)] = pos;
        self.head = (self.head + 1) % 32;
    }

    pub fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    pub fn next_record_id(&self) -> u128 {
        let prev_record_id = if self.head == 0 { 31 } else { self.head - 1 };
        let prev_record = &self.curve_records[CurveHistory::index_of(prev_record_id)];
        prev_record.record_id + 1
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum Type {
    Repeg,
    UpdateK,
}

impl Default for Type {
    // UpOnly
    fn default() -> Self {
        Type::Repeg
    }
}

#[zero_copy]
#[derive(Default)]
pub struct CurveRecord {
    pub ts: i64,
    pub record_id: u128,
    pub market_index: u64,
    pub peg_multiplier_before: u128,
    pub base_asset_reserve_before: u128,
    pub quote_asset_reserve_before: u128,
    pub sqrt_k_before: u128,
    pub peg_multiplier_after: u128,
    pub base_asset_reserve_after: u128,
    pub quote_asset_reserve_after: u128,
    pub sqrt_k_after: u128,
    pub base_asset_amount_long: u128,
    pub base_asset_amount_short: u128,
    pub base_asset_amount: i128,
    pub open_interest: u128,
    pub total_fee: u128,
    pub total_fee_minus_distributions: u128,
    pub adjustment_cost: i128,
}

#[account(zero_copy)]
pub struct ExtendedCurveHistory {
    pub head: u64,
    curve_records: [ExtendedCurveRecord; 1024],
}

impl ExtendedCurveHistory {
    pub fn append(&mut self, pos: ExtendedCurveRecord) {
        self.curve_records[ExtendedCurveHistory::index_of(self.head)] = pos;
        self.head = (self.head + 1) % 1023;
    }

    pub fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    pub fn next_record_id(&self) -> u128 {
        let prev_record_id = if self.head == 0 { 1023 } else { self.head - 1 };
        let prev_record = &self.curve_records[ExtendedCurveHistory::index_of(prev_record_id)];
        prev_record.record_id + 1
    }
}

#[zero_copy]
#[derive(Default)]
pub struct ExtendedCurveRecord {
    pub ts: i64,
    pub record_id: u128,
    pub market_index: u64,
    pub peg_multiplier_before: u128,
    pub base_asset_reserve_before: u128,
    pub quote_asset_reserve_before: u128,
    pub sqrt_k_before: u128,
    pub peg_multiplier_after: u128,
    pub base_asset_reserve_after: u128,
    pub quote_asset_reserve_after: u128,
    pub sqrt_k_after: u128,
    pub base_asset_amount_long: u128,
    pub base_asset_amount_short: u128,
    pub base_asset_amount: i128,
    pub open_interest: u128,
    pub total_fee: u128,
    pub total_fee_minus_distributions: u128,
    pub adjustment_cost: i128,
    pub oracle_price: i128,
    pub trade_record: u128,
    pub padding: [u128; 5],
}
