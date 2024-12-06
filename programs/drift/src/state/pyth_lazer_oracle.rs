use crate::state::traits::Size;
use anchor_lang::prelude::*;
use solana_program::pubkey;

pub const PYTH_LAZER_ORACLE_SEED: &[u8] = b"pyth_lazer";
pub const PYTH_LAZER_STORAGE_ID: Pubkey = pubkey!("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");

impl Size for PythLazerOracle {
    const SIZE: usize = 48;
}

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct PythLazerOracle {
    pub price: i64,
    pub publish_time: u64,
    pub posted_slot: u64,
    pub exponent: i32,
    pub _padding: [u8; 4],
    pub conf: u64,
}
