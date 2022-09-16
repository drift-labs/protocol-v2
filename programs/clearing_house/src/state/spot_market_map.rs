use crate::error::{ClearingHouseResult, ErrorCode};
use crate::state::spot_market::SpotMarket;
use anchor_lang::prelude::{AccountInfo, AccountLoader};
use std::cell::{Ref, RefMut};
use std::collections::{BTreeMap, BTreeSet};

use std::iter::Peekable;
use std::slice::Iter;

use crate::math::constants::QUOTE_SPOT_MARKET_INDEX;
use anchor_lang::Discriminator;
use arrayref::array_ref;

pub struct SpotMarketMap<'a>(pub BTreeMap<u64, AccountLoader<'a, SpotMarket>>);

impl<'a> SpotMarketMap<'a> {
    pub fn get_ref(&self, market_index: &u64) -> ClearingHouseResult<Ref<SpotMarket>> {
        self.0
            .get(market_index)
            .ok_or(ErrorCode::SpotMarketNotFound)?
            .load()
            .map_err(|e| {
                solana_program::msg!("{:?}", e);
                ErrorCode::UnableToLoadSpotMarketAccount
            })
    }

    pub fn get_ref_mut(&self, market_index: &u64) -> ClearingHouseResult<RefMut<SpotMarket>> {
        self.0
            .get(market_index)
            .ok_or(ErrorCode::SpotMarketNotFound)?
            .load_mut()
            .map_err(|e| {
                solana_program::msg!("{:?}", e);
                ErrorCode::UnableToLoadSpotMarketAccount
            })
    }

    pub fn get_quote_spot_market(&self) -> ClearingHouseResult<Ref<SpotMarket>> {
        self.get_ref(&QUOTE_SPOT_MARKET_INDEX)
    }

    pub fn get_quote_spot_market_mut(&self) -> ClearingHouseResult<RefMut<SpotMarket>> {
        self.get_ref_mut(&QUOTE_SPOT_MARKET_INDEX)
    }

    pub fn load<'b, 'c>(
        writable_spot_markets: &'b SpotMarketSet,
        account_info_iter: &'c mut Peekable<Iter<AccountInfo<'a>>>,
    ) -> ClearingHouseResult<SpotMarketMap<'a>> {
        let mut spot_market_map: SpotMarketMap = SpotMarketMap(BTreeMap::new());

        let spot_market_discriminator: [u8; 8] = SpotMarket::discriminator();
        while let Some(account_info) = account_info_iter.peek() {
            let data = account_info
                .try_borrow_data()
                .or(Err(ErrorCode::CouldNotLoadSpotMarketData))?;

            if data.len() < std::mem::size_of::<SpotMarket>() + 8 {
                break;
            }

            let account_discriminator = array_ref![data, 0, 8];
            if account_discriminator != &spot_market_discriminator {
                break;
            }

            let market_index = u64::from_le_bytes(*array_ref![data, 8, 8]);

            let account_info = account_info_iter.next().unwrap();
            let is_writable = account_info.is_writable;
            let account_loader: AccountLoader<SpotMarket> =
                AccountLoader::try_from(account_info)
                    .or(Err(ErrorCode::InvalidSpotMarketAccount))?;

            if writable_spot_markets.contains(&market_index) && !is_writable {
                return Err(ErrorCode::SpotMarketWrongMutability);
            }

            spot_market_map.0.insert(market_index, account_loader);
        }

        Ok(spot_market_map)
    }
}

#[cfg(test)]
impl<'a> SpotMarketMap<'a> {
    pub fn load_one<'c>(
        account_info: &'c AccountInfo<'a>,
        must_be_writable: bool,
    ) -> ClearingHouseResult<SpotMarketMap<'a>> {
        let mut spot_market_map: SpotMarketMap = SpotMarketMap(BTreeMap::new());

        let spot_market_discriminator: [u8; 8] = SpotMarket::discriminator();
        let data = account_info
            .try_borrow_data()
            .or(Err(ErrorCode::CouldNotLoadSpotMarketData))?;

        if data.len() < std::mem::size_of::<SpotMarket>() + 8 {
            return Err(ErrorCode::CouldNotLoadSpotMarketData);
        }

        let account_discriminator = array_ref![data, 0, 8];
        if account_discriminator != &spot_market_discriminator {
            return Err(ErrorCode::CouldNotLoadSpotMarketData);
        }

        let market_index = u64::from_le_bytes(*array_ref![data, 8, 8]);
        let is_writable = account_info.is_writable;
        let account_loader: AccountLoader<SpotMarket> =
            AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidSpotMarketAccount))?;

        if must_be_writable && !is_writable {
            return Err(ErrorCode::SpotMarketWrongMutability);
        }

        spot_market_map.0.insert(market_index, account_loader);

        Ok(spot_market_map)
    }

    pub fn load_multiple<'c>(
        account_info: Vec<&'c AccountInfo<'a>>,
        must_be_writable: bool,
    ) -> ClearingHouseResult<SpotMarketMap<'a>> {
        let mut spot_market_map: SpotMarketMap = SpotMarketMap(BTreeMap::new());

        let account_info_iter = account_info.into_iter();
        for account_info in account_info_iter {
            let spot_market_discriminator: [u8; 8] = SpotMarket::discriminator();
            let data = account_info
                .try_borrow_data()
                .or(Err(ErrorCode::CouldNotLoadSpotMarketData))?;

            if data.len() < std::mem::size_of::<SpotMarket>() + 8 {
                return Err(ErrorCode::CouldNotLoadSpotMarketData);
            }

            let account_discriminator = array_ref![data, 0, 8];
            if account_discriminator != &spot_market_discriminator {
                return Err(ErrorCode::CouldNotLoadSpotMarketData);
            }

            let market_index = u64::from_le_bytes(*array_ref![data, 8, 8]);
            let is_writable = account_info.is_writable;
            let account_loader: AccountLoader<SpotMarket> =
                AccountLoader::try_from(account_info)
                    .or(Err(ErrorCode::InvalidSpotMarketAccount))?;

            if must_be_writable && !is_writable {
                return Err(ErrorCode::SpotMarketWrongMutability);
            }

            spot_market_map.0.insert(market_index, account_loader);
        }

        Ok(spot_market_map)
    }
}

pub type SpotMarketSet = BTreeSet<u64>;

pub fn get_writable_spot_market_set(market_index: u64) -> SpotMarketSet {
    let mut writable_markets = SpotMarketSet::new();
    writable_markets.insert(market_index);
    writable_markets
}
