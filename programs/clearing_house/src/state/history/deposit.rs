use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

#[account(zero_copy)]
pub struct DepositHistory {
    head: u64,
    deposit_records: [DepositRecord; 1024],
}

impl DepositHistory {
    pub fn append(&mut self, pos: DepositRecord) {
        self.deposit_records[DepositHistory::index_of(self.head)] = pos;
        self.head = (self.head + 1) % 1024;
    }

    pub fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    pub fn next_record_id(&self) -> u128 {
        let prev_trade_id = if self.head == 0 { 1023 } else { self.head - 1 };
        let prev_trade = &self.deposit_records[DepositHistory::index_of(prev_trade_id)];
        prev_trade.record_id + 1
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum DepositDirection {
    DEPOSIT,
    WITHDRAW,
}

impl Default for DepositDirection {
    // UpOnly
    fn default() -> Self {
        DepositDirection::DEPOSIT
    }
}

#[zero_copy]
#[derive(Default)]
pub struct DepositRecord {
    pub ts: i64,
    pub record_id: u128,
    pub user_authority: Pubkey,
    pub user: Pubkey,
    pub direction: DepositDirection,
    pub collateral_before: u128,
    pub cumulative_deposits_before: i128,
    pub amount: u64,
}
