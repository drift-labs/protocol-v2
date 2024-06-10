use crate::error::{DriftResult, ErrorCode};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;
use std::panic::Location;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum SettlePnlMode {
    MustSettle,
    TrySettle,
}

impl SettlePnlMode {
    #[track_caller]
    #[inline(always)]
    pub fn result(self, error_code: ErrorCode, market_index: u16, msg: &str) -> DriftResult {
        let caller = Location::caller();
        msg!(msg);
        msg!(
            "Error {:?} for market {} at {}:{}",
            error_code,
            market_index,
            caller.file(),
            caller.line()
        );
        match self {
            SettlePnlMode::MustSettle => Err(error_code),
            SettlePnlMode::TrySettle => Ok(()),
        }
    }
}
