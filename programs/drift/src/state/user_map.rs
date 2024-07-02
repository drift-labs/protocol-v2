use crate::error::{DriftResult, ErrorCode};
use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::traits::Size;
use crate::state::user::{User, UserStats};
use crate::validate;
use anchor_lang::prelude::AccountLoader;
use anchor_lang::Discriminator;
use arrayref::array_ref;
use solana_program::account_info::AccountInfo;
use solana_program::msg;
use solana_program::pubkey::Pubkey;
use std::cell::{Ref, RefMut};
use std::collections::BTreeMap;
use std::convert::TryFrom;
use std::iter::Peekable;
use std::panic::Location;
use std::slice::Iter;

pub struct UserMap<'a>(pub BTreeMap<Pubkey, AccountLoader<'a, User>>);

impl<'a> UserMap<'a> {
    #[track_caller]
    #[inline(always)]
    pub fn get_ref(&self, user: &Pubkey) -> DriftResult<Ref<User>> {
        let loader = match self.0.get(user) {
            Some(loader) => loader,
            None => {
                let caller = Location::caller();
                msg!(
                    "Could not find user {} at {}:{}",
                    user,
                    caller.file(),
                    caller.line()
                );
                return Err(ErrorCode::UserNotFound);
            }
        };

        match loader.load() {
            Ok(user) => Ok(user),
            Err(e) => {
                let caller = Location::caller();
                msg!("{:?}", e);
                msg!(
                    "Could not load user {} at {}:{}",
                    user,
                    caller.file(),
                    caller.line()
                );
                Err(ErrorCode::UnableToLoadUserAccount)
            }
        }
    }

    #[track_caller]
    #[inline(always)]
    pub fn get_ref_mut(&self, user: &Pubkey) -> DriftResult<RefMut<User>> {
        let loader = match self.0.get(user) {
            Some(loader) => loader,
            None => {
                let caller = Location::caller();
                msg!(
                    "Could not find user {} at {}:{}",
                    user,
                    caller.file(),
                    caller.line()
                );
                return Err(ErrorCode::UserNotFound);
            }
        };

        match loader.load_mut() {
            Ok(user) => Ok(user),
            Err(e) => {
                let caller = Location::caller();
                msg!("{:?}", e);
                msg!(
                    "Could not load user {} at {}:{}",
                    user,
                    caller.file(),
                    caller.line()
                );
                Err(ErrorCode::UnableToLoadUserAccount)
            }
        }
    }

    pub fn insert(&mut self, user: Pubkey, account_loader: AccountLoader<'a, User>) -> DriftResult {
        validate!(
            !self.0.contains_key(&user),
            ErrorCode::InvalidUserAccount,
            "User already exists in map {:?}",
            user
        )?;

        self.0.insert(user, account_loader);

        Ok(())
    }

    pub fn empty() -> UserMap<'a> {
        UserMap(BTreeMap::new())
    }
}

#[cfg(test)]
impl<'a> UserMap<'a> {
    pub fn load_one<'b: 'a>(account_info: &'b AccountInfo<'a>) -> DriftResult<UserMap<'a>> {
        let mut user_map = UserMap(BTreeMap::new());

        let user_discriminator: [u8; 8] = User::discriminator();

        let user_key = account_info.key;

        let data = account_info
            .try_borrow_data()
            .or(Err(ErrorCode::CouldNotLoadUserData))?;

        let expected_data_len = User::SIZE;
        if data.len() < expected_data_len {
            return Err(ErrorCode::CouldNotLoadUserData);
        }

        let account_discriminator = array_ref![data, 0, 8];
        if account_discriminator != &user_discriminator {
            return Err(ErrorCode::CouldNotLoadUserData);
        }

        let is_writable = account_info.is_writable;
        if !is_writable {
            return Err(ErrorCode::UserWrongMutability);
        }

        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidUserAccount))?;

        user_map.insert(*user_key, user_account_loader)?;

        Ok(user_map)
    }
}

pub struct UserStatsMap<'a>(pub BTreeMap<Pubkey, AccountLoader<'a, UserStats>>);

impl<'a> UserStatsMap<'a> {
    #[track_caller]
    #[inline(always)]
    pub fn get_ref(&self, authority: &Pubkey) -> DriftResult<Ref<UserStats>> {
        let loader = match self.0.get(authority) {
            Some(loader) => loader,
            None => {
                let caller = Location::caller();
                msg!(
                    "Could not find user stats {} at {}:{}",
                    authority,
                    caller.file(),
                    caller.line()
                );
                return Err(ErrorCode::UserStatsNotFound);
            }
        };

        match loader.load() {
            Ok(user_stats) => Ok(user_stats),
            Err(e) => {
                let caller = Location::caller();
                msg!("{:?}", e);
                msg!(
                    "Could not user stats {} at {}:{}",
                    authority,
                    caller.file(),
                    caller.line()
                );
                Err(ErrorCode::UnableToLoadUserStatsAccount)
            }
        }
    }

    #[track_caller]
    #[inline(always)]
    pub fn get_ref_mut(&self, authority: &Pubkey) -> DriftResult<RefMut<UserStats>> {
        let loader = match self.0.get(authority) {
            Some(loader) => loader,
            None => {
                let caller = Location::caller();
                msg!(
                    "Could not find user stats {} at {}:{}",
                    authority,
                    caller.file(),
                    caller.line()
                );
                return Err(ErrorCode::UserStatsNotFound);
            }
        };

        match loader.load_mut() {
            Ok(perp_market) => Ok(perp_market),
            Err(e) => {
                let caller = Location::caller();
                msg!("{:?}", e);
                msg!(
                    "Could not user stats {} at {}:{}",
                    authority,
                    caller.file(),
                    caller.line()
                );
                Err(ErrorCode::UnableToLoadUserStatsAccount)
            }
        }
    }

    pub fn insert(
        &mut self,
        authority: Pubkey,
        account_loader: AccountLoader<'a, UserStats>,
    ) -> DriftResult {
        validate!(
            !self.0.contains_key(&authority),
            ErrorCode::InvalidUserStatsAccount,
            "User stats already exists in map {:?}",
            authority
        )?;

        self.0.insert(authority, account_loader);

        Ok(())
    }

    pub fn empty() -> UserStatsMap<'a> {
        UserStatsMap(BTreeMap::new())
    }
}

#[cfg(test)]
impl<'a> UserStatsMap<'a> {
    pub fn load_one<'b: 'a>(account_info: &'b AccountInfo<'a>) -> DriftResult<UserStatsMap<'a>> {
        let mut user_stats_map = UserStatsMap(BTreeMap::new());

        let user_stats_discriminator: [u8; 8] = UserStats::discriminator();

        let _user_stats_key = account_info.key;

        let data = account_info
            .try_borrow_data()
            .or(Err(ErrorCode::CouldNotLoadUserStatsData))?;

        let expected_data_len = UserStats::SIZE;
        if data.len() < expected_data_len {
            return Err(ErrorCode::DefaultError);
        }

        let account_discriminator = array_ref![data, 0, 8];
        if account_discriminator != &user_stats_discriminator {
            return Err(ErrorCode::DefaultError);
        }

        let authority_slice = array_ref![data, 8, 32];
        let authority = Pubkey::from(*authority_slice);

        let is_writable = account_info.is_writable;
        if !is_writable {
            return Err(ErrorCode::UserStatsWrongMutability);
        }

        let user_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidUserStatsAccount))?;

        user_stats_map
            .0
            .insert(authority, user_stats_account_loader);

        Ok(user_stats_map)
    }
}

pub fn load_user_maps<'a: 'b, 'b>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'b>>>,
    must_be_writable: bool,
) -> DriftResult<(UserMap<'b>, UserStatsMap<'b>)> {
    let mut user_map = UserMap::empty();
    let mut user_stats_map = UserStatsMap::empty();

    let user_discriminator: [u8; 8] = User::discriminator();
    let user_stats_discriminator: [u8; 8] = UserStats::discriminator();
    while let Some(user_account_info) = account_info_iter.peek() {
        let user_key = user_account_info.key;

        let data = user_account_info
            .try_borrow_data()
            .or(Err(ErrorCode::CouldNotLoadUserData))?;

        let expected_data_len = User::SIZE;
        if data.len() < expected_data_len {
            break;
        }

        let account_discriminator = array_ref![data, 0, 8];
        if account_discriminator != &user_discriminator {
            break;
        }

        let user_account_info = account_info_iter.next().safe_unwrap()?;

        let is_writable = user_account_info.is_writable;
        if !is_writable && must_be_writable {
            return Err(ErrorCode::UserWrongMutability);
        }

        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(user_account_info).or(Err(ErrorCode::InvalidUserAccount))?;

        user_map.0.insert(*user_key, user_account_loader);

        validate!(
            account_info_iter.peek().is_some(),
            ErrorCode::UserStatsNotFound
        )?;

        let user_stats_account_info = account_info_iter.peek().safe_unwrap()?;

        let data = user_stats_account_info
            .try_borrow_data()
            .or(Err(ErrorCode::CouldNotLoadUserStatsData))?;

        let expected_data_len = UserStats::SIZE;
        if data.len() < expected_data_len {
            return Err(ErrorCode::InvalidUserStatsAccount);
        }

        let account_discriminator = array_ref![data, 0, 8];
        if account_discriminator != &user_stats_discriminator {
            return Err(ErrorCode::InvalidUserStatsAccount);
        }

        let authority_slice = array_ref![data, 8, 32];
        let authority = Pubkey::try_from(*authority_slice).safe_unwrap()?;

        let user_stats_account_info = account_info_iter.next().safe_unwrap()?;

        if user_stats_map.0.contains_key(&authority) {
            continue;
        }

        let is_writable = user_stats_account_info.is_writable;
        if !is_writable && must_be_writable {
            return Err(ErrorCode::UserStatsWrongMutability);
        }

        let user_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(user_stats_account_info)
                .or(Err(ErrorCode::InvalidUserStatsAccount))?;

        user_stats_map.insert(authority, user_stats_account_loader)?;
    }

    Ok((user_map, user_stats_map))
}

pub fn load_user_map<'a: 'b, 'b>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'b>>>,
    must_be_writable: bool,
) -> DriftResult<(UserMap<'b>, UserStatsMap<'b>)> {
    let mut user_map = UserMap::empty();

    let user_discriminator: [u8; 8] = User::discriminator();
    let user_stats_discriminator: [u8; 8] = UserStats::discriminator();
    while let Some(user_account_info) = account_info_iter.peek() {
        let user_key = user_account_info.key;

        let data = user_account_info
            .try_borrow_data()
            .or(Err(ErrorCode::CouldNotLoadUserData))?;

        let expected_user_data_len = User::SIZE;
        let expected_user_stats_len = UserStats::SIZE;
        if data.len() < expected_user_data_len && data.len() < expected_user_stats_len {
            break;
        }

        let account_discriminator = array_ref![data, 0, 8];

        // if it is user stats, for backwards compatability, just move iter forward
        if account_discriminator == &user_stats_discriminator {
            account_info_iter.next().safe_unwrap()?;
            continue;
        }

        if account_discriminator != &user_discriminator {
            break;
        }

        let user_account_info = account_info_iter.next().safe_unwrap()?;

        let is_writable = user_account_info.is_writable;
        if !is_writable && must_be_writable {
            return Err(ErrorCode::UserWrongMutability);
        }

        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(user_account_info).or(Err(ErrorCode::InvalidUserAccount))?;

        user_map.0.insert(*user_key, user_account_loader);
    }

    Ok((user_map, user_stats_map))
}
