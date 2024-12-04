use anchor_lang::declare_id;
use anchor_lang::prelude::*;
use solana_program::pubkey;

declare_id!("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");

pub const PYTH_LAZER_ORACLE_SEED: &[u8] = b"pyth-lazer";
pub const PYTH_LAZER_STORAGE_ID: Pubkey = pubkey!("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");

#[program]
pub mod pyth_lazer {}
pub trait Size {
    const SIZE: usize;
}

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
    pub conf: u64,
    pub padding: [u8; 4],
}
