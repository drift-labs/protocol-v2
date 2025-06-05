use crate::error::DriftResult;
use crate::error::ErrorCode;
use crate::state::traits::Size;
use crate::validate;
use anchor_lang::prelude::*;

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct IfRebalanceConfig {
    pub name: [u8; 32],
    /// total amount to be sold
    pub total_in_amount: u64,
    /// amount already sold
    pub current_in_amount: u64,
    /// amount already bought
    pub current_out_amount: u64,
    /// start time of the rebalance
    pub start_ts: i64,
    /// end time of the rebalance
    pub end_ts: i64,
    /// last swap time
    pub last_swap_ts: i64,
    /// amount to swap
    pub swap_amount: u64,
    /// frequency of swaps
    pub swap_frequency: i64,
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
    const SIZE: usize = 32;
}

impl IfRebalanceConfig {
    pub fn is_active(&self) -> bool {
        self.status == 0
    }

    pub fn validate(&self) -> DriftResult<()> {
        validate!(self.start_ts < self.end_ts, ErrorCode::InvalidIfRebalanceConfig)?;

        validate!(self.in_market_index == 0, ErrorCode::InvalidIfRebalanceConfig)?;

        validate!(self.out_market_index != self.in_market_index, ErrorCode::InvalidIfRebalanceConfig)?;
        
        validate!(self.total_in_amount >= self.current_in_amount, ErrorCode::InvalidIfRebalanceConfig)?;

        validate!(self.swap_amount < self.total_in_amount, ErrorCode::InvalidIfRebalanceConfig)?;

        Ok(())
    }
}

#[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub struct IfRebalanceConfigParams {
    pub name: [u8; 32],
    pub total_in_amount: u64,
    pub end_ts: i64,
    pub swap_amount: u64,
    pub swap_frequency: i64,
    pub out_market_index: u16,
    pub in_market_index: u16,
    pub max_slippage_bps: u16,
    pub swap_mode: u8,
    pub status: u8,
}