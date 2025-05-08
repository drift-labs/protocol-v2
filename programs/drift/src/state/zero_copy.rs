use crate::error::ErrorCode;
use crate::math::safe_unwrap::SafeUnwrap;
use anchor_lang::prelude::{AccountInfo, Pubkey};
use bytemuck::{from_bytes, from_bytes_mut};
use bytemuck::{Pod, Zeroable};
use std::cell::{Ref, RefMut};
use std::marker::PhantomData;

use crate::error::DriftResult;
use crate::msg;
use crate::validate;

pub trait HasLen {
    fn len(&self) -> u32;
}

pub struct AccountZeroCopy<'a, T, F> {
    pub fixed: Ref<'a, F>,
    pub data: Ref<'a, [u8]>,
    pub _marker: PhantomData<T>,
}

impl<'a, T, F> AccountZeroCopy<'a, T, F>
where
    T: Pod + Zeroable + Clone + Copy,
    F: Pod + HasLen,
{
    pub fn len(&self) -> u32 {
        self.fixed.len()
    }

    pub fn get(&self, index: u32) -> &T {
        let size = std::mem::size_of::<T>();
        let start = index as usize * size;
        bytemuck::from_bytes(&self.data[start..start + size])
    }

    pub fn iter(&self) -> impl Iterator<Item = &T> + '_ {
        (0..self.len()).map(move |i| self.get(i))
    }
}

pub struct AccountZeroCopyMut<'a, T, F> {
    pub fixed: RefMut<'a, F>,
    pub data: RefMut<'a, [u8]>,
    pub _marker: PhantomData<T>,
}

impl<'a, T, F> AccountZeroCopyMut<'a, T, F>
where
    T: Pod + Zeroable + Clone + Copy,
    F: Pod + HasLen,
{
    pub fn len(&self) -> u32 {
        self.fixed.len()
    }

    pub fn get_mut(&mut self, index: u32) -> &mut T {
        let size = std::mem::size_of::<T>();
        let start = index as usize * size;
        bytemuck::from_bytes_mut(&mut self.data[start..start + size])
    }

    pub fn get(&self, index: u32) -> &T {
        let size = std::mem::size_of::<T>();
        let start = index as usize * size;
        bytemuck::from_bytes(&self.data[start..start + size])
    }

    pub fn iter(&self) -> impl Iterator<Item = &T> + '_ {
        (0..self.len()).map(move |i| self.get(i))
    }
}

pub trait ZeroCopyLoader<'a, T, F> {
    fn load_zc(&'a self) -> DriftResult<AccountZeroCopy<'a, T, F>>;
    fn load_zc_mut(&'a self) -> DriftResult<AccountZeroCopyMut<'a, T, F>>;
}

pub fn load_generic<'a, 'info, F, T>(
    acct: &'a AccountInfo<'info>,
    expected_disc: [u8; 8],
    program_id: Pubkey,
) -> DriftResult<AccountZeroCopy<'a, T, F>>
where
    F: Pod + HasLen,
    T: Pod,
{
    validate!(
        acct.owner == &program_id,
        ErrorCode::DefaultError,
        "invalid owner",
    )?;

    let data = acct.try_borrow_data().safe_unwrap()?;
    let (disc, rest) = Ref::map_split(data, |d| d.split_at(8));

    validate!(
        *disc == expected_disc,
        ErrorCode::DefaultError,
        "invalid discriminator",
    )?;

    let hdr_size = std::mem::size_of::<F>();
    let (hdr_bytes, body) = Ref::map_split(rest, |d| d.split_at(hdr_size));
    let fixed = Ref::map(hdr_bytes, |b| from_bytes::<F>(b));
    Ok(AccountZeroCopy {
        fixed,
        data: body,
        _marker: PhantomData,
    })
}

pub fn load_generic_mut<'a, 'info, F, T>(
    acct: &'a AccountInfo<'info>,
    expected_disc: [u8; 8],
    program_id: Pubkey,
) -> DriftResult<AccountZeroCopyMut<'a, T, F>>
where
    F: Pod + HasLen,
    T: Pod,
{
    validate!(
        acct.owner == &program_id,
        ErrorCode::DefaultError,
        "invalid owner",
    )?;

    let data = acct.try_borrow_mut_data().safe_unwrap()?;
    let (disc, rest) = RefMut::map_split(data, |d| d.split_at_mut(8));

    validate!(
        *disc == expected_disc,
        ErrorCode::DefaultError,
        "invalid discriminator",
    )?;

    let hdr_size = std::mem::size_of::<F>();
    let (hdr_bytes, body) = RefMut::map_split(rest, |d| d.split_at_mut(hdr_size));
    let fixed = RefMut::map(hdr_bytes, |b| from_bytes_mut::<F>(b));
    Ok(AccountZeroCopyMut {
        fixed,
        data: body,
        _marker: PhantomData,
    })
}

#[macro_export]
macro_rules! impl_zero_copy_loader {
    ($Acc:ty, $ID:path, $Fixed:ty, $Elem:ty) => {
        impl<'info> crate::state::zero_copy::ZeroCopyLoader<'_, $Elem, $Fixed>
            for AccountInfo<'info>
        {
            fn load_zc<'a>(
                self: &'a Self,
            ) -> crate::error::DriftResult<
                crate::state::zero_copy::AccountZeroCopy<'a, $Elem, $Fixed>,
            > {
                crate::state::zero_copy::load_generic::<$Fixed, $Elem>(
                    self,
                    <$Acc as anchor_lang::Discriminator>::discriminator(),
                    $ID(),
                )
            }

            fn load_zc_mut<'a>(
                self: &'a Self,
            ) -> crate::error::DriftResult<
                crate::state::zero_copy::AccountZeroCopyMut<'a, $Elem, $Fixed>,
            > {
                crate::state::zero_copy::load_generic_mut::<$Fixed, $Elem>(
                    self,
                    <$Acc as anchor_lang::Discriminator>::discriminator(),
                    $ID(),
                )
            }
        }
    };
}
