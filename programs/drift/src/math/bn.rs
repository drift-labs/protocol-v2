//! Big number types

#![allow(clippy::assign_op_pattern)]
#![allow(clippy::ptr_offset_with_cast)]
#![allow(clippy::manual_range_contains)]

use crate::error::ErrorCode::BnConversionError;
use std::borrow::BorrowMut;
use std::convert::TryInto;
use std::mem::size_of;
use uint::construct_uint;

use crate::error::DriftResult;

pub mod compat {
    #![allow(non_camel_case_types)]
    use anchor_lang::prelude::borsh::{BorshDeserialize, BorshSerialize};
    use bytemuck::{Pod, Zeroable};
    use std::{
        cmp::Ordering,
        convert::TryFrom,
        ops::{Add, AddAssign, Div, DivAssign, Mul, MulAssign, Sub, SubAssign},
    };

    use crate::{error::DriftResult, math::casting::Cast};

    /// `u128` with legacy bit layout
    #[derive(Copy, Clone, PartialEq, Eq, Debug, Default, BorshSerialize, BorshDeserialize)]
    #[repr(transparent)]
    pub struct u128([u8; 16]);

    impl std::fmt::Display for self::u128 {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            std::fmt::Display::fmt(&self.as_u128(), f)
        }
    }

    impl PartialOrd for self::u128 {
        fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
            self.as_u128().partial_cmp(&other.as_u128())
        }
    }

    impl PartialOrd for self::i128 {
        fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
            self.as_i128().partial_cmp(&other.as_i128())
        }
    }

    // Safety: u128 is a transparent wrapper around [u8; 16], which is Pod + Zeroable
    unsafe impl Pod for self::u128 {}
    unsafe impl Zeroable for self::u128 {}
    impl u128 {
        pub const ONE: Self = u128(1_u128.to_le_bytes());
        pub const ZERO: Self = u128(0_u128.to_le_bytes());
        /// convert to std u128
        #[inline]
        pub fn as_u128(self) -> std::primitive::u128 {
            std::primitive::u128::from_le_bytes(self.0)
        }
        pub const fn one() -> Self {
            Self::ONE
        }
        pub const fn zero() -> Self {
            Self::ZERO
        }
        pub fn cast<T: TryFrom<std::primitive::u128>>(&self) -> DriftResult<T> {
            self.as_u128().cast()
        }
    }
    impl From<std::primitive::u128> for u128 {
        fn from(value: std::primitive::u128) -> Self {
            u128(value.to_le_bytes())
        }
    }
    impl From<u128> for std::primitive::u128 {
        fn from(value: u128) -> Self {
            value.as_u128()
        }
    }

    // Arithmetic operations for u128 - using From/Into conversions
    impl Add for u128 {
        type Output = Self;
        #[inline(always)]
        fn add(self, other: Self) -> Self {
            let a: std::primitive::u128 = self.into();
            let b: std::primitive::u128 = other.into();
            Self::from(a + b)
        }
    }
    impl AddAssign for u128 {
        #[inline(always)]
        fn add_assign(&mut self, other: Self) {
            *self = *self + other;
        }
    }
    impl Sub for u128 {
        type Output = Self;
        #[inline(always)]
        fn sub(self, other: Self) -> Self {
            let a: std::primitive::u128 = self.into();
            let b: std::primitive::u128 = other.into();
            Self::from(a - b)
        }
    }
    impl SubAssign for u128 {
        #[inline(always)]
        fn sub_assign(&mut self, other: Self) {
            *self = *self - other;
        }
    }
    impl Mul for u128 {
        type Output = Self;
        #[inline(always)]
        fn mul(self, other: Self) -> Self {
            let a: std::primitive::u128 = self.into();

            let b: std::primitive::u128 = other.into();
            Self::from(a * b)
        }
    }
    impl MulAssign for u128 {
        #[inline(always)]
        fn mul_assign(&mut self, other: Self) {
            *self = *self * other;
        }
    }
    impl Div for u128 {
        type Output = Self;
        #[inline(always)]
        fn div(self, other: Self) -> Self {
            let a: std::primitive::u128 = self.into();

            let b: std::primitive::u128 = other.into();
            Self::from(a / b)
        }
    }
    impl DivAssign for u128 {
        #[inline(always)]
        fn div_assign(&mut self, other: Self) {
            *self = *self / other;
        }
    }

    /// `i128` with legacy bit layout
    #[derive(Copy, Clone, PartialEq, Eq, Debug, Default, BorshSerialize, BorshDeserialize)]
    #[repr(transparent)]
    pub struct i128([u8; 16]);

    impl std::fmt::Display for self::i128 {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            std::fmt::Display::fmt(&self.as_i128(), f)
        }
    }

    // Safety: i128 is a transparent wrapper around [u8; 16], which is Pod + Zeroable
    unsafe impl Pod for self::i128 {}
    unsafe impl Zeroable for self::i128 {}
    impl i128 {
        pub const ONE: Self = i128(1_i128.to_le_bytes());
        pub const ZERO: Self = i128(0_i128.to_le_bytes());

        pub const fn one() -> Self {
            Self::ONE
        }
        pub const fn zero() -> Self {
            Self::ZERO
        }

        pub fn abs(&self) -> std::primitive::i128 {
            self.as_i128().abs()
        }

        pub fn unsigned_abs(&self) -> std::primitive::u128 {
            self.as_i128().unsigned_abs()
        }

        /// convert to std i128
        #[inline]
        pub fn as_i128(self) -> std::primitive::i128 {
            std::primitive::i128::from_le_bytes(self.0)
        }

        pub fn cast<T: TryFrom<std::primitive::i128>>(&self) -> DriftResult<T> {
            self.as_i128().cast()
        }
    }

    impl std::ops::Neg for self::i128 {
        type Output = std::primitive::i128;
        fn neg(self) -> Self::Output {
            self.as_i128().neg()
        }
    }

    impl From<std::primitive::i128> for i128 {
        fn from(value: std::primitive::i128) -> Self {
            i128(value.to_le_bytes())
        }
    }
    impl From<i128> for std::primitive::i128 {
        fn from(value: i128) -> Self {
            value.as_i128()
        }
    }

    // Arithmetic operations for i128 - using From/Into conversions
    impl Add for i128 {
        type Output = Self;
        #[inline(always)]
        fn add(self, other: Self) -> Self {
            let a: std::primitive::i128 = self.into();

            let b: std::primitive::i128 = other.into();
            Self::from(a + b)
        }
    }
    impl AddAssign for i128 {
        #[inline(always)]
        fn add_assign(&mut self, other: Self) {
            *self = *self + other;
        }
    }
    impl Sub for i128 {
        type Output = Self;
        #[inline(always)]
        fn sub(self, other: Self) -> Self {
            let a: std::primitive::i128 = self.into();

            let b: std::primitive::i128 = other.into();
            Self::from(a - b)
        }
    }
    impl SubAssign for i128 {
        #[inline(always)]
        fn sub_assign(&mut self, other: Self) {
            *self = *self - other;
        }
    }
    impl Mul for i128 {
        type Output = Self;
        #[inline(always)]
        fn mul(self, other: Self) -> Self {
            let a: std::primitive::i128 = self.into();

            let b: std::primitive::i128 = other.into();
            Self::from(a * b)
        }
    }
    impl MulAssign for i128 {
        #[inline(always)]
        fn mul_assign(&mut self, other: Self) {
            *self = *self * other;
        }
    }
    impl Div for i128 {
        type Output = Self;
        #[inline(always)]
        fn div(self, other: Self) -> Self {
            let a: std::primitive::i128 = self.into();

            let b: std::primitive::i128 = other.into();
            Self::from(a / b)
        }
    }
    impl DivAssign for i128 {
        #[inline(always)]
        fn div_assign(&mut self, other: Self) {
            *self = *self / other;
        }
    }
}

construct_uint! {
    /// 256-bit unsigned integer.
    pub struct U256(4);
}

impl U256 {
    /// Convert u256 to u64
    pub fn to_u64(self) -> Option<u64> {
        self.try_to_u64().map_or_else(|_| None, Some)
    }

    /// Convert u256 to u64
    pub fn try_to_u64(self) -> DriftResult<u64> {
        self.try_into().map_err(|_| BnConversionError)
    }

    /// Convert u256 to u128
    pub fn to_u128(self) -> Option<u128> {
        self.try_to_u128().map_or_else(|_| None, Some)
    }

    /// Convert u256 to u128
    pub fn try_to_u128(self) -> DriftResult<u128> {
        self.try_into().map_err(|_| BnConversionError)
    }

    /// Convert from little endian bytes
    pub fn from_le_bytes(bytes: [u8; 32]) -> Self {
        U256::from_little_endian(&bytes)
    }

    /// Convert to little endian bytes
    pub fn to_le_bytes(self) -> [u8; 32] {
        let mut buf: Vec<u8> = Vec::with_capacity(size_of::<Self>());
        self.to_little_endian(buf.borrow_mut());

        let mut bytes: [u8; 32] = [0u8; 32];
        bytes.copy_from_slice(buf.as_slice());
        bytes
    }
}

construct_uint! {
    /// 192-bit unsigned integer.
    pub struct U192(3);
}

impl U192 {
    /// Convert u192 to u64
    pub fn to_u64(self) -> Option<u64> {
        self.try_to_u64().map_or_else(|_| None, Some)
    }

    /// Convert u192 to u64
    pub fn try_to_u64(self) -> DriftResult<u64> {
        self.try_into().map_err(|_| BnConversionError)
    }

    /// Convert u192 to u128
    pub fn to_u128(self) -> Option<u128> {
        self.try_to_u128().map_or_else(|_| None, Some)
    }

    /// Convert u192 to u128
    pub fn try_to_u128(self) -> DriftResult<u128> {
        self.try_into().map_err(|_| BnConversionError)
    }

    /// Convert from little endian bytes
    pub fn from_le_bytes(bytes: [u8; 24]) -> Self {
        U192::from_little_endian(&bytes)
    }

    /// Convert to little endian bytes
    pub fn to_le_bytes(self) -> [u8; 24] {
        let mut buf: Vec<u8> = Vec::with_capacity(size_of::<Self>());
        self.to_little_endian(buf.borrow_mut());

        let mut bytes: [u8; 24] = [0u8; 24];
        bytes.copy_from_slice(buf.as_slice());
        bytes
    }
}
