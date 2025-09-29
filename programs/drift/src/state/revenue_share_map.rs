use crate::error::{DriftResult, ErrorCode};
use crate::math::safe_unwrap::SafeUnwrap;
use crate::msg;
use crate::state::revenue_share::RevenueShare;
use crate::state::traits::Size;
use crate::state::user::User;
use crate::validate;
use anchor_lang::prelude::AccountLoader;
use anchor_lang::Discriminator;
use arrayref::array_ref;
use solana_program::account_info::AccountInfo;
use solana_program::pubkey::Pubkey;
use std::cell::RefMut;
use std::collections::BTreeMap;
use std::iter::Peekable;
use std::panic::Location;
use std::slice::Iter;

pub struct RevenueShareEntry<'a> {
    pub user: Option<AccountLoader<'a, User>>,
    pub revenue_share: Option<AccountLoader<'a, RevenueShare>>,
}

impl<'a> Default for RevenueShareEntry<'a> {
    fn default() -> Self {
        Self {
            user: None,
            revenue_share: None,
        }
    }
}

pub struct RevenueShareMap<'a>(pub BTreeMap<Pubkey, RevenueShareEntry<'a>>);

impl<'a> RevenueShareMap<'a> {
    pub fn empty() -> Self {
        RevenueShareMap(BTreeMap::new())
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

    pub fn insert_revenue_share(
        &mut self,
        authority: Pubkey,
        revenue_share_loader: AccountLoader<'a, RevenueShare>,
    ) -> DriftResult {
        let entry = self.0.entry(authority).or_default();
        validate!(
            entry.revenue_share.is_none(),
            ErrorCode::DefaultError,
            "Duplicate RevenueShare for authority {:?}",
            authority
        )?;
        entry.revenue_share = Some(revenue_share_loader);
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
    pub fn get_revenue_share_account_mut(
        &self,
        authority: &Pubkey,
    ) -> DriftResult<RefMut<RevenueShare>> {
        let loader = match self.0.get(authority).and_then(|e| e.revenue_share.as_ref()) {
            Some(loader) => loader,
            None => {
                let caller = Location::caller();
                msg!(
                    "Could not find revenue share for authority {} at {}:{}",
                    authority,
                    caller.file(),
                    caller.line()
                );
                return Err(ErrorCode::UnableToLoadRevenueShareAccount);
            }
        };

        match loader.load_mut() {
            Ok(revenue_share) => Ok(revenue_share),
            Err(e) => {
                let caller = Location::caller();
                msg!("{:?}", e);
                msg!(
                    "Could not load revenue share for authority {} at {}:{}",
                    authority,
                    caller.file(),
                    caller.line()
                );
                Err(ErrorCode::UnableToLoadRevenueShareAccount)
            }
        }
    }
}

pub fn load_revenue_share_map<'a: 'b, 'b>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'b>>>,
) -> DriftResult<RevenueShareMap<'b>> {
    let mut revenue_share_map = RevenueShareMap::empty();

    let user_discriminator: [u8; 8] = User::discriminator();
    let rev_share_discriminator: [u8; 8] = RevenueShare::discriminator();

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

            revenue_share_map.insert_user(authority, user_account_loader)?;
            continue;
        }

        if account_discriminator == &rev_share_discriminator {
            let revenue_share_account_info = account_info_iter.next().safe_unwrap()?;
            let is_writable = revenue_share_account_info.is_writable;
            if !is_writable {
                return Err(ErrorCode::DefaultError);
            }

            let authority_slice = array_ref![data, 8, 32];
            let authority = Pubkey::from(*authority_slice);

            let revenue_share_account_loader: AccountLoader<RevenueShare> =
                AccountLoader::try_from(revenue_share_account_info)
                    .or(Err(ErrorCode::InvalidRevenueShareAccount))?;

            revenue_share_map.insert_revenue_share(authority, revenue_share_account_loader)?;
            continue;
        }

        break;
    }

    Ok(revenue_share_map)
}
