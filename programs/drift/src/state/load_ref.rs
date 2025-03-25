use anchor_lang::prelude::*;
use anchor_lang::ZeroCopy;
use arrayref::array_ref;
use std::cell::{Ref, RefMut};
use std::mem;

pub fn load_ref<'a, T: ZeroCopy + Owner>(account_info: &'a AccountInfo) -> Result<Ref<'a, T>> {
    let data = account_info.try_borrow_data()?;
    if data.len() < T::discriminator().len() {
        return Err(ErrorCode::AccountDiscriminatorNotFound.into());
    }

    let disc_bytes = array_ref![data, 0, 8];
    if disc_bytes != &T::discriminator() {
        return Err(ErrorCode::AccountDiscriminatorMismatch.into());
    }

    Ok(Ref::map(data, |data| {
        bytemuck::from_bytes(&data[8..mem::size_of::<T>() + 8])
    }))
}

pub fn load_ref_mut<'a, T: ZeroCopy + Owner>(
    account_info: &'a AccountInfo,
) -> Result<RefMut<'a, T>> {
    let data = account_info.try_borrow_mut_data()?;
    if data.len() < T::discriminator().len() {
        return Err(ErrorCode::AccountDiscriminatorNotFound.into());
    }

    let disc_bytes = array_ref![data, 0, 8];
    if disc_bytes != &T::discriminator() {
        return Err(ErrorCode::AccountDiscriminatorMismatch.into());
    }

    Ok(RefMut::map(data, |data| {
        bytemuck::from_bytes_mut(&mut data[8..mem::size_of::<T>() + 8])
    }))
}
