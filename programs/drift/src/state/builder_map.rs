use crate::error::{DriftResult, ErrorCode};
use crate::math::safe_unwrap::SafeUnwrap;
use crate::msg;
use crate::state::builder::Builder;
use crate::state::traits::Size;
use crate::state::user::User;
use crate::state::user_map::UserMap;
use crate::validate;
use anchor_lang::accounts::account::Account;
use anchor_lang::prelude::AccountLoader;
use anchor_lang::Discriminator;
use arrayref::array_ref;
use solana_program::account_info::AccountInfo;
use solana_program::pubkey::Pubkey;
use std::cell::{Ref, RefMut};
use std::collections::BTreeMap;
use std::iter::Peekable;
use std::panic::Location;
use std::slice::Iter;

pub struct BuilderEntry<'a> {
    pub user: Option<AccountLoader<'a, User>>,
    pub builder: Option<AccountLoader<'a, Builder>>,
}

impl<'a> Default for BuilderEntry<'a> {
    fn default() -> Self {
        Self {
            user: None,
            builder: None,
        }
    }
}

pub struct BuilderMap<'a>(pub BTreeMap<Pubkey, BuilderEntry<'a>>);

impl<'a> BuilderMap<'a> {
    pub fn empty() -> Self {
        BuilderMap(BTreeMap::new())
    }

    pub fn insert_user(
        &mut self,
        authority: Pubkey,
        user_loader: AccountLoader<'a, User>,
    ) -> DriftResult {
        let entry = self.0.entry(authority).or_default();
        validate!(
            entry.user.is_none(),
            ErrorCode::DefaultError,
            "Duplicate User for authority {:?}",
            authority
        )?;
        entry.user = Some(user_loader);
        Ok(())
    }

    pub fn insert_builder(
        &mut self,
        authority: Pubkey,
        builder_loader: AccountLoader<'a, Builder>,
    ) -> DriftResult {
        let entry = self.0.entry(authority).or_default();
        validate!(
            entry.builder.is_none(),
            ErrorCode::DefaultError,
            "Duplicate Builder for authority {:?}",
            authority
        )?;
        entry.builder = Some(builder_loader);
        Ok(())
    }

    #[track_caller]
    #[inline(always)]
    pub fn get_user_ref_mut(&self, authority: &Pubkey) -> DriftResult<RefMut<User>> {
        let loader = match self.0.get(authority).and_then(|e| e.user.as_ref()) {
            Some(loader) => loader,
            None => {
                let caller = Location::caller();
                msg!(
                    "Could not find user for authority {} at {}:{}",
                    authority,
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
                    "Could not load user for authority {} at {}:{}",
                    authority,
                    caller.file(),
                    caller.line()
                );
                Err(ErrorCode::UnableToLoadUserAccount)
            }
        }
    }

    #[track_caller]
    #[inline(always)]
    pub fn get_builder_account_mut(&self, authority: &Pubkey) -> DriftResult<RefMut<Builder>> {
        let loader = match self.0.get(authority).and_then(|e| e.builder.as_ref()) {
            Some(loader) => loader,
            None => {
                let caller = Location::caller();
                msg!(
                    "Could not find builder for authority {} at {}:{}",
                    authority,
                    caller.file(),
                    caller.line()
                );
                return Err(ErrorCode::DefaultError);
            }
        };

        match loader.load_mut() {
            Ok(builder) => Ok(builder),
            Err(e) => {
                let caller = Location::caller();
                msg!("{:?}", e);
                Err(ErrorCode::DefaultError)
            }
        }
    }
}

pub fn load_builder_map<'a: 'b, 'b>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'b>>>,
) -> DriftResult<BuilderMap<'b>> {
    let mut builder_map = BuilderMap::empty();

    let user_discriminator: [u8; 8] = User::discriminator();
    let builder_discriminator: [u8; 8] = Builder::discriminator();

    while let Some(account_info) = account_info_iter.peek() {
        let data = account_info
            .try_borrow_data()
            .or(Err(ErrorCode::DefaultError))?;

        if data.len() < 8 {
            break;
        }

        let account_discriminator = array_ref![data, 0, 8];

        if account_discriminator == &user_discriminator {
            let user_account_info = account_info_iter.next().safe_unwrap()?;
            let is_writable = user_account_info.is_writable;
            if !is_writable {
                return Err(ErrorCode::UserWrongMutability);
            }

            // Extract authority from User account data (after discriminator)
            let data = user_account_info
                .try_borrow_data()
                .or(Err(ErrorCode::CouldNotLoadUserData))?;
            let expected_data_len = User::SIZE;
            if data.len() < expected_data_len {
                return Err(ErrorCode::CouldNotLoadUserData);
            }
            let authority_slice = array_ref![data, 8, 32];
            let authority = Pubkey::from(*authority_slice);

            let user_account_loader: AccountLoader<User> =
                AccountLoader::try_from(user_account_info)
                    .or(Err(ErrorCode::InvalidUserAccount))?;

            builder_map.insert_user(authority, user_account_loader)?;
            continue;
        }

        if account_discriminator == &builder_discriminator {
            let builder_account_info = account_info_iter.next().safe_unwrap()?;
            let is_writable = builder_account_info.is_writable;
            if !is_writable {
                return Err(ErrorCode::DefaultError);
            }

            let authority_slice = array_ref![data, 8, 32];
            let authority = Pubkey::from(*authority_slice);

            let builder_account_loader: AccountLoader<Builder> =
                AccountLoader::try_from(builder_account_info)
                    .or(Err(ErrorCode::InvalidBuilderAccount))?;

            builder_map.insert_builder(authority, builder_account_loader)?;
            continue;
        }

        break;
    }

    Ok(builder_map)
}
