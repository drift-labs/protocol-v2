use crate::error::ErrorCode::UnableToLoadOracle;
use crate::error::{DriftResult, ErrorCode};
use crate::ids::{
    drift_oracle_receiver_program, pyth_program, switchboard_on_demand, switchboard_program,
};
use crate::math::constants::PRICE_PRECISION_I64;
use crate::math::oracle::{oracle_validity, LogMode, OracleValidity};
use crate::msg;
use crate::state::oracle::{get_oracle_price, OraclePriceData, OracleSource, PrelaunchOracle};
use crate::state::oracle_price_cache::{
    CachedOracleEntry, OraclePriceCacheFixed, DEFAULT_CACHE_MAX_AGE_SLOTS,
};
use crate::state::state::OracleGuardRails;
use crate::state::user::MarketType;
use crate::state::zero_copy::{AccountZeroCopy, ZeroCopyLoader};
use anchor_lang::prelude::{AccountInfo, Pubkey};
use anchor_lang::Discriminator;
use anchor_lang::Key;
use arrayref::array_ref;
use std::collections::BTreeMap;
use std::iter::Peekable;
use std::slice::Iter;

use super::pyth_lazer_oracle::PythLazerOracle;
use super::state::ValidityGuardRails;
use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::traits::Size;
use crate::validate;

pub(crate) type OracleIdentifier = (Pubkey, OracleSource);

pub const EXTERNAL_ORACLE_PROGRAM_IDS: [Pubkey; 4] = [
    pyth_program::id(),
    drift_oracle_receiver_program::id(),
    switchboard_program::id(),
    switchboard_on_demand::id(),
];

pub struct OracleMap<'a> {
    oracles: BTreeMap<Pubkey, AccountInfo<'a>>,
    price_data: BTreeMap<OracleIdentifier, OraclePriceData>,
    validity: BTreeMap<OracleIdentifier, OracleValidity>,
    pub slot: u64,
    pub oracle_guard_rails: OracleGuardRails,
    pub quote_asset_price_data: OraclePriceData,
    /// Cache-configured max age parsed from the cache account. Consumers may choose to use this
    /// as a policy hint, but cache materialization happens when the OracleMap is constructed.
    cache_max_age: u64,
}

/// Returns true if `account_info` is an oracle account (external oracle program or drift-owned oracle).
pub fn is_oracle_account(account_info: &AccountInfo) -> bool {
    if EXTERNAL_ORACLE_PROGRAM_IDS.contains(account_info.owner) {
        return true;
    }
    if account_info.owner == &crate::id() {
        if let Ok(data) = account_info.try_borrow_data() {
            if data.len() >= 8 {
                let disc = array_ref![data, 0, 8];
                return *disc == PrelaunchOracle::discriminator()
                    || *disc == PythLazerOracle::discriminator();
            }
        }
    }
    false
}

impl<'a> OracleMap<'a> {
    pub fn cache_max_age_hint(&self) -> u64 {
        self.cache_max_age
    }

    pub fn contains(&self, pubkey: &Pubkey) -> bool {
        self.oracles.contains_key(pubkey) || pubkey == &Pubkey::default()
    }

    pub fn get_account_info(&self, pubkey: &Pubkey) -> DriftResult<AccountInfo<'a>> {
        Ok(self
            .oracles
            .get(pubkey)
            .ok_or(ErrorCode::OracleNotFound)?
            .clone())
    }

    fn should_get_quote_asset_price_data(&self, pubkey: &Pubkey) -> bool {
        pubkey == &Pubkey::default()
    }

    fn materialize_cache_entry(&mut self, entry: &CachedOracleEntry) {
        if entry.oracle == Pubkey::default() || !entry.is_fresh(self.slot, self.cache_max_age) {
            return;
        }

        if let Ok(oracle_id) = entry.oracle_id() {
            if self.oracles.contains_key(&oracle_id.0) {
                return;
            }

            self.price_data
                .insert(oracle_id, entry.to_oracle_price_data(self.slot));
        }
    }

    pub fn get_price_data(&mut self, id: &OracleIdentifier) -> DriftResult<&OraclePriceData> {
        if self.should_get_quote_asset_price_data(&id.0) {
            return Ok(&self.quote_asset_price_data);
        }

        if self.price_data.contains_key(id) {
            return self.price_data.get(id).safe_unwrap();
        }

        // try live oracle first
        if let Some(account_info) = self.oracles.get(&id.0) {
            let price_data = get_oracle_price(&id.1, account_info, self.slot)?;
            self.price_data.insert(*id, price_data);
            return self.price_data.get(id).safe_unwrap();
        }

        msg!("oracle pubkey not found in oracle_map: {}", id.0);
        Err(ErrorCode::OracleNotFound)
    }

    pub fn get_price_data_and_validity(
        &mut self,
        market_type: MarketType,
        market_index: u16,
        oracle_id: &OracleIdentifier,
        last_oracle_price_twap: i64,
        max_confidence_interval_multiplier: u64,
        slots_before_stale_for_amm_override: i8,
        oracle_low_risk_slot_delay_override_override: i8,
        log_mode: Option<LogMode>,
    ) -> DriftResult<(&OraclePriceData, OracleValidity)> {
        if self.should_get_quote_asset_price_data(&oracle_id.0) {
            return Ok((&self.quote_asset_price_data, OracleValidity::Valid));
        }

        let log_mode = if let Some(lm) = log_mode {
            lm
        } else {
            LogMode::ExchangeOracle
        };

        if self.price_data.contains_key(oracle_id) {
            let oracle_price_data = self.price_data.get(oracle_id).safe_unwrap()?;

            let oracle_validity = if let Some(oracle_validity) = self.validity.get(oracle_id) {
                *oracle_validity
            } else {
                let oracle_validity = oracle_validity(
                    market_type,
                    market_index,
                    last_oracle_price_twap,
                    oracle_price_data,
                    &self.oracle_guard_rails.validity,
                    max_confidence_interval_multiplier,
                    &oracle_id.1,
                    log_mode,
                    slots_before_stale_for_amm_override,
                    oracle_low_risk_slot_delay_override_override,
                )?;
                self.validity.insert(*oracle_id, oracle_validity);
                oracle_validity
            };
            return Ok((oracle_price_data, oracle_validity));
        }

        // try live oracle
        if let Some(account_info) = self.oracles.get(&oracle_id.0) {
            let price_data = get_oracle_price(&oracle_id.1, account_info, self.slot)?;

            self.price_data.insert(*oracle_id, price_data);

            let oracle_price_data = self.price_data.get(oracle_id).safe_unwrap()?;
            let oracle_validity = oracle_validity(
                market_type,
                market_index,
                last_oracle_price_twap,
                oracle_price_data,
                &self.oracle_guard_rails.validity,
                max_confidence_interval_multiplier,
                &oracle_id.1,
                log_mode,
                slots_before_stale_for_amm_override,
                oracle_low_risk_slot_delay_override_override,
            )?;
            self.validity.insert(*oracle_id, oracle_validity);

            return Ok((oracle_price_data, oracle_validity));
        }

        msg!("oracle pubkey not found in oracle_map: {}", oracle_id.0);
        Err(ErrorCode::OracleNotFound)
    }

    pub fn get_price_data_and_guard_rails(
        &mut self,
        oracle_id: &OracleIdentifier,
    ) -> DriftResult<(&OraclePriceData, &ValidityGuardRails)> {
        if self.should_get_quote_asset_price_data(&oracle_id.0) {
            let validity_guard_rails = &self.oracle_guard_rails.validity;
            return Ok((&self.quote_asset_price_data, validity_guard_rails));
        }

        if self.price_data.contains_key(oracle_id) {
            let oracle_price_data = self.price_data.get(oracle_id).safe_unwrap()?;
            let validity_guard_rails = &self.oracle_guard_rails.validity;

            return Ok((oracle_price_data, validity_guard_rails));
        }

        // try live oracle
        if let Some(account_info) = self.oracles.get(&oracle_id.0) {
            let price_data = get_oracle_price(&oracle_id.1, account_info, self.slot)?;
            self.price_data.insert(*oracle_id, price_data);
            let oracle_price_data = self.price_data.get(oracle_id).safe_unwrap()?;
            let validity_guard_rails = &self.oracle_guard_rails.validity;
            return Ok((oracle_price_data, validity_guard_rails));
        }

        msg!("oracle pubkey not found in oracle_map: {}", oracle_id.0);
        Err(ErrorCode::OracleNotFound)
    }

    pub fn load<'c>(
        account_info_iter: &'c mut Peekable<Iter<AccountInfo<'a>>>,
        slot: u64,
        oracle_guard_rails: Option<OracleGuardRails>,
    ) -> DriftResult<OracleMap<'a>> {
        let mut oracles: BTreeMap<Pubkey, AccountInfo<'a>> = BTreeMap::new();

        while let Some(account_info) = account_info_iter.peek() {
            if EXTERNAL_ORACLE_PROGRAM_IDS.contains(&account_info.owner) {
                let account_info: &AccountInfo<'a> = account_info_iter.next().safe_unwrap()?;
                let pubkey = account_info.key();

                oracles.insert(pubkey, account_info.clone());

                continue;
            } else if account_info.owner == &crate::id() {
                let data = account_info.try_borrow_data().map_err(|e| {
                    msg!("Failed to borrow data while loading oracle map {:?}", e);
                    UnableToLoadOracle
                })?;

                let account_discriminator = array_ref![data, 0, 8];

                if account_discriminator == &PrelaunchOracle::discriminator() {
                    let expected_data_len = PrelaunchOracle::SIZE;
                    if data.len() < expected_data_len {
                        break;
                    }
                } else if account_discriminator == &PythLazerOracle::discriminator() {
                    let expected_data_len = PythLazerOracle::SIZE;
                    if data.len() < expected_data_len {
                        break;
                    }
                } else {
                    break;
                }

                let account_info = account_info_iter.next().safe_unwrap()?;
                let pubkey = account_info.key();

                oracles.insert(pubkey, account_info.clone());

                continue;
            }

            break;
        }

        let ogr: OracleGuardRails = if let Some(o) = oracle_guard_rails {
            o
        } else {
            OracleGuardRails::default()
        };

        Ok(OracleMap {
            oracles,
            price_data: BTreeMap::new(),
            validity: BTreeMap::new(),
            slot,
            oracle_guard_rails: ogr,
            quote_asset_price_data: OraclePriceData {
                price: PRICE_PRECISION_I64,
                confidence: 1,
                delay: 0,
                has_sufficient_number_of_data_points: true,
                sequence_id: None,
            },
            cache_max_age: 0,
        })
    }

    pub fn load_one<'c>(
        account_info: &'c AccountInfo<'a>,
        slot: u64,
        oracle_guard_rails: Option<OracleGuardRails>,
    ) -> DriftResult<OracleMap<'a>> {
        let mut oracles: BTreeMap<Pubkey, AccountInfo<'a>> = BTreeMap::new();

        if EXTERNAL_ORACLE_PROGRAM_IDS.contains(&account_info.owner) {
            let pubkey = account_info.key();

            oracles.insert(pubkey, account_info.clone());
        } else if account_info.owner == &crate::id() {
            let data = account_info.try_borrow_data().map_err(|e| {
                msg!("Failed to borrow data while loading oracle map {:?}", e);
                UnableToLoadOracle
            })?;

            let account_discriminator = array_ref![data, 0, 8];

            if account_discriminator == &PrelaunchOracle::discriminator() {
                let expected_data_len = PrelaunchOracle::SIZE;
                if data.len() < expected_data_len {
                    msg!("Unexpected account data len loading oracle");
                    return Err(UnableToLoadOracle);
                }
            } else if account_discriminator == &PythLazerOracle::discriminator() {
                let expected_data_len = PythLazerOracle::SIZE;
                if data.len() < expected_data_len {
                    msg!("Unexpected account data len loading oracle");
                    return Err(UnableToLoadOracle);
                }
            } else {
                msg!("Unexpected account discriminator");
                return Err(UnableToLoadOracle);
            }

            let pubkey = account_info.key();
            oracles.insert(pubkey, account_info.clone());
        } else if account_info.key() != Pubkey::default() {
            return Err(ErrorCode::InvalidOracle);
        }

        let ogr: OracleGuardRails = if let Some(o) = oracle_guard_rails {
            o
        } else {
            OracleGuardRails::default()
        };

        Ok(OracleMap {
            oracles,
            price_data: BTreeMap::new(),
            validity: BTreeMap::new(),
            slot,
            oracle_guard_rails: ogr,
            quote_asset_price_data: OraclePriceData {
                price: PRICE_PRECISION_I64,
                confidence: 1,
                delay: 0,
                has_sufficient_number_of_data_points: true,
                sequence_id: None,
            },
            cache_max_age: 0,
        })
    }

    /// Like `load_one`, but also materializes fresh oracle price cache entries into `price_data`.
    /// Pass the drift program ID as `cache_account_info` to skip cache loading.
    pub fn load_one_with_cache<'c>(
        account_info: &'c AccountInfo<'a>,
        cache_account_info: &'c AccountInfo<'a>,
        slot: u64,
        oracle_guard_rails: Option<OracleGuardRails>,
    ) -> DriftResult<OracleMap<'a>> {
        let mut oracle_map = Self::load_one(account_info, slot, oracle_guard_rails)?;

        // Skip cache when caller passes the program ID as sentinel (cache omitted).
        if cache_account_info.key() != crate::id()
            && *cache_account_info.owner == crate::id()
            && cache_account_info.data_len() > 8
        {
            let zc: AccountZeroCopy<CachedOracleEntry, OraclePriceCacheFixed> =
                cache_account_info.load_zc()?;

            let max_age_raw = zc.fixed.max_age_slots;
            oracle_map.cache_max_age = if max_age_raw == 0 {
                DEFAULT_CACHE_MAX_AGE_SLOTS
            } else {
                max_age_raw as u64
            };

            for entry in zc.iter() {
                oracle_map.materialize_cache_entry(entry);
            }
        }

        Ok(oracle_map)
    }

    /// Insert a live oracle account into the map. Used for live oracle fallback
    /// from remaining_accounts. Same owner validation as `load_one`.
    pub fn insert_live_oracle(&mut self, account_info: &AccountInfo<'a>) -> DriftResult<()> {
        let pubkey = account_info.key();

        if EXTERNAL_ORACLE_PROGRAM_IDS.contains(account_info.owner) {
            self.oracles.insert(pubkey, account_info.clone());
            self.price_data.retain(|id, _| id.0 != pubkey);
            self.validity.retain(|id, _| id.0 != pubkey);
            return Ok(());
        }

        if account_info.owner == &crate::id() {
            let data = account_info.try_borrow_data().map_err(|e| {
                msg!("Failed to borrow data while inserting live oracle {:?}", e);
                UnableToLoadOracle
            })?;

            if data.len() < 8 {
                return Err(UnableToLoadOracle);
            }

            let account_discriminator = array_ref![data, 0, 8];

            if account_discriminator == &PrelaunchOracle::discriminator() {
                if data.len() < PrelaunchOracle::SIZE {
                    return Err(UnableToLoadOracle);
                }
            } else if account_discriminator == &PythLazerOracle::discriminator() {
                if data.len() < PythLazerOracle::SIZE {
                    return Err(UnableToLoadOracle);
                }
            } else {
                return Err(UnableToLoadOracle);
            }

            drop(data);
            self.oracles.insert(pubkey, account_info.clone());
            self.price_data.retain(|id, _| id.0 != pubkey);
            self.validity.retain(|id, _| id.0 != pubkey);
            return Ok(());
        }

        Err(ErrorCode::InvalidOracle)
    }

    pub fn validate_oracle_account_info<'c>(account_info: &'c AccountInfo<'a>) -> DriftResult {
        if *account_info.key == Pubkey::default() {
            return Ok(());
        }

        validate!(
            OracleMap::load_one(account_info, 0, None)?.oracles.len() == 1,
            ErrorCode::InvalidOracle,
            "oracle owner not recognizable"
        )
    }
}

#[cfg(test)]
impl<'a> OracleMap<'a> {
    pub fn empty() -> OracleMap<'a> {
        OracleMap {
            oracles: BTreeMap::new(),
            validity: BTreeMap::new(),
            price_data: BTreeMap::new(),
            slot: 0,
            oracle_guard_rails: OracleGuardRails::default(),
            quote_asset_price_data: OraclePriceData {
                price: PRICE_PRECISION_I64,
                confidence: 1,
                delay: 0,
                has_sufficient_number_of_data_points: true,
                sequence_id: None,
            },
            cache_max_age: 0,
        }
    }

    /// Test helper: create an OracleMap with pre-populated cache entries.
    pub fn with_cache(
        slot: u64,
        cache_max_age: u64,
        entries: Vec<CachedOracleEntry>,
    ) -> OracleMap<'a> {
        let mut oracle_map = OracleMap {
            oracles: BTreeMap::new(),
            validity: BTreeMap::new(),
            price_data: BTreeMap::new(),
            slot,
            oracle_guard_rails: OracleGuardRails::default(),
            quote_asset_price_data: OraclePriceData {
                price: PRICE_PRECISION_I64,
                confidence: 1,
                delay: 0,
                has_sufficient_number_of_data_points: true,
                sequence_id: None,
            },
            cache_max_age,
        };

        for entry in entries.iter() {
            oracle_map.materialize_cache_entry(entry);
        }

        oracle_map
    }

    pub fn set_cache_for_test(&mut self, cache_max_age: u64, entries: Vec<CachedOracleEntry>) {
        self.cache_max_age = cache_max_age;
        for entry in entries.iter() {
            if let Ok(id) = entry.oracle_id() {
                self.price_data.remove(&id);
                self.validity.remove(&id);
            }
            self.materialize_cache_entry(entry);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::oracle_price_cache::CachedOracleEntry;

    fn make_cached_entry(
        oracle: Pubkey,
        price: i64,
        delay: i64,
        cached_slot: u64,
    ) -> CachedOracleEntry {
        CachedOracleEntry {
            oracle,
            price,
            confidence: 100,
            delay,
            cached_slot,
            oracle_source: OracleSource::Pyth as u8,
            has_sufficient_data_points: 1,
            max_age_slots_override: 0,
            _padding: [0u8; 29],
        }
    }

    #[test]
    fn live_only_ignores_cache() {
        let oracle = Pubkey::new_unique();
        let entry = make_cached_entry(oracle, 42_000_000, 2, 900);
        let mut map = OracleMap::empty();
        map.cache_max_age = 60;

        let id = (oracle, OracleSource::Pyth);
        let result = map.get_price_data(&id);
        assert!(result.is_err());
        map.materialize_cache_entry(&entry);
        assert_eq!(map.get_price_data(&id).unwrap().price, 42_000_000);
    }

    #[test]
    fn cache_allowed_falls_back_to_cache_when_no_live() {
        let oracle = Pubkey::new_unique();
        let entry = make_cached_entry(oracle, 42_000_000, 2, 900);
        let mut map = OracleMap::with_cache(950, 60, vec![entry]);

        let id = (oracle, OracleSource::Pyth);
        let pd = map.get_price_data(&id).unwrap();
        assert_eq!(pd.price, 42_000_000);
        assert_eq!(pd.delay, 52);
    }

    #[test]
    fn stale_cache_returns_oracle_not_found_when_cache_allowed() {
        let oracle = Pubkey::new_unique();
        let entry = make_cached_entry(oracle, 42_000_000, 2, 800);
        let mut map = OracleMap::with_cache(900, 60, vec![entry]);

        let id = (oracle, OracleSource::Pyth);
        let result = map.get_price_data(&id);
        assert!(result.is_err());
    }

    #[test]
    fn cache_lookup_is_keyed_when_cache_allowed() {
        let oracle_a = Pubkey::new_unique();
        let oracle_b = Pubkey::new_unique();
        let entry_a = make_cached_entry(oracle_a, 100_000_000, 1, 950);
        let entry_b = make_cached_entry(oracle_b, 200_000_000, 1, 950);
        let mut map = OracleMap::with_cache(960, 60, vec![entry_a, entry_b]);

        let id_a = (oracle_a, OracleSource::Pyth);
        let id_b = (oracle_b, OracleSource::Pyth);

        let pd_a = map.get_price_data(&id_a).unwrap();
        assert_eq!(pd_a.price, 100_000_000);

        let pd_b = map.get_price_data(&id_b).unwrap();
        assert_eq!(pd_b.price, 200_000_000);
    }
}
