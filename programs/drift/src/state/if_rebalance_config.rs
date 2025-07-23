use crate::error::DriftResult;
use crate::error::ErrorCode;
use crate::math::safe_math::SafeMath;
use crate::state::traits::Size;
use crate::validate;
use anchor_lang::prelude::*;

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct IfRebalanceConfig {
    pub pubkey: Pubkey,
    /// total amount to be sold
    pub total_in_amount: u64,
    /// amount already sold
    pub current_in_amount: u64,
    /// amount already bought
    pub current_out_amount: u64,
    /// amount already transferred to revenue pool
    pub current_out_amount_transferred: u64,
    /// amount already bought in epoch
    pub current_in_amount_since_last_transfer: u64,
    /// start time of epoch
    pub epoch_start_ts: i64,
    /// amount already bought in epoch
    pub epoch_in_amount: u64,
    /// max amount to swap in epoch
    pub epoch_max_in_amount: u64,
    /// duration of epoch
    pub epoch_duration: i64,
    /// market index to sell
    pub out_market_index: u16,
    /// market index to buy
    pub in_market_index: u16,
    pub max_slippage_bps: u16,
    pub swap_mode: u8,
    pub status: u8,
    pub padding2: [u8; 32],
}

// implement SIZE const for IfRebalanceConfig
impl Size for IfRebalanceConfig {
    // discriminator: 8
    // pubkey: 32
    // total_in_amount: 8
    // current_in_amount: 8
    // current_out_amount: 8
    // current_out_transferred_amount: 8
    // current_in_amount_since_last_transfer: 8
    // epoch_start_ts: 8
    // epoch_in_amount: 8
    // epoch_max_in_amount: 8
    // epoch_duration: 8
    // out_market_index: 2
    // in_market_index: 2
    // max_slippage_bps: 2
    // swap_mode: 1
    // status: 1
    // padding2: 32
    const SIZE: usize = 152;
}

impl IfRebalanceConfig {
    pub fn is_active(&self) -> bool {
        self.status == 0
    }

    pub fn validate(&self) -> DriftResult<()> {
        validate!(
            self.in_market_index == 0,
            ErrorCode::InvalidIfRebalanceConfig
        )?;

        validate!(
            self.out_market_index != self.in_market_index,
            ErrorCode::InvalidIfRebalanceConfig
        )?;

        validate!(
            self.total_in_amount >= self.current_in_amount,
            ErrorCode::InvalidIfRebalanceConfig
        )?;

        validate!(
            self.epoch_max_in_amount <= self.total_in_amount,
            ErrorCode::InvalidIfRebalanceConfig
        )?;

        Ok(())
    }

    pub fn max_transfer_amount(&self) -> DriftResult<u64> {
        self.current_out_amount
            .safe_sub(self.current_out_amount_transferred)
    }
}

#[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub struct IfRebalanceConfigParams {
    pub total_in_amount: u64,
    pub epoch_max_in_amount: u64,
    pub epoch_duration: i64,
    pub out_market_index: u16,
    pub in_market_index: u16,
    pub max_slippage_bps: u16,
    pub swap_mode: u8,
    pub status: u8,
}
