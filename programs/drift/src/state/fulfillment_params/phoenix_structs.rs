use anchor_lang::prelude::borsh::{BorshDeserialize, BorshSerialize};
use bytemuck::{Pod, Zeroable};
use sokoban::node_allocator::ZeroCopy;
use solana_program::pubkey::Pubkey;

#[derive(Default, Debug, Copy, Clone, BorshDeserialize, BorshSerialize, Zeroable, Pod)]
#[repr(C)]
pub struct MarketSizeParams {
    pub bids_size: u64,
    pub asks_size: u64,
    pub num_seats: u64,
}
impl ZeroCopy for MarketSizeParams {}

#[derive(Debug, Copy, Clone, BorshDeserialize, BorshSerialize, Zeroable, Pod)]
#[repr(C)]
pub struct TokenParams {
    /// Number of decimals for the token (e.g. 9 for SOL, 6 for USDC).
    pub decimals: u32,

    /// Bump used for generating the PDA for the market's token vault.
    pub vault_bump: u32,

    /// Pubkey of the token mint.
    pub mint_key: Pubkey,

    /// Pubkey of the token vault.
    pub vault_key: Pubkey,
}
impl ZeroCopy for TokenParams {}

#[derive(Debug, Clone, Copy, Zeroable, Pod)]
#[repr(C)]
pub struct MarketHeader {
    pub discriminant: u64,
    pub status: u64,
    pub market_size_params: MarketSizeParams,
    pub base_params: TokenParams,
    base_lot_size: BaseAtomsPerBaseLot,
    pub quote_params: TokenParams,
    quote_lot_size: QuoteAtomsPerQuoteLot,
    tick_size_in_quote_atoms_per_base_unit: QuoteAtomsPerBaseUnitPerTick,
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub market_sequence_number: u64,
    pub successor: Pubkey,
    pub raw_base_units_per_base_unit: u32,
    _padding1: u32,
    _padding2: [u64; 32],
}
impl ZeroCopy for MarketHeader {}

/// This struct represents the state of a seat. Only traders with seats can
/// place limit orders on the market. The seat is valid when the approval_status
/// field is set to Approved. The initial state is NotApproved, and the seat will
/// be retired if it is a Retired state.
#[derive(Debug, Clone, Copy, BorshDeserialize, BorshSerialize, Zeroable, Pod)]
#[repr(C)]
pub struct Seat {
    pub discriminant: u64,
    pub market: Pubkey,
    pub trader: Pubkey,
    pub approval_status: u64,
    // Padding
    _padding: [u64; 6],
}

impl ZeroCopy for Seat {}

// By aliasing the BorshDeserialize and BorshSerialize traits, we prevent Shank from
// writing structs with these annotations to the IDL.
use std::fmt::Display;
use std::iter::Sum;
use std::ops::{Add, AddAssign, Div, Mul, Rem, Sub, SubAssign};

pub trait WrapperU64 {
    fn new(value: u64) -> Self;
    fn as_u64(&self) -> u64;
}

macro_rules! basic_u64_struct {
    ($type_name:ident) => {
        #[derive(Debug, Clone, Copy, PartialOrd, Ord, Zeroable, Pod)]
        #[repr(transparent)]
        pub struct $type_name {
            inner: u64,
        }

        basic_u64!($type_name);
    };
}

macro_rules! basic_u64 {
    ($type_name:ident) => {
        impl WrapperU64 for $type_name {
            fn new(value: u64) -> Self {
                $type_name { inner: value }
            }

            fn as_u64(&self) -> u64 {
                self.inner
            }
        }

        impl $type_name {
            pub const ZERO: Self = $type_name { inner: 0 };
            pub const ONE: Self = $type_name { inner: 1 };
            pub const MAX: Self = $type_name { inner: u64::MAX };
            pub const MIN: Self = $type_name { inner: u64::MIN };
            pub fn as_u128(&self) -> u128 {
                self.inner as u128
            }

            pub fn saturating_sub(self, other: Self) -> Self {
                $type_name::new(self.inner.saturating_sub(other.inner))
            }

            pub fn unchecked_div<Divisor: WrapperU64, Quotient: WrapperU64>(
                self,
                other: Divisor,
            ) -> Quotient {
                Quotient::new(self.inner / other.as_u64())
            }
        }

        impl Display for $type_name {
            fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                self.inner.fmt(f)
            }
        }

        impl Mul for $type_name {
            type Output = Self;
            fn mul(self, other: Self) -> Self {
                $type_name::new(self.inner * other.inner)
            }
        }

        impl Sum<$type_name> for $type_name {
            fn sum<I: Iterator<Item = Self>>(iter: I) -> Self {
                iter.fold($type_name::ZERO, |acc, x| acc + x)
            }
        }

        impl Add for $type_name {
            type Output = Self;
            fn add(self, other: Self) -> Self {
                $type_name::new(self.inner + other.inner)
            }
        }

        impl AddAssign for $type_name {
            fn add_assign(&mut self, other: Self) {
                *self = *self + other;
            }
        }

        impl Sub for $type_name {
            type Output = Self;

            fn sub(self, other: Self) -> Self {
                $type_name::new(self.inner - other.inner)
            }
        }

        impl SubAssign for $type_name {
            fn sub_assign(&mut self, other: Self) {
                *self = *self - other;
            }
        }

        impl Default for $type_name {
            fn default() -> Self {
                Self::ZERO
            }
        }

        impl PartialEq for $type_name {
            fn eq(&self, other: &Self) -> bool {
                self.inner == other.inner
            }
        }

        impl From<$type_name> for u64 {
            fn from(x: $type_name) -> u64 {
                x.inner
            }
        }

        impl From<$type_name> for f64 {
            fn from(x: $type_name) -> f64 {
                x.inner as f64
            }
        }

        impl Eq for $type_name {}

        // Below should only be used in tests.
        impl PartialEq<u64> for $type_name {
            fn eq(&self, other: &u64) -> bool {
                self.inner == *other
            }
        }

        impl PartialEq<$type_name> for u64 {
            fn eq(&self, other: &$type_name) -> bool {
                *self == other.inner
            }
        }
    };
}

macro_rules! allow_multiply {
    ($type_1:ident, $type_2:ident, $type_result:ident) => {
        impl Mul<$type_2> for $type_1 {
            type Output = $type_result;
            fn mul(self, other: $type_2) -> $type_result {
                $type_result::new(self.inner * other.inner)
            }
        }

        impl Mul<$type_1> for $type_2 {
            type Output = $type_result;
            fn mul(self, other: $type_1) -> $type_result {
                $type_result::new(self.inner * other.inner)
            }
        }

        impl Div<$type_1> for $type_result {
            type Output = $type_2;
            #[track_caller]
            fn div(self, other: $type_1) -> $type_2 {
                if self.inner % other.inner != 0 {
                    let caller = std::panic::Location::caller();

                    // phoenix_log!(
                    //     "WARNING: Expected clean division, but received {:?} / {:?}. Caller: {:?}",
                    //     self,
                    //     other,
                    //     caller
                    // );
                }
                $type_2::new(self.inner / other.inner)
            }
        }

        impl Div<$type_2> for $type_result {
            type Output = $type_1;
            #[track_caller]
            fn div(self, other: $type_2) -> $type_1 {
                if self.inner % other.inner != 0 {
                    let caller = std::panic::Location::caller();

                    // phoenix_log!(
                    //     "WARNING: Expected clean division, but received {:?} / {:?}. Caller: {:?}",
                    //     self,
                    //     other,
                    //     caller
                    // );
                }
                $type_1::new(self.inner / other.inner)
            }
        }
    };
}

macro_rules! allow_mod {
    ($type_1:ident, $type_2:ident) => {
        impl Rem<$type_2> for $type_1 {
            type Output = u64;
            fn rem(self, other: $type_2) -> u64 {
                self.inner % other.inner
            }
        }
    };
}

// These structs need to be explicitly defined outside of the macro generation because the
// OrderPacket type (which contains these units) implements BorshSerialize and BorshDeserialize
#[derive(Debug, Clone, Copy, PartialOrd, Ord, Zeroable, Pod, BorshDeserialize, BorshSerialize)]
#[repr(transparent)]
pub struct QuoteLots {
    inner: u64,
}
#[derive(Debug, Clone, Copy, PartialOrd, Ord, Zeroable, Pod, BorshDeserialize, BorshSerialize)]
#[repr(transparent)]
pub struct BaseLots {
    inner: u64,
}

#[derive(Debug, Clone, Copy, PartialOrd, Ord, Zeroable, Pod, BorshDeserialize, BorshSerialize)]
#[repr(transparent)]
pub struct Ticks {
    inner: u64,
}

basic_u64!(QuoteLots);
basic_u64!(BaseLots);

// Discrete price unit (quote quantity per base quantity)
basic_u64!(Ticks);

// Quantities
basic_u64_struct!(QuoteAtoms);
basic_u64_struct!(BaseAtoms);
basic_u64_struct!(QuoteUnits);
basic_u64_struct!(BaseUnits);

// Dimensionless conversion factors
basic_u64_struct!(QuoteAtomsPerQuoteLot);
basic_u64_struct!(BaseAtomsPerBaseLot);
basic_u64_struct!(BaseLotsPerBaseUnit);
basic_u64_struct!(QuoteLotsPerQuoteUnit);
basic_u64_struct!(QuoteAtomsPerQuoteUnit);
basic_u64_struct!(BaseAtomsPerBaseUnit);

// Dimensionless tick sizes
basic_u64_struct!(QuoteAtomsPerBaseUnitPerTick);
basic_u64_struct!(QuoteLotsPerBaseUnitPerTick);

basic_u64_struct!(AdjustedQuoteLots);
basic_u64_struct!(QuoteLotsPerBaseUnit);

// Conversions from units to lots
allow_multiply!(BaseUnits, BaseLotsPerBaseUnit, BaseLots);
allow_multiply!(QuoteUnits, QuoteLotsPerQuoteUnit, QuoteLots);
// Conversions from lots to atoms
allow_multiply!(QuoteLots, QuoteAtomsPerQuoteLot, QuoteAtoms);
allow_multiply!(BaseLots, BaseAtomsPerBaseLot, BaseAtoms);

// Conversion from atoms per lot to units
allow_multiply!(
    BaseAtomsPerBaseLot,
    BaseLotsPerBaseUnit,
    BaseAtomsPerBaseUnit
);
allow_multiply!(
    QuoteAtomsPerQuoteLot,
    QuoteLotsPerQuoteUnit,
    QuoteAtomsPerQuoteUnit
);

// Conversion between units of tick size
allow_multiply!(
    QuoteLotsPerBaseUnitPerTick,
    QuoteAtomsPerQuoteLot,
    QuoteAtomsPerBaseUnitPerTick
);

// Conversion from ticks to price
allow_multiply!(QuoteLotsPerBaseUnitPerTick, Ticks, QuoteLotsPerBaseUnit);

// Conversion from quote lots to adjusted quote lots
allow_multiply!(QuoteLots, BaseLotsPerBaseUnit, AdjustedQuoteLots);

// Intermediate conversions for extracting quote lots from book orders
allow_multiply!(QuoteLotsPerBaseUnit, BaseLots, AdjustedQuoteLots);

allow_mod!(AdjustedQuoteLots, BaseLotsPerBaseUnit);
allow_mod!(BaseAtomsPerBaseUnit, BaseLotsPerBaseUnit);
allow_mod!(QuoteAtomsPerQuoteUnit, QuoteLotsPerQuoteUnit);
allow_mod!(QuoteLotsPerBaseUnitPerTick, BaseLotsPerBaseUnit);

#[test]
fn test_new_constructor_macro() {
    let base_lots_1 = BaseLots::new(5);
    let base_lots_2 = BaseLots::new(10);

    assert_eq!(base_lots_1 + base_lots_2, BaseLots::new(15));

    // Below code (correctly) fails to compile.
    // let quote_lots_1 = QuoteLots::new(5);
    // let result = quote_lots_1 + base_lots_1;
}

#[test]
fn test_multiply_macro() {
    let base_units = BaseUnits::new(5);
    let base_lots_per_base_unit = BaseLotsPerBaseUnit::new(100);
    assert_eq!(base_units * base_lots_per_base_unit, BaseLots::new(500));

    // Below code (correctly) fails to compile.
    // let quote_units = QuoteUnits::new(5);
    // let result = quote_units * base_lots_per_base_unit;
}
