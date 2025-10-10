//! Compatibility layer for different AccountInfo types
//!
//! This module provides compatibility between different AccountInfo implementations,
//! using pinocchio AccountInfo internally when the pinocchio feature is enabled,
//! otherwise falling back to anchor/solana-program AccountInfo types.

// Use pinocchio AccountInfo when the feature is enabled for better performance
#[cfg(feature = "pinocchio")]
pub type AccountInfo = pinocchio::account_info::AccountInfo;

// Otherwise use the appropriate AccountInfo type based on anchor feature
#[cfg(all(not(feature = "pinocchio"), feature = "anchor"))]
pub type AccountInfo<'a> = anchor_lang::prelude::AccountInfo<'a>;

#[cfg(all(not(feature = "pinocchio"), not(feature = "anchor")))]
pub type AccountInfo<'a> = crate::solana_program::account_info::AccountInfo<'a>;

/// Trait for types that can be converted to a reference to AccountInfo
#[cfg(feature = "pinocchio")]
pub trait AsAccountInfo<'a> {
    fn as_account_info(&self) -> &AccountInfo;
}

#[cfg(not(feature = "pinocchio"))]
pub trait AsAccountInfo<'a> {
    fn as_account_info(&self) -> &AccountInfo<'a>;
}

/// Implementation for the primary AccountInfo type
#[cfg(feature = "pinocchio")]
impl<'a> AsAccountInfo<'a> for AccountInfo {
    #[inline(always)]
    fn as_account_info(&self) -> &AccountInfo {
        self
    }
}

#[cfg(not(feature = "pinocchio"))]
impl<'a> AsAccountInfo<'a> for AccountInfo<'a> {
    #[inline(always)]
    fn as_account_info(&self) -> &AccountInfo<'a> {
        self
    }
}

/// Implementation for references to AccountInfo
#[cfg(feature = "pinocchio")]
impl<'a> AsAccountInfo<'a> for &AccountInfo {
    #[inline(always)]
    fn as_account_info(&self) -> &AccountInfo {
        self
    }
}

#[cfg(not(feature = "pinocchio"))]
impl<'a> AsAccountInfo<'a> for &AccountInfo<'a> {
    #[inline(always)]
    fn as_account_info(&self) -> &AccountInfo<'a> {
        self
    }
}

/// Helper macro to abstract field access differences between AccountInfo types
#[cfg(feature = "pinocchio")]
#[macro_export]
macro_rules! get_account_key {
    ($account:expr) => {
        $account.key()
    };
}

#[cfg(not(feature = "pinocchio"))]
#[macro_export]
macro_rules! get_account_key {
    ($account:expr) => {
        $account.key
    };
}

#[cfg(feature = "pinocchio")]
#[macro_export]
macro_rules! borrow_account_data {
    ($account:expr) => {
        $account.borrow_data_unchecked()
    };
}

#[cfg(not(feature = "pinocchio"))]
#[macro_export]
macro_rules! borrow_account_data {
    ($account:expr) => {
        $account.data.borrow()
    };
}

#[cfg(feature = "pinocchio")]
#[macro_export]
macro_rules! borrow_mut_account_data {
    ($account:expr) => {
        unsafe { $account.borrow_mut_data_unchecked() }
    };
}

#[cfg(not(feature = "pinocchio"))]
#[macro_export]
macro_rules! borrow_mut_account_data {
    ($account:expr) => {
        $account.data.borrow_mut()
    };
}
