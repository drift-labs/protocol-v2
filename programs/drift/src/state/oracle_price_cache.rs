use anchor_lang::prelude::*;
use std::convert::TryFrom;

use crate::error::{DriftResult, ErrorCode};
use crate::impl_zero_copy_loader;
use crate::state::oracle::{OraclePriceData, OracleSource};
use crate::state::oracle_map::OracleIdentifier;
use crate::state::zero_copy::HasLen;

pub const ORACLE_PRICE_CACHE_SEED: &[u8] = b"oracle_price_cache";

/// Default freshness threshold in slots (~30s at 400ms/slot).
pub const DEFAULT_CACHE_MAX_AGE_SLOTS: u64 = 60;

#[account]
#[derive(Debug)]
#[repr(C)]
pub struct OraclePriceCache {
    pub bump: u8,
    /// Freshness threshold in slots; 0 = use DEFAULT_CACHE_MAX_AGE_SLOTS.
    pub max_age_slots: u8,
    /// Shard id (0 for v1).
    pub cache_id: u8,
    /// 0 or 1 for double-buffer.
    pub buffer_index: u8,
    pub entries: Vec<CachedOracleEntry>,
}

#[zero_copy]
#[derive(Debug)]
#[repr(C)]
pub struct OraclePriceCacheFixed {
    pub bump: u8,
    pub max_age_slots: u8,
    pub cache_id: u8,
    pub buffer_index: u8,
    pub len: u32,
}

impl Default for OraclePriceCacheFixed {
    fn default() -> Self {
        Self {
            bump: 0,
            max_age_slots: 0,
            cache_id: 0,
            buffer_index: 0,
            len: 0,
        }
    }
}

impl HasLen for OraclePriceCacheFixed {
    fn len(&self) -> u32 {
        self.len
    }
}

#[zero_copy]
#[derive(AnchorSerialize, AnchorDeserialize, Debug)]
#[repr(C)]
pub struct CachedOracleEntry {
    /// Oracle account pubkey.
    pub oracle: Pubkey,
    /// PRICE_PRECISION.
    pub price: i64,
    pub confidence: u64,
    /// Oracle delay (slots) at cache write time.
    pub delay: i64,
    /// Clock.slot when entry was written.
    pub cached_slot: u64,
    /// `OracleSource` discriminant.
    pub oracle_source: u8,
    /// 1 if oracle had sufficient data points when cached, 0 otherwise.
    pub has_sufficient_data_points: u8,
    /// Per-entry freshness override (0 = use cache-level default).
    pub max_age_slots_override: u8,
    pub _padding: [u8; 29],
}

impl Default for CachedOracleEntry {
    fn default() -> Self {
        Self {
            oracle: Pubkey::default(),
            price: 0,
            confidence: 0,
            delay: 0,
            cached_slot: 0,
            oracle_source: 0,
            has_sufficient_data_points: 0,
            max_age_slots_override: 0,
            _padding: [0u8; 29],
        }
    }
}

impl CachedOracleEntry {
    pub const SIZE: usize = 96;

    pub fn oracle_id(&self) -> DriftResult<OracleIdentifier> {
        let source = OracleSource::try_from(self.oracle_source)?;
        Ok((self.oracle, source))
    }

    /// Effective delay grows naturally as the entry ages.
    pub fn effective_delay(&self, current_slot: u64) -> i64 {
        let age = current_slot.saturating_sub(self.cached_slot) as i64;
        self.delay.saturating_add(age)
    }

    /// Reconstruct `OraclePriceData` with effective delay adjusted for staleness.
    pub fn to_oracle_price_data(&self, current_slot: u64) -> OraclePriceData {
        OraclePriceData {
            price: self.price,
            confidence: self.confidence,
            delay: self.effective_delay(current_slot),
            has_sufficient_number_of_data_points: self.has_sufficient_data_points != 0,
            sequence_id: None,
        }
    }

    /// Returns true if this entry is fresh enough for use.
    /// Uses `max_age_slots_override` if non-zero, else falls back to `cache_default_max_age`.
    pub fn is_fresh(&self, current_slot: u64, cache_default_max_age: u64) -> bool {
        if self.cached_slot == 0 {
            return false; // never populated
        }
        let max_age = if self.max_age_slots_override > 0 {
            self.max_age_slots_override as u64
        } else {
            cache_default_max_age
        };
        current_slot.saturating_sub(self.cached_slot) <= max_age
    }

    /// Write oracle data into this entry.
    pub fn update(
        &mut self,
        price_data: &OraclePriceData,
        oracle_source: &OracleSource,
        current_slot: u64,
    ) {
        self.price = price_data.price;
        self.confidence = price_data.confidence;
        self.delay = price_data.delay;
        self.cached_slot = current_slot;
        self.oracle_source = *oracle_source as u8;
        self.has_sufficient_data_points = if price_data.has_sufficient_number_of_data_points {
            1
        } else {
            0
        };
    }
}

impl OraclePriceCache {
    pub fn space(num_oracles: usize) -> usize {
        8 + 8 + 4 + num_oracles * CachedOracleEntry::SIZE
    }
}

impl_zero_copy_loader!(
    OraclePriceCache,
    crate::id,
    OraclePriceCacheFixed,
    CachedOracleEntry
);

/// Validate that an `AccountInfo` is a valid `OraclePriceCache` owned by the drift program.
/// Does NOT borrow data long-term — only checks discriminator + owner.
pub fn validate_oracle_price_cache_account(
    account_info: &AccountInfo,
    expected_cache_id: u8,
    expected_buffer_index: u8,
) -> DriftResult {
    if *account_info.owner != crate::id() {
        return Err(ErrorCode::DefaultError);
    }
    let data = account_info
        .try_borrow_data()
        .map_err(|_| ErrorCode::DefaultError)?;
    if data.len() < 8 + std::mem::size_of::<OraclePriceCacheFixed>() {
        return Err(ErrorCode::DefaultError);
    }
    let disc = &data[..8];
    if disc != <OraclePriceCache as anchor_lang::Discriminator>::discriminator() {
        return Err(ErrorCode::DefaultError);
    }
    let fixed: &OraclePriceCacheFixed =
        bytemuck::from_bytes(&data[8..8 + std::mem::size_of::<OraclePriceCacheFixed>()]);
    if fixed.cache_id != expected_cache_id || fixed.buffer_index != expected_buffer_index {
        return Err(ErrorCode::DefaultError);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::constants::PRICE_PRECISION_I64;
    use crate::state::zero_copy::AccountZeroCopy;
    use crate::state::zero_copy::ZeroCopyLoader;
    use crate::test_utils::create_account_info;
    use anchor_lang::AccountSerialize;

    fn make_entry(
        oracle: Pubkey,
        price: i64,
        delay: i64,
        cached_slot: u64,
        max_age_override: u8,
    ) -> CachedOracleEntry {
        CachedOracleEntry {
            oracle,
            price,
            confidence: 100,
            delay,
            cached_slot,
            oracle_source: OracleSource::Pyth as u8,
            has_sufficient_data_points: 1,
            max_age_slots_override: max_age_override,
            _padding: [0u8; 29],
        }
    }

    #[test]
    fn cached_entry_fresh_within_threshold() {
        let entry = make_entry(Pubkey::new_unique(), PRICE_PRECISION_I64, 2, 100, 0);
        assert!(entry.is_fresh(150, 60)); // 50 slots old, max_age=60
    }

    #[test]
    fn cached_entry_stale_beyond_threshold() {
        let entry = make_entry(Pubkey::new_unique(), PRICE_PRECISION_I64, 2, 100, 0);
        assert!(!entry.is_fresh(170, 60)); // 70 slots old, max_age=60
    }

    #[test]
    fn cached_entry_per_oracle_override() {
        let entry = make_entry(Pubkey::new_unique(), PRICE_PRECISION_I64, 2, 100, 30);
        // Override = 30 slots, cache default = 60.
        assert!(entry.is_fresh(125, 60)); // 25 slots, under 30 override
        assert!(!entry.is_fresh(135, 60)); // 35 slots, over 30 override
    }

    #[test]
    fn cached_entry_zero_cached_slot_always_stale() {
        let entry = make_entry(Pubkey::new_unique(), PRICE_PRECISION_I64, 0, 0, 0);
        assert!(!entry.is_fresh(10, 60));
    }

    #[test]
    fn effective_delay_grows() {
        let entry = make_entry(Pubkey::new_unique(), PRICE_PRECISION_I64, 2, 100, 0);
        // delay=2, age=110 → effective=112
        assert_eq!(entry.effective_delay(210), 112);
    }

    #[test]
    fn effective_delay_trips_staleness_at_120() {
        // delay=2, age=120 → effective=122 > 120 → StaleForMargin
        let entry = make_entry(Pubkey::new_unique(), PRICE_PRECISION_I64, 2, 100, 0);
        let price_data = entry.to_oracle_price_data(220);
        assert_eq!(price_data.delay, 122);
        // StaleForMargin threshold is handled by oracle_validity(), not here.
        // We just verify the delay value is correct.
    }

    #[test]
    fn to_oracle_price_data_roundtrip() {
        let oracle = Pubkey::new_unique();
        let entry = CachedOracleEntry {
            oracle,
            price: 42_000_000, // 42 PRICE_PRECISION
            confidence: 500,
            delay: 3,
            cached_slot: 1000,
            oracle_source: OracleSource::PythPull as u8,
            has_sufficient_data_points: 1,
            max_age_slots_override: 0,
            _padding: [0u8; 29],
        };
        let pd = entry.to_oracle_price_data(1000); // same slot → delay=3
        assert_eq!(pd.price, 42_000_000);
        assert_eq!(pd.confidence, 500);
        assert_eq!(pd.delay, 3);
        assert!(pd.has_sufficient_number_of_data_points);
        assert!(pd.sequence_id.is_none());
    }

    #[test]
    fn oracle_id_roundtrip() {
        let oracle = Pubkey::new_unique();
        let entry = make_entry(oracle, 0, 0, 0, 0);
        let id = entry.oracle_id().unwrap();
        assert_eq!(id.0, oracle);
        assert_eq!(id.1, OracleSource::Pyth);
    }

    #[test]
    fn zero_copy_loader_reads_serialized_vec_len() {
        let cache = OraclePriceCache {
            bump: 7,
            max_age_slots: 9,
            cache_id: 3,
            buffer_index: 1,
            entries: vec![
                make_entry(Pubkey::new_unique(), PRICE_PRECISION_I64, 1, 100, 0),
                make_entry(Pubkey::new_unique(), PRICE_PRECISION_I64 * 2, 2, 101, 0),
            ],
        };

        let mut data = Vec::new();
        cache.try_serialize(&mut data).unwrap();

        let key = Pubkey::new_unique();
        let owner = crate::id();
        let mut lamports = 0u64;
        let account_info = create_account_info(&key, false, &mut lamports, &mut data[..], &owner);

        let zc: AccountZeroCopy<'_, CachedOracleEntry, OraclePriceCacheFixed> =
            account_info.load_zc().unwrap();
        assert_eq!(zc.fixed.bump, 7);
        assert_eq!(zc.fixed.max_age_slots, 9);
        assert_eq!(zc.fixed.cache_id, 3);
        assert_eq!(zc.fixed.buffer_index, 1);
        assert_eq!(zc.len(), 2);
    }
}
