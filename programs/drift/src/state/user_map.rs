use crate::error::{DriftResult, ErrorCode};
use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::traits::Size;
use crate::state::user::{User, UserStats};
use anchor_lang::prelude::AccountLoader;
use anchor_lang::Discriminator;
use arrayref::array_ref;
use solana_program::account_info::AccountInfo;
use solana_program::msg;
use solana_program::pubkey::Pubkey;
use std::cell::RefMut;
use std::collections::BTreeMap;
use std::iter::Peekable;
use std::panic::Location;
use std::slice::Iter;

pub struct UserMap<'a, 'b>(
    pub BTreeMap<Pubkey, AccountLoader<'a, User>>,
    pub Option<(Pubkey, AccountLoader<'b, User>, u32)>,
);

impl<'a, 'b> UserMap<'a, 'b> {
    // #[track_caller]
    // #[inline(always)]
    // pub fn get_ref(&self, market_index: &u16) -> DriftResult<Ref<PerpMarket>> {
    //     let loader = match self.0.get(market_index) {
    //         Some(loader) => loader,
    //         None => {
    //             let caller = Location::caller();
    //             msg!(
    //                 "Could not find perp market {} at {}:{}",
    //                 market_index,
    //                 caller.file(),
    //                 caller.line()
    //             );
    //             return Err(ErrorCode::PerpMarketNotFound);
    //         }
    //     };
    //
    //     match loader.load() {
    //         Ok(perp_market) => Ok(perp_market),
    //         Err(e) => {
    //             let caller = Location::caller();
    //             msg!("{:?}", e);
    //             msg!(
    //                 "Could not load perp market {} at {}:{}",
    //                 market_index,
    //                 caller.file(),
    //                 caller.line()
    //             );
    //             Err(ErrorCode::UnableToLoadPerpMarketAccount)
    //         }
    //     }
    // }
    //
    #[track_caller]
    #[inline(always)]
    pub fn get_ref_mut(&self, user: &Pubkey) -> DriftResult<RefMut<User>> {
        if let Some((jit_user, loader, _)) = &self.1 {
            if jit_user == user {
                return match loader.load_mut() {
                    Ok(user) => Ok(user),
                    Err(e) => {
                        let caller = Location::caller();
                        msg!("{:?}", e);
                        msg!(
                            "Could not user {} at {}:{}",
                            user,
                            caller.file(),
                            caller.line()
                        );
                        Err(ErrorCode::UnableToLoadUserAccount)
                    }
                };
            }
        }

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
                return Err(ErrorCode::PerpMarketNotFound);
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

    pub fn load<'c>(
        account_info_iter: &'c mut Peekable<Iter<AccountInfo<'a>>>,
        jit_maker: Option<(Pubkey, AccountLoader<'b, User>, u32)>,
    ) -> DriftResult<UserMap<'a, 'b>> {
        let mut user_map = UserMap(BTreeMap::new(), jit_maker);

        let user_discriminator: [u8; 8] = User::discriminator();
        while let Some(account_info) = account_info_iter.peek() {
            let user_key = account_info.key;

            let data = account_info
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
            if !is_writable {
                return Err(ErrorCode::UserWrongMutability);
            }

            let user_account_loader: AccountLoader<User> =
                AccountLoader::try_from(user_account_info)
                    .or(Err(ErrorCode::InvalidUserAccount))?;

            user_map.0.insert(*user_key, user_account_loader);
        }

        Ok(user_map)
    }
}

pub struct UserStatsMap<'a, 'b>(
    pub BTreeMap<Pubkey, AccountLoader<'a, UserStats>>,
    pub Option<(Pubkey, AccountLoader<'b, UserStats>)>,
);

impl<'a> UserStatsMap<'a, '_> {
    // #[track_caller]
    // #[inline(always)]
    // pub fn get_ref(&self, market_index: &u16) -> DriftResult<Ref<PerpMarket>> {
    //     let loader = match self.0.get(market_index) {
    //         Some(loader) => loader,
    //         None => {
    //             let caller = Location::caller();
    //             msg!(
    //                 "Could not find perp market {} at {}:{}",
    //                 market_index,
    //                 caller.file(),
    //                 caller.line()
    //             );
    //             return Err(ErrorCode::PerpMarketNotFound);
    //         }
    //     };
    //
    //     match loader.load() {
    //         Ok(perp_market) => Ok(perp_market),
    //         Err(e) => {
    //             let caller = Location::caller();
    //             msg!("{:?}", e);
    //             msg!(
    //                 "Could not load perp market {} at {}:{}",
    //                 market_index,
    //                 caller.file(),
    //                 caller.line()
    //             );
    //             Err(ErrorCode::UnableToLoadPerpMarketAccount)
    //         }
    //     }
    // }
    //
    #[track_caller]
    #[inline(always)]
    pub fn get_ref_mut(&self, authority: &Pubkey) -> DriftResult<RefMut<UserStats>> {
        if let Some((jit_authority, loader)) = &self.1 {
            if jit_authority == authority {
                return match loader.load_mut() {
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
                };
            }
        }

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

    pub fn load<'b, 'c>(
        account_info_iter: &'c mut Peekable<Iter<AccountInfo<'a>>>,
        jit_maker_stats: Option<(Pubkey, AccountLoader<'b, UserStats>)>,
    ) -> DriftResult<UserStatsMap<'a, 'b>> {
        let mut user_stats_map = UserStatsMap(BTreeMap::new(), jit_maker_stats);

        let user_stats_discriminator: [u8; 8] = UserStats::discriminator();
        while let Some(account_info) = account_info_iter.peek() {
            let user_stats_key = account_info.key;

            let data = account_info
                .try_borrow_data()
                .or(Err(ErrorCode::CouldNotLoadUserStatsData))?;

            let expected_data_len = UserStats::SIZE;
            if data.len() < expected_data_len {
                break;
            }

            let account_discriminator = array_ref![data, 0, 8];
            if account_discriminator != &user_stats_discriminator {
                break;
            }

            let authority_slice = array_ref![data, 8, 32];
            let authority = Pubkey::new(authority_slice);

            let user_stats_account_info = account_info_iter.next().safe_unwrap()?;

            let is_writable = user_stats_account_info.is_writable;
            if !is_writable {
                return Err(ErrorCode::UserStatsWrongMutability);
            }

            let user_stats_account_loader: AccountLoader<UserStats> =
                AccountLoader::try_from(user_stats_account_info)
                    .or(Err(ErrorCode::InvalidUserStatsAccount))?;

            user_stats_map
                .0
                .insert(authority, user_stats_account_loader);
        }

        Ok(user_stats_map)
    }
}
