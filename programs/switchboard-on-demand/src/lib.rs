use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use solana_program::clock::Clock;
use solana_program::pubkey::Pubkey;
use std::cell::{Ref, RefMut};
use anchor_lang::Discriminator;
use anchor_lang::program;
use anchor_lang::AnchorDeserialize;
use anchor_lang::declare_id;
use anchor_lang::prelude::*;
use std::result::Result;

declare_id!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");

#[program]
pub mod switchboard_on_demand {}

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
    padding1: [u8; 4],
    pub _ebuf: [u8; 1024],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct OracleSubmission {
    /// The public key of the oracle that submitted this value.
    pub oracle: Pubkey,
    /// The slot at which this value was signed.
    pub slot: u64,
    padding: [u8; 8],
    /// The value that was submitted.
    pub value: i128,
}
impl OracleSubmission {
    pub fn is_empty(&self) -> bool {
        self.slot == 0
    }
}
impl PullFeedAccountData {
    pub fn parse<'info>(
        data: Ref<'info, &mut [u8]>,
    ) -> Result<Ref<'info, Self>, OnDemandError> {
        if data.len() < Self::discriminator().len() {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        let mut disc_bytes = [0u8; 8];
        disc_bytes.copy_from_slice(&data[..8]);
        if disc_bytes != Self::discriminator() {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        Ok(Ref::map(data, |data: &&mut [u8]| {
            bytemuck::from_bytes(&data[8..std::mem::size_of::<Self>() + 8])
        }))
    }

    pub fn parse_mut<'info>(
        data: RefMut<'info, &mut [u8]>,
    ) -> Result<RefMut<'info, Self>, OnDemandError> {
        if data.len() < Self::discriminator().len() {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        let mut disc_bytes = [0u8; 8];
        disc_bytes.copy_from_slice(&data[..8]);
        if disc_bytes != Self::discriminator() {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        Ok(RefMut::map(data, |data: &mut &mut [u8]| {
            bytemuck::from_bytes_mut(&mut data[8..std::mem::size_of::<Self>() + 8])
        }))
    }

    /// # method
    /// get_value
    /// Returns the median value of the submissions in the last `max_staleness` slots.
    /// If there are fewer than `min_samples` submissions, returns an error.
    /// # arguments
    /// * `clock` - the clock to use for the current slot
    /// * `max_staleness` - the maximum number of slots to consider
    /// * `min_samples` - the minimum number of samples required to return a value
    /// * `only_positive` - if true, only positive values are considered
    /// # returns
    /// * ``Result<Decimal>`` - the median value of the submissions in the last `max_staleness` slots
    pub fn get_value(
        &self,
        clock: u64,
        max_staleness: u64,
        min_samples: u32,
        only_positive: bool,
    ) -> Result<Decimal, OnDemandError> {
        let submissions = self
            .submissions
            .iter()
            .take_while(|s| !s.is_empty())
            .filter(|s| s.slot > clock - max_staleness)
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

        return Ok(Decimal::from_i128_with_scale(median, 18));
    }
}

// takes the rounded down median of a list of numbers
fn lower_bound_median(numbers: &mut Vec<i128>) -> Option<i128> {
    numbers.sort();

    let len = numbers.len();
    if len == 0 {
        return None;
    }
    Some(numbers[len / 2])
}

pub enum OnDemandError {
    InvalidDiscriminator,
    NotEnoughSamples,
    IllegalFeedValue,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::prelude::{AccountLoader, Pubkey};
    use std::str::FromStr;

    fn create_account_info<'a>(
        key: &'a Pubkey,
        is_writable: bool,
        lamports: &'a mut u64,
        bytes: &'a mut [u8],
        owner: &'a Pubkey,
    ) -> AccountInfo<'a> {
        AccountInfo::new(key, false, is_writable, lamports, bytes, owner, false, 0)
    }

    #[test]
    fn load() {
        let aggregator_str = String::from("<TODO: sample from on-chain>");
        let mut decoded_bytes = base64::decode(aggregator_str).unwrap();
        let aggregator_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv").unwrap();
        let mut lamports = 0;
        let account_info = create_account_info(&key, true, &mut lamports, aggregator_bytes, &owner);

        let account_loader: AccountLoader<AggregatorAccountData> =
            AccountLoader::try_from(&account_info).unwrap();

        let aggregator = account_loader.load().unwrap();
        let price = &aggregator.latest_confirmed_round.result;
        println!("price {:?}", price);
    }
}
