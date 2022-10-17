use crate::error::{ClearingHouseResult, ErrorCode};
use crate::ids::mock_pyth_program;
use crate::ids::pyth_program;
use crate::math::constants::PRICE_PRECISION_I128;
use crate::math::oracle::{oracle_validity, OracleValidity};
use crate::state::oracle::{get_oracle_price, OraclePriceData, OracleSource};
use crate::state::state::OracleGuardRails;
use anchor_lang::prelude::{AccountInfo, Pubkey};
use anchor_lang::Key;
use solana_program::msg;
use std::collections::BTreeMap;
use std::iter::Peekable;
use std::slice::Iter;

pub struct AccountInfoAndOracleSource<'a> {
    /// CHECK: ownders are validated in OracleMap::load
    pub account_info: AccountInfo<'a>,
    pub oracle_source: OracleSource,
}

pub struct OracleMap<'a> {
    oracles: BTreeMap<Pubkey, AccountInfoAndOracleSource<'a>>,
    price_data: BTreeMap<Pubkey, OraclePriceData>,
    pub slot: u64,
    pub oracle_guard_rails: OracleGuardRails,
    pub quote_asset_price_data: OraclePriceData,
}

impl<'a> OracleMap<'a> {
    pub fn contains(&self, pubkey: &Pubkey) -> bool {
        self.oracles.contains_key(pubkey) || pubkey == &Pubkey::default()
    }

    pub fn get_account_info(&self, pubkey: &Pubkey) -> ClearingHouseResult<AccountInfo<'a>> {
        Ok(self
            .oracles
            .get(pubkey)
            .ok_or(ErrorCode::OracleNotFound)?
            .account_info
            .clone())
    }

    pub fn get_price_data(&mut self, pubkey: &Pubkey) -> ClearingHouseResult<&OraclePriceData> {
        if pubkey == &Pubkey::default() {
            return Ok(&self.quote_asset_price_data);
        }

        if self.price_data.contains_key(pubkey) {
            return Ok(self.price_data.get(pubkey).unwrap());
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

        Ok(self.price_data.get(pubkey).unwrap())
    }

    pub fn get_price_data_and_validity(
        &mut self,
        pubkey: &Pubkey,
        last_oracle_price_twap: i128,
    ) -> ClearingHouseResult<(&OraclePriceData, OracleValidity)> {
        if pubkey == &Pubkey::default() {
            return Ok((&self.quote_asset_price_data, OracleValidity::Valid));
        }

        if self.price_data.contains_key(pubkey) {
            let oracle_price_data = self.price_data.get(pubkey).unwrap();
            let is_oracle_valid = oracle_validity(
                last_oracle_price_twap,
                oracle_price_data,
                &self.oracle_guard_rails.validity,
            )?;
            return Ok((oracle_price_data, is_oracle_valid));
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

        let oracle_price_data = self.price_data.get(pubkey).unwrap();
        let is_oracle_valid = oracle_validity(
            last_oracle_price_twap,
            oracle_price_data,
            &self.oracle_guard_rails.validity,
        )?;

        Ok((oracle_price_data, is_oracle_valid))
    }

    pub fn load<'c>(
        account_info_iter: &'c mut Peekable<Iter<AccountInfo<'a>>>,
        slot: u64,
        oracle_guard_rails: Option<OracleGuardRails>,
    ) -> ClearingHouseResult<OracleMap<'a>> {
        let mut oracles: BTreeMap<Pubkey, AccountInfoAndOracleSource<'a>> = BTreeMap::new();

        while let Some(account_info) = account_info_iter.peek() {
            if account_info.owner == &pyth_program::id()
                || account_info.owner == &mock_pyth_program::id()
            {
                let account_info = account_info_iter.next().unwrap();
                let pubkey = account_info.key();
                oracles.insert(
                    pubkey,
                    AccountInfoAndOracleSource {
                        account_info: account_info.clone(),
                        oracle_source: OracleSource::Pyth,
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
            slot,
            oracle_guard_rails: ogr,
            quote_asset_price_data: OraclePriceData {
                price: PRICE_PRECISION_I128,
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
    ) -> ClearingHouseResult<OracleMap<'a>> {
        let mut oracles: BTreeMap<Pubkey, AccountInfoAndOracleSource<'a>> = BTreeMap::new();

        if account_info.owner != &pyth_program::id() {
            return Err(ErrorCode::InvalidOracle);
        }

        let pubkey = account_info.key();
        oracles.insert(
            pubkey,
            AccountInfoAndOracleSource {
                account_info: account_info.clone(),
                oracle_source: OracleSource::Pyth,
            },
        );

        let ogr: OracleGuardRails = if let Some(o) = oracle_guard_rails {
            o
        } else {
            OracleGuardRails::default()
        };

        Ok(OracleMap {
            oracles,
            price_data: BTreeMap::new(),
            slot,
            oracle_guard_rails: ogr,
            quote_asset_price_data: OraclePriceData {
                price: PRICE_PRECISION_I128,
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
            price_data: BTreeMap::new(),
            slot: 0,
            oracle_guard_rails: OracleGuardRails::default(),
            quote_asset_price_data: OraclePriceData {
                price: PRICE_PRECISION_I128,
                confidence: 1,
                delay: 0,
                has_sufficient_number_of_data_points: true,
            },
        }
    }
}
