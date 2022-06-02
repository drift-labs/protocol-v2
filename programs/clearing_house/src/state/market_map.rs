use std::cell::{Ref, RefMut};
use std::collections::{BTreeMap, BTreeSet};
use std::iter::Peekable;
use std::slice::Iter;

use anchor_lang::accounts::account_loader::AccountLoader;
use anchor_lang::prelude::{AccountInfo, Pubkey};

use anchor_lang::Discriminator;
use arrayref::array_ref;

use crate::error::{ClearingHouseResult, ErrorCode};
use crate::state::market::Market;
use crate::state::user::UserPositions;

pub struct MarketMap<'a>(pub BTreeMap<u64, AccountLoader<'a, Market>>);

impl MarketMap<'_> {
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

    pub fn load<'a, 'b, 'c>(
        writable_markets: &'a WritableMarkets,
        market_oracles: &MarketOracles,
        account_info_iter: &'b mut Peekable<Iter<AccountInfo<'c>>>,
    ) -> ClearingHouseResult<MarketMap<'c>> {
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
            let market_oracle = Pubkey::new(array_ref![data, 49, 32]);

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

            if let Some(oracle_account_info) = market_oracles.get(&market_index) {
                if !oracle_account_info.key.eq(&market_oracle) {
                    return Err(ErrorCode::InvalidOracle);
                }
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

pub fn get_writable_markets_for_user_positions(user_positions: &UserPositions) -> WritableMarkets {
    let mut writable_markets = WritableMarkets::new();
    for position in user_positions.positions.iter() {
        writable_markets.insert(position.market_index);
    }
    writable_markets
}

pub type MarketOracles<'a, 'b> = BTreeMap<u64, &'a AccountInfo<'b>>;

pub fn get_market_oracles<'a, 'b>(
    market_index: u64,
    oracle: &'a AccountInfo<'b>,
) -> MarketOracles<'a, 'b> {
    let mut market_oracles = MarketOracles::new();
    market_oracles.insert(market_index, oracle);
    market_oracles
}
