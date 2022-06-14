use crate::error::{ClearingHouseResult, ErrorCode};
use anchor_lang::prelude::AccountLoader;
use anchor_lang::{Owner, ZeroCopy};
use std::cell::{Ref, RefMut};

pub fn load<'a, T: ZeroCopy + Owner>(
    account_loader: &'a AccountLoader<T>,
) -> ClearingHouseResult<Ref<'a, T>> {
    account_loader
        .load()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))
}

pub fn load_mut<'a, T: ZeroCopy + Owner>(
    account_loader: &'a AccountLoader<T>,
) -> ClearingHouseResult<RefMut<'a, T>> {
    account_loader
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))
}
