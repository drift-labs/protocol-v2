use crate::error::DriftResult;
use crate::error::ErrorCode;
use crate::state::traits::Size;
use crate::validate;
use anchor_lang::prelude::*;

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct ProtectedMakerModeConfig {
    pub max_users: u32,
    pub current_users: u32,
    pub reduce_only: u8,
    pub padding: [u8; 31],
}

impl Size for ProtectedMakerModeConfig {
    const SIZE: usize = 48;
}

impl ProtectedMakerModeConfig {
    pub fn validate(&self) -> DriftResult {
        validate!(
            self.current_users <= self.max_users,
            ErrorCode::InvalidProtectedMakerModeConfig,
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

#[derive(Clone, Copy, Default)]
pub struct ProtectedMakerParams {
    pub limit_price_divisor: u8,
    pub dynamic_offset: u64,
    pub tick_size: u64,
}
