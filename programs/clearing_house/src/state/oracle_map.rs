use crate::error::{ClearingHouseResult, ErrorCode};
use crate::ids::pyth_program;
use crate::math::constants::MARK_PRICE_PRECISION_I128;
use crate::state::oracle::{get_oracle_price, OraclePriceData, OracleSource};
use anchor_lang::prelude::{AccountInfo, Pubkey};
use anchor_lang::Key;
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
    slot: u64,
    quote_asset_price_data: OraclePriceData,
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
                return Err(ErrorCode::OracleNotFound);
            }
        };

        let price_data = get_oracle_price(oracle_source, account_info, self.slot)?;

        self.price_data.insert(*pubkey, price_data);

        Ok(self.price_data.get(pubkey).unwrap())
    }

    pub fn load<'c>(
        account_info_iter: &'c mut Peekable<Iter<AccountInfo<'a>>>,
        slot: u64,
    ) -> ClearingHouseResult<OracleMap<'a>> {
        let mut oracles: BTreeMap<Pubkey, AccountInfoAndOracleSource<'a>> = BTreeMap::new();

        while let Some(account_info) = account_info_iter.peek() {
            if account_info.owner == &pyth_program::id() {
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

        Ok(OracleMap {
            oracles,
            price_data: BTreeMap::new(),
            slot,
            quote_asset_price_data: OraclePriceData {
                price: MARK_PRICE_PRECISION_I128,
                confidence: 1,
                delay: 0,
                has_sufficient_number_of_data_points: true,
            },
        })
    }
}
