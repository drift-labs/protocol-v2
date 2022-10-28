use crate::error::{DriftResult, ErrorCode};
use std::convert::TryInto;

pub fn cast<T: TryInto<U>, U>(t: T) -> DriftResult<U> {
    t.try_into().map_err(|_| ErrorCode::CastingFailure)
}

pub fn cast_to_i128<T: TryInto<i128>>(t: T) -> DriftResult<i128> {
    cast(t)
}

pub fn cast_to_u128<T: TryInto<u128>>(t: T) -> DriftResult<u128> {
    cast(t)
}

pub fn cast_to_i64<T: TryInto<i64>>(t: T) -> DriftResult<i64> {
    cast(t)
}

pub fn cast_to_u64<T: TryInto<u64>>(t: T) -> DriftResult<u64> {
    cast(t)
}

pub fn cast_to_u32<T: TryInto<u32>>(t: T) -> DriftResult<u32> {
    cast(t)
}

pub trait Cast: Sized {
    fn cast<T: std::convert::TryFrom<Self>>(self) -> DriftResult<T> {
        self.try_into().map_err(|_| ErrorCode::CastingFailure)
    }
}

impl Cast for u128 {}
impl Cast for u64 {}
impl Cast for u32 {}
impl Cast for u16 {}
impl Cast for u8 {}
impl Cast for i128 {}
impl Cast for i64 {}
impl Cast for i32 {}
impl Cast for i16 {}
impl Cast for i8 {}
