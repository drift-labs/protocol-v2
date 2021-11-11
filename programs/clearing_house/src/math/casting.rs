use crate::error::{ClearingHouseResult, ErrorCode};
use std::convert::TryInto;

pub fn cast<T: TryInto<U>, U>(t: T) -> ClearingHouseResult<U> {
    t.try_into().map_err(|_| ErrorCode::CastingFailure)
}

pub fn cast_to_i128<T: TryInto<i128>>(t: T) -> ClearingHouseResult<i128> {
    cast(t)
}

pub fn cast_to_u128<T: TryInto<u128>>(t: T) -> ClearingHouseResult<u128> {
    cast(t)
}

pub fn cast_to_i64<T: TryInto<i64>>(t: T) -> ClearingHouseResult<i64> {
    cast(t)
}
