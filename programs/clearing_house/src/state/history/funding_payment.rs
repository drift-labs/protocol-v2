use anchor_lang::prelude::*;

#[account(zero_copy)]
pub struct FundingPaymentHistory {
    head: u64,
    funding_payment_records: [FundingPaymentRecord; 1024],
}

impl FundingPaymentHistory {
    pub fn append(&mut self, pos: FundingPaymentRecord) {
        self.funding_payment_records[FundingPaymentHistory::index_of(self.head)] = pos;
        self.head = (self.head + 1) % 1024;
    }

    pub fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    pub fn next_record_id(&self) -> u128 {
        let prev_record_id = if self.head == 0 { 1023 } else { self.head - 1 };
        let prev_record =
            &self.funding_payment_records[FundingPaymentHistory::index_of(prev_record_id)];
        prev_record.record_id + 1
    }
}

// FundingPaymentRecord
#[zero_copy]
#[derive(Default)]
pub struct FundingPaymentRecord {
    pub ts: i64,
    pub record_id: u128,
    pub user_authority: Pubkey,
    pub user: Pubkey,
    pub market_index: u64,
    pub funding_payment: i128,
    pub base_asset_amount: i128,
    pub user_last_cumulative_funding: i128,
    pub user_last_funding_rate_ts: i64,
    pub amm_cumulative_funding_long: i128,
    pub amm_cumulative_funding_short: i128,
}
