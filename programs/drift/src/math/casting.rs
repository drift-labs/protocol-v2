use crate::error::{DriftResult, ErrorCode};
use crate::math::bn::U192;
use solana_program::msg;
use std::convert::TryInto;
use std::panic::Location;

pub trait Cast: Sized {
    #[track_caller]
    #[inline(always)]
    fn cast<T: std::convert::TryFrom<Self>>(self) -> DriftResult<T> {
        match self.try_into() {
            Ok(result) => Ok(result),
            Err(_) => {
                let caller = Location::caller();
                msg!(
                    "Casting error thrown at {}:{}",
                    caller.file(),
                    caller.line()
                );
                Err(ErrorCode::CastingFailure)
            }
        }
    }
}

impl Cast for U192 {}
impl Cast for u128 {}
impl Cast for u64 {}
impl Cast for u32 {}
impl Cast for u16 {}
impl Cast for u8 {}
impl Cast for usize {}
impl Cast for i128 {}
impl Cast for i64 {}
impl Cast for i32 {}
impl Cast for i16 {}
impl Cast for i8 {}
impl Cast for bool {}
