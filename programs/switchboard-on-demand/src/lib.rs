use anchor_lang::declare_id;
use anchor_lang::prelude::*;
use anchor_lang::program;
use anchor_lang::AnchorDeserialize;
use solana_program::pubkey::Pubkey;

declare_id!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");

#[program]
pub mod switchboard_on_demand {}

pub const PRECISION: u32 = 18;

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct CurrentResult {
    /// The median value of the submissions needed for quorom size
    pub value: i128,
    /// The standard deviation of the submissions needed for quorom size
    pub std_dev: i128,
    /// The mean of the submissions needed for quorom size
    pub mean: i128,
    /// The range of the submissions needed for quorom size
    pub range: i128,
    /// The minimum value of the submissions needed for quorom size
    pub min_value: i128,
    /// The maximum value of the submissions needed for quorom size
    pub max_value: i128,
    pub padding1: [u8; 8],
    /// The slot at which this value was signed.
    pub slot: u64,
    /// The slot at which the first considered submission was made
    pub min_slot: u64,
    /// The slot at which the last considered submission was made
    pub max_slot: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct OracleSubmission {
    /// The public key of the oracle that submitted this value.
    pub oracle: Pubkey,
    /// The slot at which this value was signed.
    pub slot: u64,
    padding1: [u8; 8],
    /// The value that was submitted.
    pub value: i128,
}

impl OracleSubmission {
    pub fn is_empty(&self) -> bool {
        self.slot == 0
    }
}

/// A representation of the data in a pull feed account.
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct PullFeedAccountData {
    /// The oracle submissions for this feed.
    pub submissions: [OracleSubmission; 32],
    /// The public key of the authority that can update the feed hash that
    /// this account will use for registering updates.
    pub authority: Pubkey,
    /// The public key of the queue which oracles must be bound to in order to
    /// submit data to this feed.
    pub queue: Pubkey,
    /// SHA-256 hash of the job schema oracles will execute to produce data
    /// for this feed.
    pub feed_hash: [u8; 32],
    /// The slot at which this account was initialized.
    pub initialized_at: i64,
    pub permissions: u64,
    pub max_variance: u64,
    pub min_responses: u32,
    pub name: [u8; 32],
    _padding1: [u8; 3],
    pub sample_size: u8,
    pub last_update_timestamp: i64,
    pub lut_slot: u64,
    pub ipfs_hash: [u8; 32], // deprecated
    pub result: CurrentResult,
    pub max_staleness: u32,
    _ebuf4: [u8; 20],
    _ebuf3: [u8; 24],
    _ebuf2: [u8; 256],
    _ebuf1: [u8; 512],
}
