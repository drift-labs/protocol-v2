use anchor_lang::accounts::account_loader::AccountLoader;
use std::cell::{Ref, RefMut};
use std::collections::{BTreeMap, BTreeSet};
use std::iter::Peekable;
use std::slice::Iter;

use anchor_lang::prelude::{AccountInfo, Pubkey};

use anchor_lang::Discriminator;
use arrayref::array_ref;

use crate::error::{DriftResult, ErrorCode};

use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::traits::Size;
use crate::{msg, validate};
use std::panic::Location;

use super::lp_pool::Constituent;

pub struct ConstituentMap<'a>(pub BTreeMap<u16, AccountLoader<'a, Constituent>>);

impl<'a> ConstituentMap<'a> {
    #[track_caller]
    #[inline(always)]
    pub fn get_ref(&self, constituent_index: &u16) -> DriftResult<Ref<Constituent>> {
        let loader = match self.0.get(constituent_index) {
            Some(loader) => loader,
            None => {
                let caller = Location::caller();
                msg!(
                    "Could not find constituent {} at {}:{}",
                    constituent_index,
                    caller.file(),
                    caller.line()
                );
                return Err(ErrorCode::ConstituentNotFound);
            }
        };

        match loader.load() {
            Ok(constituent) => Ok(constituent),
            Err(e) => {
                let caller = Location::caller();
                msg!("{:?}", e);
                msg!(
                    "Could not load constituent {} at {}:{}",
                    constituent_index,
                    caller.file(),
                    caller.line()
                );
                Err(ErrorCode::ConstituentCouldNotLoad)
            }
        }
    }

    #[track_caller]
    #[inline(always)]
    pub fn get_ref_mut(&self, market_index: &u16) -> DriftResult<RefMut<Constituent>> {
        let loader = match self.0.get(market_index) {
            Some(loader) => loader,
            None => {
                let caller = Location::caller();
                msg!(
                    "Could not find constituent {} at {}:{}",
                    market_index,
                    caller.file(),
                    caller.line()
                );
                return Err(ErrorCode::ConstituentNotFound);
            }
        };

        match loader.load_mut() {
            Ok(perp_market) => Ok(perp_market),
            Err(e) => {
                let caller = Location::caller();
                msg!("{:?}", e);
                msg!(
                    "Could not load constituent {} at {}:{}",
                    market_index,
                    caller.file(),
                    caller.line()
                );
                Err(ErrorCode::ConstituentCouldNotLoad)
            }
        }
    }

    pub fn load<'b, 'c>(
        writable_constituents: &'b ConstituentSet,
        lp_pool_key: &Pubkey,
        account_info_iter: &'c mut Peekable<Iter<'a, AccountInfo<'a>>>,
    ) -> DriftResult<ConstituentMap<'a>> {
        let mut constituent_map: ConstituentMap = ConstituentMap(BTreeMap::new());

        let constituent_discriminator: [u8; 8] = Constituent::discriminator();
        while let Some(account_info) = account_info_iter.peek() {
            if account_info.owner != &crate::ID {
                break;
            }

            let data = account_info
                .try_borrow_data()
                .or(Err(ErrorCode::ConstituentCouldNotLoad))?;

            let expected_data_len = Constituent::SIZE;
            if data.len() < expected_data_len {
                msg!(
                    "didnt match constituent size, {}, {}",
                    data.len(),
                    expected_data_len
                );
                break;
            }

            let account_discriminator = array_ref![data, 0, 8];
            if account_discriminator != &constituent_discriminator {
                msg!(
                    "didnt match account discriminator {:?}, {:?}",
                    account_discriminator,
                    constituent_discriminator
                );
                break;
            }

            // Pubkey
            let constituent_lp_key = Pubkey::from(*array_ref![data, 72, 32]);
            validate!(
                &constituent_lp_key == lp_pool_key,
                ErrorCode::InvalidConstituent,
                "Constituent lp pool pubkey does not match lp pool pubkey"
            )?;

            // constituent index 276 bytes from front of account
            let constituent_index = u16::from_le_bytes(*array_ref![data, 284, 2]);
            if constituent_map.0.contains_key(&constituent_index) {
                msg!(
                    "Can not include same constituent index twice {}",
                    constituent_index
                );
                return Err(ErrorCode::InvalidConstituent);
            }

            let account_info = account_info_iter.next().safe_unwrap()?;

            let is_writable = account_info.is_writable;
            if writable_constituents.contains(&constituent_index) && !is_writable {
                return Err(ErrorCode::ConstituentWrongMutability);
            }

            let account_loader: AccountLoader<Constituent> = AccountLoader::try_from(account_info)
                .or(Err(ErrorCode::ConstituentCouldNotLoad))?;

            constituent_map.0.insert(constituent_index, account_loader);
        }

        Ok(constituent_map)
    }
}

#[cfg(test)]
impl<'a> ConstituentMap<'a> {
    pub fn load_one<'c: 'a>(
        account_info: &'c AccountInfo<'a>,
        must_be_writable: bool,
    ) -> DriftResult<ConstituentMap<'a>> {
        let mut constituent_map: ConstituentMap = ConstituentMap(BTreeMap::new());

        let data = account_info
            .try_borrow_data()
            .or(Err(ErrorCode::ConstituentCouldNotLoad))?;

        let expected_data_len = Constituent::SIZE;
        if data.len() < expected_data_len {
            return Err(ErrorCode::ConstituentCouldNotLoad);
        }

        let constituent_discriminator: [u8; 8] = Constituent::discriminator();
        let account_discriminator = array_ref![data, 0, 8];
        if account_discriminator != &constituent_discriminator {
            return Err(ErrorCode::ConstituentCouldNotLoad);
        }

        // market index 1160 bytes from front of account
        let constituent_index = u16::from_le_bytes(*array_ref![data, 42, 2]);

        let is_writable = account_info.is_writable;
        let account_loader: AccountLoader<Constituent> =
            AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidMarketAccount))?;

        if must_be_writable && !is_writable {
            return Err(ErrorCode::ConstituentWrongMutability);
        }

        constituent_map.0.insert(constituent_index, account_loader);

        Ok(constituent_map)
    }

    pub fn empty() -> Self {
        ConstituentMap(BTreeMap::new())
    }
}

pub(crate) type ConstituentSet = BTreeSet<u16>;
