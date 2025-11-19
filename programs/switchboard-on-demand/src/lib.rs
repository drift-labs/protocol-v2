#![allow(unexpected_cfgs)]

use anchor_lang::declare_id;
use anchor_lang::prelude::*;
use anchor_lang::program;
use anchor_lang::AnchorDeserialize;
use solana_program::pubkey::Pubkey;

#[cfg(feature = "mainnet-beta")]
declare_id!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");

#[program]
pub mod switchboard_on_demand {}
pub const SB_ON_DEMAND_PRECISION: u32 = 18;

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct CompactResult {
    pub std_dev: f32,
    pub mean: f32,
    pub slot: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct CurrentResult {
    /// The median value of the submissions needed for quorum size
    value: [u8; 16],
    /// The standard deviation of the submissions needed for quorum size
    std_dev: [u8; 16],
    /// The mean of the submissions needed for quorum size
    mean: [u8; 16],
    /// The range of the submissions needed for quorum size
    range: [u8; 16],
    /// The minimum value of the submissions needed for quorum size
    min_value: [u8; 16],
    /// The maximum value of the submissions needed for quorum size
    max_value: [u8; 16],
    /// The number of samples used to calculate this result
    num_samples: u8,
    /// The index of the submission that was used to calculate this result
    submission_idx: u8,
    padding1: [u8; 6],
    /// The slot at which this value was signed.
    slot: u64,
    /// The slot at which the first considered submission was made
    min_slot: u64,
    /// The slot at which the last considered submission was made
    max_slot: u64,
}
impl CurrentResult {
    /// The median value of the submissions needed for quorum size
    pub fn value(&self) -> Option<i128> {
        if self.slot == 0 {
            return None;
        }
        Some(i128::from_le_bytes(self.value))
    }

    /// The standard deviation of the submissions needed for quorum size
    pub fn std_dev(&self) -> Option<i128> {
        if self.slot == 0 {
            return None;
        }
        Some(i128::from_le_bytes(self.std_dev))
    }

    /// The mean of the submissions needed for quorum size
    pub fn mean(&self) -> Option<i128> {
        if self.slot == 0 {
            return None;
        }
        Some(i128::from_le_bytes(self.mean))
    }

    /// The range of the submissions needed for quorum size
    pub fn range(&self) -> Option<i128> {
        if self.slot == 0 {
            return None;
        }
        Some(i128::from_le_bytes(self.range))
    }

    /// The minimum value of the submissions needed for quorum size
    pub fn min_value(&self) -> Option<i128> {
        if self.slot == 0 {
            return None;
        }
        Some(i128::from_le_bytes(self.min_value))
    }

    /// The maximum value of the submissions needed for quorum size
    pub fn max_value(&self) -> Option<i128> {
        if self.slot == 0 {
            return None;
        }
        Some(i128::from_le_bytes(self.max_value))
    }

    pub fn result_slot(&self) -> Option<u64> {
        if self.slot == 0 {
            return None;
        }
        Some(self.slot)
    }

    pub fn min_slot(&self) -> Option<u64> {
        if self.slot == 0 {
            return None;
        }
        Some(self.min_slot)
    }

    pub fn max_slot(&self) -> Option<u64> {
        if self.slot == 0 {
            return None;
        }
        Some(self.max_slot)
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct OracleSubmission {
    /// The public key of the oracle that submitted this value.
    pub oracle: Pubkey,
    /// The slot at which this value was signed.
    pub slot: u64,
    /// The slot at which this value was landed on chain.
    pub landed_at: u64,
    /// The value that was submitted.
    value: [u8; 16],
}

impl OracleSubmission {
    pub fn is_empty(&self) -> bool {
        self.slot == 0
    }

    pub fn value(&self) -> i128 {
        i128::from_le_bytes(self.value)
    }
}

/// A representation of the data in a pull feed account.
#[repr(C)]
#[account(zero_copy)]
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
    _padding1: [u8; 2],
    pub historical_result_idx: u8,
    pub min_sample_size: u8,
    pub last_update_timestamp: i64,
    pub lut_slot: u64,
    _reserved1: [u8; 32], // deprecated
    pub result: CurrentResult,
    pub max_staleness: u32,
    _padding2: [u8; 12],
    pub historical_results: [CompactResult; 32],
    _ebuf4: [u8; 8],
    _ebuf3: [u8; 24],
    _ebuf2: [u8; 256],
}

impl PullFeedAccountData {
    pub const DISCRIMINATOR: &[u8] = &[196, 27, 108, 196, 10, 215, 219, 40];

    /// The median value of the submissions needed for quorum size
    pub fn median_value(&self) -> Option<i128> {
        self.result.value()
    }

    /// The standard deviation of the submissions needed for quorum size
    pub fn std_dev(&self) -> Option<i128> {
        self.result.std_dev()
    }

    /// The mean of the submissions needed for quorum size
    pub fn mean(&self) -> Option<i128> {
        self.result.mean()
    }

    /// The range of the submissions needed for quorum size
    pub fn range(&self) -> Option<i128> {
        self.result.range()
    }

    /// The minimum value of the submissions needed for quorum size
    pub fn min_value(&self) -> Option<i128> {
        self.result.min_value()
    }

    /// The maximum value of the submissions needed for quorum size
    pub fn max_value(&self) -> Option<i128> {
        self.result.max_value()
    }

    pub fn median_result_land_slot(&self) -> u64 {
        let submission: OracleSubmission = self.submissions[self.result.submission_idx as usize];
        submission.landed_at
    }

    pub fn latest_submissions(&self) -> Vec<OracleSubmission> {
        let max_landed_at = self
            .submissions
            .iter()
            .map(|s| s.landed_at)
            .max()
            .unwrap_or(0);
        self.submissions
            .iter()
            .filter(|submission| submission.landed_at == max_landed_at)
            .cloned()
            .collect()
    }
}
