use crate::error::{DriftResult, ErrorCode};
use solana_program::msg;
use std::panic::Location;

pub trait SafeUnwrap {
    type Item;

    fn safe_unwrap(self) -> DriftResult<Self::Item>;
}

impl<T> SafeUnwrap for Option<T> {
    type Item = T;

    #[track_caller]
    #[inline(always)]
    fn safe_unwrap(self) -> DriftResult<T> {
        match self {
            Some(v) => Ok(v),
            None => {
                let caller = Location::caller();
                msg!("Unwrap error thrown at {}:{}", caller.file(), caller.line());
                Err(ErrorCode::FailedUnwrap)
            }
        }
    }
}

impl<T, U> SafeUnwrap for Result<T, U> {
    type Item = T;

    #[track_caller]
    #[inline(always)]
    fn safe_unwrap(self) -> DriftResult<T> {
        match self {
            Ok(v) => Ok(v),
            Err(_) => {
                let caller = Location::caller();
                msg!("Unwrap error thrown at {}:{}", caller.file(), caller.line());
                Err(ErrorCode::FailedUnwrap)
            }
        }
    }
}
