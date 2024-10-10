use crate::error::DriftResult;
use crate::error::ErrorCode;
use crate::state::traits::Size;
use crate::validate;
use anchor_lang::prelude::*;

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct HighLeverageModeConfig {
    pub max_users: u32,
    pub current_users: u32,
    pub reduce_only: u8,
    pub padding: [u8; 31],
}

// implement SIZE const for ProtocolIfSharesTransferConfig
impl Size for HighLeverageModeConfig {
    const SIZE: usize = 48;
}

impl HighLeverageModeConfig {
    pub fn validate(&self) -> DriftResult {
        validate!(
            self.current_users <= self.max_users,
            ErrorCode::InvalidHighLeverageModeConfig,
            "current users ({}) > max users ({})",
            self.current_users,
            self.max_users
        )?;

        Ok(())
    }

    pub fn is_reduce_only(&self) -> bool {
        self.reduce_only > 0
    }
}
