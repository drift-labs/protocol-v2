use crate::error::{ClearingHouseResult, ErrorCode};
use crate::state::market::Market2;
use anchor_lang::prelude::{AccountInfo, AccountLoader};
use anchor_lang::Discriminator;
use arrayref::array_ref;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

pub type WritableMarkets = BTreeSet<u64>;

pub type MarketMap<'a> = BTreeMap<u64, AccountLoader<'a, Market2>>;

pub fn get_market_map<'a, 'b, 'c>(
    account_info_map: &'a WritableMarkets,
    account_infos: &'b [AccountInfo<'c>],
) -> ClearingHouseResult<MarketMap<'c>> {
    let mut market_map: BTreeMap<u64, AccountLoader<Market2>> = BTreeMap::new();

    let account_info_iter = &mut account_infos.iter().peekable();

    let market_discriminator: [u8; 8] = Market2::discriminator();
    while let Some(account_info) = account_info_iter.peek() {
        let data = account_info
            .try_borrow_data()
            .or(Err(ErrorCode::CouldNotLoadMarketData))?;

        if data.len() < market_discriminator.len() {
            break;
        }

        let account_discriminator = array_ref![data, 0, 8];
        if account_discriminator != &market_discriminator {
            break;
        }

        let market_index = u64::from_le_bytes(*array_ref![data, 8, 8]);

        let account_info = account_info_iter.next().unwrap();
        let is_writable = account_info.is_writable;
        let account_loader: AccountLoader<Market2> =
            AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidMarketAccount))?;

        if account_info_map.contains(&market_index) && !is_writable {
            return Err(ErrorCode::MarketWrongMutability);
        }

        market_map.insert(market_index, account_loader);
    }

    Ok(market_map)
}
