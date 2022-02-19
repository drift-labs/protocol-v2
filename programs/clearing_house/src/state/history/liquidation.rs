use anchor_lang::prelude::*;

#[account(zero_copy)]
pub struct LiquidationHistory {
    head: u64,
    liquidation_records: [LiquidationRecord; 1024],
}

impl LiquidationHistory {
    pub fn append(&mut self, pos: LiquidationRecord) {
        self.liquidation_records[LiquidationHistory::index_of(self.head)] = pos;
        self.head = (self.head + 1) % 1024;
    }

    pub fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    pub fn next_record_id(&self) -> u128 {
        let prev_record_id = if self.head == 0 { 1023 } else { self.head - 1 };
        let prev_record = &self.liquidation_records[LiquidationHistory::index_of(prev_record_id)];
        prev_record.record_id + 1
    }
}

#[zero_copy]
#[derive(Default)]
pub struct LiquidationRecord {
    pub ts: i64,
    pub record_id: u128,
    pub user_authority: Pubkey,
    pub user: Pubkey,
    pub partial: bool,
    pub base_asset_value: u128,
    pub base_asset_value_closed: u128,
    pub liquidation_fee: u128,
    pub fee_to_liquidator: u64,
    pub fee_to_insurance_fund: u64,
    pub liquidator: Pubkey,
    pub total_collateral: u128,
    pub collateral: u128,
    pub unrealized_pnl: i128,
    pub margin_ratio: u128,
}
