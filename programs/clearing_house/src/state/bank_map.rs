use crate::error::{ClearingHouseResult, ErrorCode};
use crate::state::bank::Bank;
use anchor_lang::prelude::{AccountInfo, AccountLoader};
use std::cell::{Ref, RefMut};
use std::collections::{BTreeMap, BTreeSet};

use std::iter::Peekable;
use std::slice::Iter;

use crate::math::constants::QUOTE_ASSET_BANK_INDEX;
use anchor_lang::Discriminator;
use arrayref::array_ref;

pub struct BankMap<'a>(pub BTreeMap<u64, AccountLoader<'a, Bank>>);

impl<'a> BankMap<'a> {
    pub fn get_ref(&self, bank_index: &u64) -> ClearingHouseResult<Ref<Bank>> {
        self.0
            .get(bank_index)
            .ok_or(ErrorCode::BankNotFound)?
            .load()
            .or(Err(ErrorCode::UnableToLoadBankAccount))
    }

    pub fn get_ref_mut(&self, bank_index: &u64) -> ClearingHouseResult<RefMut<Bank>> {
        self.0
            .get(bank_index)
            .ok_or(ErrorCode::BankNotFound)?
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadBankAccount))
    }

    pub fn get_quote_asset_bank(&self) -> ClearingHouseResult<Ref<Bank>> {
        self.get_ref(&QUOTE_ASSET_BANK_INDEX)
    }

    pub fn get_quote_asset_bank_mut(&self) -> ClearingHouseResult<RefMut<Bank>> {
        self.get_ref_mut(&QUOTE_ASSET_BANK_INDEX)
    }

    pub fn load<'b, 'c>(
        writable_banks: &'b WritableBanks,
        account_info_iter: &'c mut Peekable<Iter<AccountInfo<'a>>>,
    ) -> ClearingHouseResult<BankMap<'a>> {
        let mut bank_map: BankMap = BankMap(BTreeMap::new());

        let bank_discriminator: [u8; 8] = Bank::discriminator();
        while let Some(account_info) = account_info_iter.peek() {
            let data = account_info
                .try_borrow_data()
                .or(Err(ErrorCode::CouldNotLoadBankData))?;

            if data.len() < std::mem::size_of::<Bank>() + 8 {
                break;
            }

            let account_discriminator = array_ref![data, 0, 8];
            if account_discriminator != &bank_discriminator {
                break;
            }

            let bank_index = u64::from_le_bytes(*array_ref![data, 8, 8]);

            let account_info = account_info_iter.next().unwrap();
            let is_writable = account_info.is_writable;
            let account_loader: AccountLoader<Bank> =
                AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidBankAccount))?;

            if writable_banks.contains(&bank_index) && !is_writable {
                return Err(ErrorCode::BankWrongMutability);
            }

            bank_map.0.insert(bank_index, account_loader);
        }

        Ok(bank_map)
    }
}

#[cfg(test)]
impl<'a> BankMap<'a> {
    pub fn load_one<'c>(
        account_info: &'c AccountInfo<'a>,
        must_be_writable: bool,
    ) -> ClearingHouseResult<BankMap<'a>> {
        let mut bank_map: BankMap = BankMap(BTreeMap::new());

        let bank_discriminator: [u8; 8] = Bank::discriminator();
        let data = account_info
            .try_borrow_data()
            .or(Err(ErrorCode::CouldNotLoadBankData))?;

        if data.len() < std::mem::size_of::<Bank>() + 8 {
            return Err(ErrorCode::CouldNotLoadBankData);
        }

        let account_discriminator = array_ref![data, 0, 8];
        if account_discriminator != &bank_discriminator {
            return Err(ErrorCode::CouldNotLoadBankData);
        }

        let bank_index = u64::from_le_bytes(*array_ref![data, 8, 8]);
        let is_writable = account_info.is_writable;
        let account_loader: AccountLoader<Bank> =
            AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidBankAccount))?;

        if must_be_writable && !is_writable {
            return Err(ErrorCode::BankWrongMutability);
        }

        bank_map.0.insert(bank_index, account_loader);

        Ok(bank_map)
    }
}

pub type WritableBanks = BTreeSet<u64>;

pub fn get_writable_banks(bank_index: u64) -> WritableBanks {
    let mut writable_markets = WritableBanks::new();
    writable_markets.insert(bank_index);
    writable_markets
}
