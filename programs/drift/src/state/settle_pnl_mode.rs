use crate::error::{DriftResult, ErrorCode};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;
use std::panic::Location;

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum SettlePnlMode {
    MustSettle,
    TrySettle,
}

impl SettlePnlMode {
    #[track_caller]
    #[inline(always)]
    pub fn result(self, error_code: ErrorCode, msg: &str) -> DriftResult {
        let caller = Location::caller();
        msg!(msg);
        msg!(
            "Error {:?} at {}:{}",
            error_code,
            caller.file(),
            caller.line()
        );
        match self {
            SettlePnlMode::MustSettle => {
                return Err(error_code);
            }
            SettlePnlMode::TrySettle => {
                return Ok(());
            }
        }
    }
}
