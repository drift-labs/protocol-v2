use std::cell::Ref;

// Compatibility shim for anchor-lang borsh macros
#[cfg(feature = "anchor")]
mod borsh {
    pub use anchor_lang::prelude::borsh::*;
    pub mod maybestd {
        pub mod io {
            pub use std::io::*;
        }
    }
}
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator, Owner, ZeroCopy};
use bytemuck;
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use crate::{Pubkey, get_sb_program_id, OnDemandError};


/// Default decimal precision for Switchboard oracle values
pub const PRECISION: u32 = 18;

/// Returns the Switchboard On-Demand program ID
pub fn sb_pid() -> Pubkey {
    let pid = if crate::utils::is_devnet() {
        get_sb_program_id("devnet")
    } else {
        get_sb_program_id("mainnet")
    };
    pid.to_bytes().into()
}

/// Current oracle aggregation result with statistics
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
#[cfg_attr(feature = "anchor", derive(AnchorSerialize, AnchorDeserialize))]
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
    /// The number of samples used to calculate this result
    pub num_samples: u8,
    /// The index of the submission that was used to calculate this result
    pub submission_idx: u8,
    /// Padding bytes for alignment
    pub padding1: [u8; 6],
    /// The slot at which this value was signed.
    pub slot: u64,
    /// The slot at which the first considered submission was made
    pub min_slot: u64,
    /// The slot at which the last considered submission was made
    pub max_slot: u64,
}
impl CurrentResult {
    /// Force override result values (debug builds only)
    pub fn debug_only_force_override(&mut self, value: i128, slot: u64) {
        self.value = value;
        self.slot = slot;
        self.std_dev = 0;
        self.mean = value;
        self.range = 0;
        self.min_value = value;
        self.max_value = value;
        self.num_samples = u8::MAX;
        self.submission_idx = 0;
        self.min_slot = slot;
        self.max_slot = slot;
    }

    /// The median value of the submissions needed for quorom size
    pub fn value(&self) -> Option<Decimal> {
        if self.slot == 0 {
            return None;
        }
        Some(Decimal::from_i128_with_scale(self.value, PRECISION))
    }

    /// The standard deviation of the submissions needed for quorom size
    pub fn std_dev(&self) -> Option<Decimal> {
        if self.slot == 0 {
            return None;
        }
        Some(Decimal::from_i128_with_scale(self.std_dev, PRECISION))
    }

    /// The mean of the submissions needed for quorom size
    pub fn mean(&self) -> Option<Decimal> {
        if self.slot == 0 {
            return None;
        }
        Some(Decimal::from_i128_with_scale(self.mean, PRECISION))
    }

    /// The range of the submissions needed for quorom size
    pub fn range(&self) -> Option<Decimal> {
        if self.slot == 0 {
            return None;
        }
        Some(Decimal::from_i128_with_scale(self.range, PRECISION))
    }

    /// The minimum value of the submissions needed for quorom size
    pub fn min_value(&self) -> Option<Decimal> {
        if self.slot == 0 {
            return None;
        }
        Some(Decimal::from_i128_with_scale(self.min_value, PRECISION))
    }

    /// The maximum value of the submissions needed for quorom size
    pub fn max_value(&self) -> Option<Decimal> {
        if self.slot == 0 {
            return None;
        }
        Some(Decimal::from_i128_with_scale(self.max_value, PRECISION))
    }

    /// Returns the slot when this result was recorded
    pub fn result_slot(&self) -> Option<u64> {
        if self.slot == 0 {
            return None;
        }
        Some(self.slot)
    }

    /// Returns the minimum slot of submissions used in this result
    pub fn min_slot(&self) -> Option<u64> {
        if self.slot == 0 {
            return None;
        }
        Some(self.min_slot)
    }

    /// Returns the maximum slot of submissions used in this result
    pub fn max_slot(&self) -> Option<u64> {
        if self.slot == 0 {
            return None;
        }
        Some(self.max_slot)
    }
}

/// Individual oracle submission data
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
#[cfg_attr(feature = "anchor", derive(AnchorSerialize, AnchorDeserialize))]
pub struct OracleSubmission {
    /// The public key of the oracle that submitted this value.
    pub oracle: Pubkey,
    /// The slot at which this value was signed.
    pub slot: u64,
    /// The slot at which this value was landed on chain.
    pub landed_at: u64,
    /// The value that was submitted.
    pub value: i128,
}

/// Compact historical oracle result for storage efficiency
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
#[cfg_attr(feature = "anchor", derive(AnchorSerialize, AnchorDeserialize))]
pub struct CompactResult {
    /// The standard deviation of the submissions needed for quorom size
    pub std_dev: f32,
    /// The mean of the submissions needed for quorom size
    pub mean: f32,
    /// The slot at which this value was signed.
    pub slot: u64,
}

/// A representation of the data in a pull feed account.
#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
#[cfg_attr(feature = "anchor", derive(AnchorSerialize, AnchorDeserialize))]
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
    /// Permission flags for feed operations
    pub permissions: u64,
    /// Maximum allowed variance between oracle submissions
    pub max_variance: u64,
    /// Minimum number of oracle responses required
    pub min_responses: u32,
    /// Human-readable name for this feed
    pub name: [u8; 32],
    padding1: [u8; 2],
    /// Index for the next historical result entry
    pub historical_result_idx: u8,
    /// Minimum number of samples required for a valid result
    pub min_sample_size: u8,
    /// Unix timestamp of the last feed update
    pub last_update_timestamp: i64,
    /// Slot number for address lookup table
    pub lut_slot: u64,
    _reserved1: [u8; 32],
    /// Current aggregated result from oracle submissions
    pub result: CurrentResult,
    /// Maximum age in slots before data is considered stale
    pub max_staleness: u32,
    padding2: [u8; 12],
    /// Array of historical oracle results
    pub historical_results: [CompactResult; 32],
    _ebuf4: [u8; 8],
    _ebuf3: [u8; 24],
    /// Timestamps of oracle submissions
    pub submission_timestamps: [i64; 32],
}

impl OracleSubmission {
    /// Returns true if this submission is empty (uninitialized)
    pub fn is_empty(&self) -> bool {
        self.slot == 0
    }

    /// Returns the submitted value as a Decimal with standard precision
    pub fn value(&self) -> Decimal {
        Decimal::from_i128_with_scale(self.value, PRECISION)
    }
}

impl PullFeedAccountData {
    /// Returns true if the value in the current result is within
    /// staleness threshold
    pub fn is_result_vaild(&self, clock_slot: u64) -> bool {
        self.result.slot >= clock_slot - self.max_staleness as u64
    }

    /// Returns the oracle submission that was used for the current result
    pub fn result_submission(&self) -> &OracleSubmission {
        &self.submissions[self.result.submission_idx as usize]
    }

    /// Returns the timestamp of the submission used for current result
    pub fn result_ts(&self) -> i64 {
        let idx = self.result.submission_idx as usize;
        self.submission_timestamps[idx]
    }

    /// Returns the slot when the current result submission landed on-chain
    pub fn result_land_slot(&self) -> u64 {
        let submission = self.submissions[self.result.submission_idx as usize];
        submission.landed_at
    }

    /// Parses pull feed account data from raw bytes
    pub fn parse<'info>(data: Ref<'info, &mut [u8]>) -> Result<Ref<'info, Self>, OnDemandError> {
        if data.len() < Self::DISCRIMINATOR.len() {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        let mut disc_bytes = [0u8; 8];
        disc_bytes.copy_from_slice(&data[..8]);
        if disc_bytes != Self::DISCRIMINATOR {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        // Check size before attempting to parse
        let expected_size = std::mem::size_of::<Self>() + 8;
        if data.len() < expected_size {
            return Err(OnDemandError::InvalidData);
        }

        // Validate the slice can be safely cast before using from_bytes
        let slice_to_parse = &data[8..expected_size];
        if slice_to_parse.len() != std::mem::size_of::<Self>() {
            return Err(OnDemandError::InvalidData);
        }

        // Check alignment requirements for bytemuck
        match bytemuck::try_from_bytes::<Self>(slice_to_parse) {
            Ok(_) => {
                // If try_from_bytes succeeds, we know from_bytes will also succeed
                Ok(Ref::map(data, |data: &&mut [u8]| {
                    bytemuck::from_bytes(&data[8..std::mem::size_of::<Self>() + 8])
                }))
            }
            Err(_) => Err(OnDemandError::AccountDeserializeError),
        }
    }

    /// Generate a checksum for the given feed hash, result, slothash, max_variance and min_responses
    /// This is signed by the oracle and used to verify that the data submitted by the oracles is valid.
    pub fn generate_checksum(&self, result: i128, slothash: [u8; 32]) -> [u8; 32] {
        Self::generate_checksum_inner(
            self.queue,
            self.feed_hash,
            result,
            slothash,
            self.max_variance,
            self.min_responses,
        )
    }

    /// Generate a checksum for the given feed hash, result, slothash, max_variance and min_responses
    /// This is signed by the oracle and used to verify that the data submitted by the oracles is valid.
    pub fn generate_checksum_inner(
        queue: Pubkey,
        feed_hash: [u8; 32],
        result: i128,
        slothash: [u8; 32],
        max_variance: u64,
        min_responses: u32,
    ) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(queue.to_bytes());
        hasher.update(feed_hash);
        hasher.update(result.to_le_bytes());
        hasher.update(slothash);
        hasher.update(max_variance.to_le_bytes());
        hasher.update(min_responses.to_le_bytes());
        hasher.finalize().to_vec().try_into().unwrap()
    }

    /// Generate a checksum for the given feed hash, result, slothash, max_variance and min_responses
    /// This is signed by the oracle and used to verify that the data submitted by the oracles is valid.
    pub fn generate_checksum_with_timestamp(
        queue: Pubkey,
        feed_hash: [u8; 32],
        result: i128,
        slothash: [u8; 32],
        max_variance: u64,
        min_responses: u32,
        timestamp: u64,
    ) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(queue.to_bytes());
        hasher.update(feed_hash);
        hasher.update(result.to_le_bytes());
        hasher.update(slothash);
        hasher.update(max_variance.to_le_bytes());
        hasher.update(min_responses.to_le_bytes());
        hasher.update(timestamp.to_le_bytes());
        hasher.finalize().to_vec().try_into().unwrap()
    }

    /// **method**
    /// get_value
    /// Returns the median value of the submissions in the last `max_staleness` slots.
    /// If there are fewer than `min_samples` submissions, returns an error.
    /// **arguments**
    /// * `clock` - the clock to use for the current slot
    /// * `max_staleness` - the maximum number of slots to consider
    /// * `min_samples` - the minimum number of samples required to return a value
    ///   **returns**
    /// * `Ok(Decimal)` - the median value of the submissions in the last `max_staleness` slots
    pub fn get_value(
        &self,
        clock_slot: u64,
        max_staleness: u64,
        min_samples: u32,
        only_positive: bool,
    ) -> Result<Decimal, OnDemandError> {
        let submissions = self
            .submissions
            .iter()
            .take_while(|s| !s.is_empty())
            .filter(|s| s.slot >= clock_slot - max_staleness)
            .collect::<Vec<_>>();
        if submissions.len() < min_samples as usize {
            return Err(OnDemandError::NotEnoughSamples);
        }
        let median =
            lower_bound_median(&mut submissions.iter().map(|s| s.value).collect::<Vec<_>>())
                .ok_or(OnDemandError::NotEnoughSamples)?;
        if only_positive && median <= 0 {
            return Err(OnDemandError::IllegalFeedValue);
        }

        Ok(Decimal::from_i128_with_scale(median, PRECISION))
    }

    /// List of samples that are valid for the current slot
    pub fn valid_samples(&self, clock_slot: u64) -> Vec<&OracleSubmission> {
        self.submissions
            .iter()
            .take_while(|s| !s.is_empty())
            .filter(|s| s.slot >= clock_slot - self.max_staleness as u64)
            .collect()
    }

    /// Gets all the samples used in the current result
    pub fn current_result_samples(&self) -> Vec<(usize, &OracleSubmission)> {
        let last_update_slot = self.last_update_slot();
        let slot_threshold = last_update_slot - self.max_staleness as u64;
        self.submissions
            .iter()
            .enumerate()
            .take_while(|(_, s)| !s.is_empty())
            .filter(|(_, s)| s.slot >= slot_threshold)
            .collect()
    }

    /// Gets the minimum timestamp of the submissions used in the current result
    pub fn current_result_ts_range(&self) -> (i64, i64) {
        let samples = self.current_result_samples();
        let timestamps = samples
            .iter()
            .map(|(idx, _)| self.submission_timestamps[*idx])
            .collect::<Vec<_>>();
        let min_ts = *timestamps.iter().min().unwrap_or(&0);
        let max_ts = *timestamps.iter().max().unwrap_or(&0);
        (min_ts, max_ts)
    }

    /// Returns the slot of the most recent submission
    pub fn last_update_slot(&self) -> u64 {
        self.submissions
            .iter()
            .map(|s| s.landed_at)
            .max()
            .unwrap_or(0)
    }

    /// The median value of the submissions needed for quorom size
    /// Fails if the result is not valid or stale.
    pub fn value(&self, clock_slot: u64) -> Result<Decimal, OnDemandError> {
        if self.result.result_slot().unwrap_or(0) < clock_slot - self.max_staleness as u64 {
            return Err(OnDemandError::StaleResult);
        }
        self.result.value().ok_or(OnDemandError::StaleResult)
    }

    /// The standard deviation of the submissions needed for quorom size
    pub fn std_dev(&self) -> Option<Decimal> {
        self.result.std_dev()
    }

    /// The mean of the submissions needed for quorom size
    pub fn mean(&self) -> Option<Decimal> {
        self.result.mean()
    }

    /// The range of the submissions needed for quorom size
    pub fn range(&self) -> Option<Decimal> {
        self.result.range()
    }

    /// The minimum value of the submissions needed for quorom size
    pub fn min_value(&self) -> Option<Decimal> {
        self.result.min_value()
    }

    /// The maximum value of the submissions needed for quorom size
    pub fn max_value(&self) -> Option<Decimal> {
        self.result.max_value()
    }
}

impl ZeroCopy for PullFeedAccountData {}
impl Owner for PullFeedAccountData {
    fn owner() -> Pubkey {
        sb_pid().to_bytes().into()
    }
}
impl Discriminator for PullFeedAccountData {
    const DISCRIMINATOR: [u8; 8] = [196, 27, 108, 196, 10, 215, 219, 40];
}

/// Type alias for PullFeedAccountData for backward compatibility
pub type SbFeed = PullFeedAccountData;

// takes the rounded down median of a list of numbers
/// Calculates the lower bound median of oracle submission values
pub fn lower_bound_median(numbers: &mut [i128]) -> Option<i128> {
    numbers.sort(); // Sort the numbers in ascending order.

    let len = numbers.len();
    if len == 0 {
        return None; // Return None for an empty list.
    }
    Some(numbers[len / 2])
}
