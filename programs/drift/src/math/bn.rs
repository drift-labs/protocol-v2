//! Big number types

#![allow(clippy::assign_op_pattern)]
#![allow(clippy::ptr_offset_with_cast)]
#![allow(clippy::manual_range_contains)]

use crate::error::ErrorCode::BnConversionError;
use borsh::{BorshDeserialize, BorshSerialize};
use std::borrow::BorrowMut;
use std::convert::TryInto;
use std::io::{Error, ErrorKind, Read, Write};
use std::mem::size_of;
use uint::construct_uint;

use crate::error::DriftResult;

macro_rules! impl_borsh_serialize_for_bn {
    ($type: ident) => {
        impl BorshSerialize for $type {
            #[inline]
            fn serialize<W: Write>(&self, writer: &mut W) -> std::io::Result<()> {
                let bytes = self.to_le_bytes();
                writer.write_all(&bytes)
            }
        }
    };
}

macro_rules! impl_borsh_deserialize_for_bn {
    ($type: ident) => {
        impl BorshDeserialize for $type {
            #[inline]
            fn deserialize(buf: &mut &[u8]) -> std::io::Result<Self> {
                if buf.len() < size_of::<$type>() {
                    return Err(Error::new(
                        ErrorKind::InvalidInput,
                        "Unexpected length of input",
                    ));
                }
                let res = $type::from_le_bytes(buf[..size_of::<$type>()].try_into().unwrap());
                *buf = &buf[size_of::<$type>()..];
                Ok(res)
            }
            #[inline]
            fn deserialize_reader<R: Read>(reader: &mut R) -> std::io::Result<Self> {
                let mut buf = Vec::with_capacity(size_of::<$type>());

                match reader.read_exact(&mut buf) {
                    Ok(_) => (),
                    Err(_) => {
                        return Err(Error::new(
                            ErrorKind::InvalidInput,
                            "Unexpected length of input",
                        ))
                    }
                };
                let res = $type::from_le_bytes(buf[..size_of::<$type>()].try_into().unwrap());
                Ok(res)
            }
        }
    };
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

impl_borsh_deserialize_for_bn!(U256);
impl_borsh_serialize_for_bn!(U256);

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

impl_borsh_deserialize_for_bn!(U192);
impl_borsh_serialize_for_bn!(U192);
