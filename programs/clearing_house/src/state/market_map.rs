use anchor_lang::accounts::account_loader::AccountLoader;
use std::cell::{Ref, RefMut};
use std::collections::{BTreeMap, BTreeSet};
use std::iter::Peekable;
use std::slice::Iter;

use anchor_lang::prelude::AccountInfo;

use anchor_lang::Discriminator;
use arrayref::array_ref;

use crate::error::{ClearingHouseResult, ErrorCode};
use crate::state::market::Market;
use crate::state::user::UserPositions;

pub struct MarketMap<'a>(pub BTreeMap<u64, AccountLoader<'a, Market>>);

impl<'a> MarketMap<'a> {
    pub fn get_ref(&self, market_index: &u64) -> ClearingHouseResult<Ref<Market>> {
        self.0
            .get(market_index)
            .ok_or(ErrorCode::MarketNotFound)?
            .load()
            .or(Err(ErrorCode::UnableToLoadMarketAccount))
    }

    pub fn get_ref_mut(&self, market_index: &u64) -> ClearingHouseResult<RefMut<Market>> {
        self.0
            .get(market_index)
            .ok_or(ErrorCode::MarketNotFound)?
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadMarketAccount))
    }

    pub fn load<'b, 'c>(
        writable_markets: &'b WritableMarkets,
        account_info_iter: &'c mut Peekable<Iter<AccountInfo<'a>>>,
    ) -> ClearingHouseResult<MarketMap<'a>> {
        let mut market_map: MarketMap = MarketMap(BTreeMap::new());

        let market_discriminator: [u8; 8] = Market::discriminator();
        while let Some(account_info) = account_info_iter.peek() {
            let data = account_info
                .try_borrow_data()
                .or(Err(ErrorCode::CouldNotLoadMarketData))?;

            if data.len() < std::mem::size_of::<Market>() + 8 {
                break;
            }

            let account_discriminator = array_ref![data, 0, 8];
            if account_discriminator != &market_discriminator {
                break;
            }
            let market_index = u64::from_le_bytes(*array_ref![data, 8, 8]);
            let is_initialized = array_ref![data, 48, 1];

            let account_info = account_info_iter.next().unwrap();
            let is_writable = account_info.is_writable;
            let account_loader: AccountLoader<Market> =
                AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidMarketAccount))?;

            if writable_markets.contains(&market_index) && !is_writable {
                return Err(ErrorCode::MarketWrongMutability);
            }

            if is_initialized != &[1] {
                return Err(ErrorCode::MarketIndexNotInitialized);
            }

            market_map.0.insert(market_index, account_loader);
        }

        Ok(market_map)
    }
}

pub type WritableMarkets = BTreeSet<u64>;

pub fn get_writable_markets(market_index: u64) -> WritableMarkets {
    let mut writable_markets = WritableMarkets::new();
    writable_markets.insert(market_index);
    writable_markets
}

pub fn get_writable_markets_list(market_indexes: [u64; 5]) -> WritableMarkets {
    let mut writable_markets = WritableMarkets::new();
    for market_index in market_indexes.iter() {
        if *market_index == 100 {
            continue; // todo
        }
        writable_markets.insert(*market_index);
    }
    writable_markets
}

pub fn get_writable_markets_for_user_positions(user_positions: &UserPositions) -> WritableMarkets {
    let mut writable_markets = WritableMarkets::new();
    for position in user_positions.iter() {
        writable_markets.insert(position.market_index);
    }
    writable_markets
}

pub fn get_writable_markets_for_user_positions_and_order(
    user_positions: &UserPositions,
    market_index: u64,
) -> WritableMarkets {
    let mut writable_markets = WritableMarkets::new();
    for position in user_positions.iter() {
        writable_markets.insert(position.market_index);
    }
    writable_markets.insert(market_index);

    writable_markets
}
