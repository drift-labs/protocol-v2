use crate::error::DriftResult;
use crate::error::ErrorCode;
use crate::math::safe_math::SafeMath;
use crate::state::traits::Size;
use crate::validate;
use anchor_lang::prelude::*;

use super::user::MarginMode;
use super::user::User;

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct HighLeverageModeConfig {
    pub max_users: u32,
    pub current_users: u32,
    pub reduce_only: u8,
    pub padding1: [u8; 3],
    pub current_maintenance_users: u32,
    pub padding2: [u8; 24],
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

    pub fn is_full(&self) -> bool {
        (self.current_users >= self.max_users) || self.is_reduce_only()
    }

    pub fn enable_high_leverage(&mut self, user: &mut User) -> DriftResult {
        if user.margin_mode == MarginMode::HighLeverage {
            return Ok(());
        }
        if user.margin_mode == MarginMode::HighLeverageMaintenance {
            self.current_maintenance_users = self.current_maintenance_users.saturating_sub(1);
        }

        user.margin_mode = MarginMode::HighLeverage;

        validate!(
            !self.is_reduce_only(),
            ErrorCode::DefaultError,
            "high leverage mode config reduce only"
        )?;

        self.current_users = self.current_users.safe_add(1)?;

        self.validate()?;

        Ok(())
    }
}
