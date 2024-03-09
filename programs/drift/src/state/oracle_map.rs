use crate::error::ErrorCode::UnableToLoadOracle;
use crate::error::{DriftResult, ErrorCode};
use crate::ids::{
    bonk_oracle, pepe_oracle, pyth_program, switchboard_program, usdc_oracle, usdt_oracle_mainnet,
};
use crate::math::constants::PRICE_PRECISION_I64;
use crate::math::oracle::{oracle_validity, OracleValidity};
use crate::state::oracle::{get_oracle_price, OraclePriceData, OracleSource, PrelaunchOracle};
use crate::state::state::OracleGuardRails;
use crate::state::user::MarketType;
use anchor_lang::prelude::{AccountInfo, Pubkey};
use anchor_lang::Discriminator;
use anchor_lang::Key;
use arrayref::array_ref;
use solana_program::msg;
use std::collections::BTreeMap;
use std::iter::Peekable;
use std::slice::Iter;

use super::state::ValidityGuardRails;
use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::traits::Size;

pub struct AccountInfoAndOracleSource<'a> {
    /// CHECK: ownders are validated in OracleMap::load
    pub account_info: AccountInfo<'a>,
    pub oracle_source: OracleSource,
}

pub struct OracleMap<'a> {
    oracles: BTreeMap<Pubkey, AccountInfoAndOracleSource<'a>>,
    price_data: BTreeMap<Pubkey, OraclePriceData>,
    validity: BTreeMap<Pubkey, OracleValidity>,
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
            .account_info
            .clone())
    }

    fn should_get_quote_asset_price_data(&self, pubkey: &Pubkey) -> bool {
        pubkey == &Pubkey::default()
    }

    pub fn get_price_data(&mut self, pubkey: &Pubkey) -> DriftResult<&OraclePriceData> {
        if self.should_get_quote_asset_price_data(pubkey) {
            return Ok(&self.quote_asset_price_data);
        }

        if self.price_data.contains_key(pubkey) {
            return self.price_data.get(pubkey).safe_unwrap();
        }

        let (account_info, oracle_source) = match self.oracles.get(pubkey) {
            Some(AccountInfoAndOracleSource {
                account_info,
                oracle_source,
            }) => (account_info, oracle_source),
            None => {
                msg!("oracle pubkey not found in oracle_map: {}", pubkey);
                return Err(ErrorCode::OracleNotFound);
            }
        };

        let price_data = get_oracle_price(oracle_source, account_info, self.slot)?;

        self.price_data.insert(*pubkey, price_data);

        self.price_data.get(pubkey).safe_unwrap()
    }

    pub fn get_price_data_and_validity(
        &mut self,
        market_type: MarketType,
        market_index: u16,
        pubkey: &Pubkey,
        last_oracle_price_twap: i64,
        max_confidence_interval_multiplier: u64,
    ) -> DriftResult<(&OraclePriceData, OracleValidity)> {
        if self.should_get_quote_asset_price_data(pubkey) {
            return Ok((&self.quote_asset_price_data, OracleValidity::Valid));
        }

        if self.price_data.contains_key(pubkey) {
            let oracle_price_data = self.price_data.get(pubkey).safe_unwrap()?;

            let oracle_validity = if let Some(oracle_validity) = self.validity.get(pubkey) {
                *oracle_validity
            } else {
                let oracle_validity = oracle_validity(
                    market_type,
                    market_index,
                    last_oracle_price_twap,
                    oracle_price_data,
                    &self.oracle_guard_rails.validity,
                    max_confidence_interval_multiplier,
                    true,
                )?;
                self.validity.insert(*pubkey, oracle_validity);
                oracle_validity
            };
            return Ok((oracle_price_data, oracle_validity));
        }

        let (account_info, oracle_source) = match self.oracles.get(pubkey) {
            Some(AccountInfoAndOracleSource {
                account_info,
                oracle_source,
            }) => (account_info, oracle_source),
            None => {
                msg!("oracle pubkey not found in oracle_map: {}", pubkey);
                return Err(ErrorCode::OracleNotFound);
            }
        };

        let price_data = get_oracle_price(oracle_source, account_info, self.slot)?;

        self.price_data.insert(*pubkey, price_data);

        let oracle_price_data = self.price_data.get(pubkey).safe_unwrap()?;
        let oracle_validity = oracle_validity(
            market_type,
            market_index,
            last_oracle_price_twap,
            oracle_price_data,
            &self.oracle_guard_rails.validity,
            max_confidence_interval_multiplier,
            true,
        )?;
        self.validity.insert(*pubkey, oracle_validity);

        Ok((oracle_price_data, oracle_validity))
    }

    pub fn get_price_data_and_guard_rails(
        &mut self,
        pubkey: &Pubkey,
    ) -> DriftResult<(&OraclePriceData, &ValidityGuardRails)> {
        if self.should_get_quote_asset_price_data(pubkey) {
            let validity_guard_rails = &self.oracle_guard_rails.validity;
            return Ok((&self.quote_asset_price_data, validity_guard_rails));
        }

        if self.price_data.contains_key(pubkey) {
            let oracle_price_data = self.price_data.get(pubkey).safe_unwrap()?;
            let validity_guard_rails = &self.oracle_guard_rails.validity;

            return Ok((oracle_price_data, validity_guard_rails));
        }

        let (account_info, oracle_source) = match self.oracles.get(pubkey) {
            Some(AccountInfoAndOracleSource {
                account_info,
                oracle_source,
            }) => (account_info, oracle_source),
            None => {
                msg!("oracle pubkey not found in oracle_map: {}", pubkey);
                return Err(ErrorCode::OracleNotFound);
            }
        };

        let price_data = get_oracle_price(oracle_source, account_info, self.slot)?;

        self.price_data.insert(*pubkey, price_data);

        let oracle_price_data = self.price_data.get(pubkey).safe_unwrap()?;
        let validity_guard_rails = &self.oracle_guard_rails.validity;

        Ok((oracle_price_data, validity_guard_rails))
    }

    pub fn load<'c>(
        account_info_iter: &'c mut Peekable<Iter<AccountInfo<'a>>>,
        slot: u64,
        oracle_guard_rails: Option<OracleGuardRails>,
    ) -> DriftResult<OracleMap<'a>> {
        let mut oracles: BTreeMap<Pubkey, AccountInfoAndOracleSource<'a>> = BTreeMap::new();

        while let Some(account_info) = account_info_iter.peek() {
            if account_info.owner == &pyth_program::id() {
                let account_info = account_info_iter.next().safe_unwrap()?;
                let pubkey = account_info.key();

                let oracle_source = if pubkey == bonk_oracle::id() || pubkey == pepe_oracle::id() {
                    OracleSource::Pyth1M
                } else if pubkey == usdc_oracle::id() || pubkey == usdt_oracle_mainnet::id() {
                    OracleSource::PythStableCoin
                } else {
                    OracleSource::Pyth
                };

                oracles.insert(
                    pubkey,
                    AccountInfoAndOracleSource {
                        account_info: account_info.clone(),
                        oracle_source,
                    },
                );

                continue;
            } else if account_info.owner == &crate::id() {
                let data = account_info.try_borrow_data().map_err(|e| {
                    msg!("Failed to borrow data while loading oracle map {:?}", e);
                    UnableToLoadOracle
                })?;

                let expected_data_len = PrelaunchOracle::SIZE;
                if data.len() < expected_data_len {
                    break;
                }

                let account_discriminator = array_ref![data, 0, 8];
                if account_discriminator != &PrelaunchOracle::discriminator() {
                    break;
                }

                let account_info = account_info_iter.next().safe_unwrap()?;
                let pubkey = account_info.key();

                oracles.insert(
                    pubkey,
                    AccountInfoAndOracleSource {
                        account_info: account_info.clone(),
                        oracle_source: OracleSource::Prelaunch,
                    },
                );

                continue;
            } else if account_info.owner == &switchboard_program::id() {
                let account_info = account_info_iter.next().safe_unwrap()?;
                let pubkey = account_info.key();

                oracles.insert(
                    pubkey,
                    AccountInfoAndOracleSource {
                        account_info: account_info.clone(),
                        oracle_source: OracleSource::Switchboard,
                    },
                );

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
        let mut oracles: BTreeMap<Pubkey, AccountInfoAndOracleSource<'a>> = BTreeMap::new();

        if account_info.owner == &pyth_program::id() {
            let pubkey = account_info.key();
            let oracle_source = if pubkey == bonk_oracle::id() || pubkey == pepe_oracle::id() {
                OracleSource::Pyth1M
            } else if pubkey == usdc_oracle::id() || pubkey == usdt_oracle_mainnet::id() {
                OracleSource::PythStableCoin
            } else {
                OracleSource::Pyth
            };
            oracles.insert(
                pubkey,
                AccountInfoAndOracleSource {
                    account_info: account_info.clone(),
                    oracle_source,
                },
            );
        } else if account_info.owner == &crate::id() {
            let data = account_info.try_borrow_data().map_err(|e| {
                msg!("Failed to borrow data while loading oracle map {:?}", e);
                UnableToLoadOracle
            })?;

            let expected_data_len = PrelaunchOracle::SIZE;
            if data.len() < expected_data_len {
                msg!("Unexpected account data len loading oracle");
                return Err(UnableToLoadOracle);
            }

            let account_discriminator = array_ref![data, 0, 8];
            if account_discriminator != &PrelaunchOracle::discriminator() {
                msg!("Unexpected account discriminator");
                return Err(UnableToLoadOracle);
            }

            let pubkey = account_info.key();
            oracles.insert(
                pubkey,
                AccountInfoAndOracleSource {
                    account_info: account_info.clone(),
                    oracle_source: OracleSource::Prelaunch,
                },
            );
        } else if account_info.owner == &switchboard_program::id() {
            let pubkey = account_info.key();
            oracles.insert(
                pubkey,
                AccountInfoAndOracleSource {
                    account_info: account_info.clone(),
                    oracle_source: OracleSource::Switchboard,
                },
            );
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
