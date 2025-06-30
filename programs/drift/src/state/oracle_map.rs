use crate::error::ErrorCode::UnableToLoadOracle;
use crate::error::{DriftResult, ErrorCode};
use crate::ids::{
    drift_oracle_receiver_program, pyth_program, switchboard_on_demand, switchboard_program,
};
use crate::math::constants::PRICE_PRECISION_I64;
use crate::math::oracle::{oracle_validity, OracleValidity};
use crate::msg;
use crate::state::oracle::{get_oracle_price, OraclePriceData, OracleSource, PrelaunchOracle};
use crate::state::state::OracleGuardRails;
use crate::state::user::MarketType;
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

const EXTERNAL_ORACLE_PROGRAM_IDS: [Pubkey; 4] = [
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
}

impl<'a> OracleMap<'a> {
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

    pub fn get_price_data(&mut self, id: &OracleIdentifier) -> DriftResult<&OraclePriceData> {
        if self.should_get_quote_asset_price_data(&id.0) {
            return Ok(&self.quote_asset_price_data);
        }

        if self.price_data.contains_key(id) {
            return self.price_data.get(id).safe_unwrap();
        }

        let account_info = match self.oracles.get(&id.0) {
            Some(account_info) => account_info,
            None => {
                msg!("oracle pubkey not found in oracle_map: {}", id.0);
                return Err(ErrorCode::OracleNotFound);
            }
        };

        let price_data = get_oracle_price(&id.1, account_info, self.slot)?;

        self.price_data.insert(*id, price_data);
        self.price_data.get(id).safe_unwrap()
    }

    pub fn get_price_data_and_validity(
        &mut self,
        market_type: MarketType,
        market_index: u16,
        oracle_id: &OracleIdentifier,
        last_oracle_price_twap: i64,
        max_confidence_interval_multiplier: u64,
        slots_before_stale_for_amm_override: i8,
    ) -> DriftResult<(&OraclePriceData, OracleValidity)> {
        if self.should_get_quote_asset_price_data(&oracle_id.0) {
            return Ok((&self.quote_asset_price_data, OracleValidity::Valid));
        }

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
                    true,
                    slots_before_stale_for_amm_override,
                )?;
                self.validity.insert(*oracle_id, oracle_validity);
                oracle_validity
            };
            return Ok((oracle_price_data, oracle_validity));
        }

        let account_info = match self.oracles.get(&oracle_id.0) {
            Some(account_info) => account_info,
            None => {
                msg!("oracle pubkey not found in oracle_map: {}", oracle_id.0);
                return Err(ErrorCode::OracleNotFound);
            }
        };

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
            true,
            slots_before_stale_for_amm_override,
        )?;
        self.validity.insert(*oracle_id, oracle_validity);

        Ok((oracle_price_data, oracle_validity))
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

        let account_info = match self.oracles.get(&oracle_id.0) {
            Some(account_info) => account_info,
            None => {
                msg!("oracle pubkey not found in oracle_map: {}", oracle_id.0);
                return Err(ErrorCode::OracleNotFound);
            }
        };

        let price_data = get_oracle_price(&oracle_id.1, account_info, self.slot)?;

        self.price_data.insert(*oracle_id, price_data);

        let oracle_price_data = self.price_data.get(oracle_id).safe_unwrap()?;
        let validity_guard_rails = &self.oracle_guard_rails.validity;

        Ok((oracle_price_data, validity_guard_rails))
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
            },
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
            },
        })
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
            },
        }
    }
}
