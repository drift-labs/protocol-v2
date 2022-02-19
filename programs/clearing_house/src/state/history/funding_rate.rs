use anchor_lang::prelude::*;

#[account(zero_copy)]
pub struct FundingRateHistory {
    head: u64,
    funding_rate_records: [FundingRateRecord; 1024],
}

impl FundingRateHistory {
    pub fn append(&mut self, pos: FundingRateRecord) {
        self.funding_rate_records[FundingRateHistory::index_of(self.head)] = pos;
        self.head = (self.head + 1) % 1024;
    }

    pub fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    pub fn next_record_id(&self) -> u128 {
        let prev_record_id = if self.head == 0 { 1023 } else { self.head - 1 };
        let prev_record = &self.funding_rate_records[FundingRateHistory::index_of(prev_record_id)];
        prev_record.record_id + 1
    }
}

#[zero_copy]
#[derive(Default)]
pub struct FundingRateRecord {
    pub ts: i64,
    pub record_id: u128,
    pub market_index: u64,
    pub funding_rate: i128,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub oracle_price_twap: i128,
    pub mark_price_twap: u128,
}
