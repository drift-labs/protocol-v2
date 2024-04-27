use anchor_lang::prelude::*;

use drift_macros::assert_no_slop;
use static_assertions::const_assert_eq;

#[assert_no_slop]
#[account(zero_copy(unsafe))]
#[derive(Eq, PartialEq, Debug)]
#[repr(C)]
pub struct ArchivedUser {
    pub data: [u8; 4368],
}

impl ArchivedUser {
    pub const SIZE: usize = 4368 + 8;
}

const_assert_eq!(ArchivedUser::SIZE, std::mem::size_of::<ArchivedUser>() + 8);
