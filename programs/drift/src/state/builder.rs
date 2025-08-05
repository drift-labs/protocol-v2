use std::cell::{Ref, RefMut};

use anchor_lang::prelude::Pubkey;
use anchor_lang::*;
use anchor_lang::{account, zero_copy};
use borsh::{BorshDeserialize, BorshSerialize};
use prelude::AccountInfo;

use super::zero_copy::{AccountZeroCopy, AccountZeroCopyMut, HasLen};
use crate::error::{DriftResult, ErrorCode};
use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::traits::Size;
use crate::state::user::MarketType;
use crate::validate;
use crate::{impl_zero_copy_loader, msg, ID};

pub const REVENUE_SHARE_PDA_SEED: &str = "REV_SHARE";
pub const REVENUE_SHARE_ESCROW_PDA_SEED: &str = "REV_ESCROW";

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum BuilderBitFlag {
    Revoked = 0b00000001,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum RevenueShareOrderBitFlag {
    Filled = 0b00000001,
    Canceled = 0b00000010,
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct RevenueShareFixed {
    pub total_referrer_rewards: i64,
    pub total_builder_rewards: i64,
    pub authority: Pubkey,
    pub padding: [u8; 4],
    pub len: u32,
}

impl HasLen for RevenueShareFixed {
    fn len(&self) -> u32 {
        self.len
    }
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
pub struct RevenueSharePosition {
    pub amount: u64, // pnl for perp, scaled_balance for spot
    pub padding: [u8; 5],
    pub market_type: u8,
    pub market_index: u16,
    // should this include the user account_id that receives rev share rewards?
    // or just always pay out to account_id 0
}

impl RevenueSharePosition {
    pub fn new(amount: u64, market_type: u8, market_index: u16) -> Self {
        Self {
            amount,
            market_type,
            market_index,
            padding: [0; 5],
        }
    }
}

#[account]
#[derive(Eq, PartialEq, Debug, Default)]
pub struct RevenueShare {
    /// the owner of this account, a builder or referrer
    pub authority: Pubkey,
    pub total_referrer_rewards: i64,
    pub total_builder_rewards: i64,
    pub positions: Vec<RevenueSharePosition>, // stores accrued referral rewards, init to large number to cover many markets
}

impl Size for RevenueShare {
    const SIZE: usize = 1000; // whats this for given that it can be reized?
}

impl RevenueShare {
    pub fn space(num_positions: usize) -> usize {
        8 + 32 + 8 + 8 + 32 + num_positions * 16
        //               ^-- whats this for
    }

    pub fn validate(&self) -> DriftResult<()> {
        validate!(
            self.positions.len() >= 1 && self.positions.len() <= 128,
            ErrorCode::DefaultError,
            "RevenueShare positions len must be between 1 and 128"
        )?;
        Ok(())
    }
}

impl_zero_copy_loader!(
    RevenueShare,
    crate::id,
    RevenueShareFixed,
    RevenueSharePosition
);

#[zero_copy]
// #[repr(C)]
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
pub struct RevenueShareOrder {
    /// set in place_order
    pub beneficiary: Pubkey, // builder/referrer, 111... if zeroed
    pub fee_accrued: u64,
    pub order_id: u32,
    pub fee_bps: u16,
    pub market_index: u16,

    /// set in fill_order
    /// u64 max fee is $18T, u32 is $4k
    /// This can be sweept into into the Builder's RevenueShare in settle_pnl
    /// once the order is filled or canceled.

    /// set in fill_order or cancel_order
    /// Signals that the order was filled or canceled, and builder or referral.
    /// This order slot is cleared once the fee_accrued is swept to the builder's
    /// RevenueShare account.
    pub bit_flags: u8,
    pub market_type: u8,

    pub padding: [u8; 6],
}

impl RevenueShareOrder {
    pub fn new(beneficiary: Pubkey, order_id: u32, fee_bps: u16, market_type: u8, market_index: u16) -> Self {
        Self {
            beneficiary,
            order_id,
            fee_bps,
            market_type,
            market_index,
            fee_accrued: 0,
            bit_flags: 0,
            padding: [0; 6],
        }
    }

    pub fn space() -> usize {
        32 + 
        8 + 
        4 + 2 + 2 + 
        1 + 1 + 6
    }

    pub fn add_bit_flag(&mut self, flag: RevenueShareOrderBitFlag) {
        self.bit_flags |= flag as u8;
    }

    pub fn is_bit_flag_set(&self, flag: RevenueShareOrderBitFlag) -> bool {
        (self.bit_flags & flag as u8) != 0
    }

    pub fn is_filled(&self) -> bool {
        self.is_bit_flag_set(RevenueShareOrderBitFlag::Filled)
    }

    pub fn is_canceled(&self) -> bool {
        self.is_bit_flag_set(RevenueShareOrderBitFlag::Canceled)
    }
    
    pub fn is_available(&self) -> bool {
        self.beneficiary != Pubkey::default() && !self.is_filled() && !self.is_canceled()
    }
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct BuilderInfo {
    pub authority: Pubkey, // builder authority
    pub max_fee_bps: u16,
}

impl BuilderInfo {
    pub fn space() -> usize {
        32 + 2
    }

    pub fn is_revoked(&self) -> bool {
        self.max_fee_bps == 0
    }
}

#[account]
#[derive(Eq, PartialEq, Debug, Default)]
#[repr(C)]
pub struct RevenueShareEscrow {
    /// the owner of this account, a user
    pub authority: Pubkey,
    pub referrer: Pubkey,
    pub orders: Vec<RevenueShareOrder>,
    pub approved_builders: Vec<BuilderInfo>,
}

// impl Size for RevenueShareEscrow {
//     const SIZE: usize = 5000; // whats this for given that it can be reized?
// }

impl RevenueShareEscrow {
    pub fn space(num_orders: usize, num_builders: usize) -> usize {
        8 + // discriminator
        std::mem::size_of::<RevenueShareEscrowFixed>() + // fixed header
        4 + // orders Vec length prefix
        num_orders * std::mem::size_of::<RevenueShareOrder>() + // orders data
        4 + // approved_builders Vec length prefix
        num_builders * std::mem::size_of::<BuilderInfo>() // builders data
    }

    pub fn validate(&self) -> DriftResult<()> {
        validate!(
            // self.orders.len() <= 128 && self.approved_builders.len() <= 128 && self.orders.len() > 0 && self.approved_builders.len() > 0,
            self.orders.len() <= 128 && self.approved_builders.len() <= 128,
            ErrorCode::DefaultError,
            "RevenueShareEscrow orders and approved_builders len must be between 1 and 128"
        )?;
        Ok(())
    }
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
pub struct RevenueShareEscrowFixed {
    pub authority: Pubkey,
    pub referrer: Pubkey,
}

pub struct RevenueShareEscrowZeroCopy<'a> {
    pub fixed: Ref<'a, RevenueShareEscrowFixed>,
    pub data: Ref<'a, [u8]>,
}

impl<'a> RevenueShareEscrowZeroCopy<'a> {
    pub fn orders_len(&self) -> u32 {
        // Read the Vec length from the first 4 bytes of data
        let length_bytes = &self.data[0..4];
        u32::from_le_bytes([length_bytes[0], length_bytes[1], length_bytes[2], length_bytes[3]])
    }
    pub fn approved_builders_len(&self) -> u32 {
        // Calculate offset to the approved_builders Vec length
        let orders_data_size = self.orders_len() as usize * std::mem::size_of::<RevenueShareOrder>();
        let offset = 4 + orders_data_size; // Skip orders Vec length + orders data
        let length_bytes = &self.data[offset..offset + 4];
        u32::from_le_bytes([length_bytes[0], length_bytes[1], length_bytes[2], length_bytes[3]])
    }

    pub fn get_order(&self, index: u32) -> DriftResult<&RevenueShareOrder> {
        validate!(
            index < self.orders_len(),
            ErrorCode::DefaultError,
            "Order index out of bounds"
        )?;
        let size = std::mem::size_of::<RevenueShareOrder>();
        let start = 4 + index as usize * size; // Skip Vec length prefix (4 bytes)
        Ok(bytemuck::from_bytes(&self.data[start..start + size]))
    }

    pub fn get_approved_builder(&self, index: u32) -> DriftResult<&BuilderInfo> {
        validate!(
            index < self.approved_builders_len(),
            ErrorCode::DefaultError,
            "Builder index out of bounds"
        )?;
        let size = std::mem::size_of::<BuilderInfo>();
        let offset = 4 + // Skip orders Vec length prefix
            self.orders_len() as usize * std::mem::size_of::<RevenueShareOrder>() + // orders data
            4; // Skip approved_builders Vec length prefix
        let start = offset + index as usize * size;
        Ok(bytemuck::from_bytes(&self.data[start..start + size]))
    }

    pub fn iter_orders(&self) -> impl Iterator<Item = DriftResult<&RevenueShareOrder>> + '_ {
        (0..self.orders_len()).map(move |i| self.get_order(i))
    }

    pub fn iter_approved_builders(&self) -> impl Iterator<Item = DriftResult<&BuilderInfo>> + '_ {
        (0..self.approved_builders_len()).map(move |i| self.get_approved_builder(i))
    }
}

#[derive(Debug)] // TODO: remove
pub struct RevenueShareEscrowZeroCopyMut<'a> {
    pub fixed: RefMut<'a, RevenueShareEscrowFixed>,
    pub data: RefMut<'a, [u8]>,
}

impl<'a> RevenueShareEscrowZeroCopyMut<'a> {
    pub fn orders_len(&self) -> u32 {
        // Read the Vec length from the first 4 bytes of data
        let length_bytes = &self.data[0..4];
        u32::from_le_bytes([length_bytes[0], length_bytes[1], length_bytes[2], length_bytes[3]])
    }
    pub fn approved_builders_len(&self) -> u32 {
        // Calculate offset to the approved_builders Vec length
        let orders_data_size = self.orders_len() as usize * std::mem::size_of::<RevenueShareOrder>();
        let offset = 4 + orders_data_size; // Skip orders Vec length + orders data
        let length_bytes = &self.data[offset..offset + 4];
        u32::from_le_bytes([length_bytes[0], length_bytes[1], length_bytes[2], length_bytes[3]])
    }

    pub fn get_order_mut(&mut self, index: u32) -> DriftResult<&mut RevenueShareOrder> {
        validate!(
            index < self.orders_len(),
            ErrorCode::DefaultError,
            "Order index out of bounds"
        )?;
        let size = std::mem::size_of::<RevenueShareOrder>();
        msg!("size rev share order: {}", std::mem::size_of::<RevenueShareOrder>());
        msg!("size builder info:    {}", std::mem::size_of::<BuilderInfo>());
        msg!("self fixed size: {}", std::mem::size_of::<RevenueShareEscrowFixed>());
        msg!("self data size:  {}", self.data.len());
        let start = 4 + index as usize * size;
        Ok(bytemuck::from_bytes_mut(&mut self.data[start..(start + size)]))
    }

    pub fn get_approved_builder_mut(&mut self, index: u32) -> DriftResult<&mut BuilderInfo> {
        validate!(
            index < self.approved_builders_len(),
            ErrorCode::DefaultError,
            "Builder index out of bounds, index: {}, orderslen: {}, builderslen: {}",
            index,
            self.orders_len(),
            self.approved_builders_len()
        )?;
        let size = std::mem::size_of::<BuilderInfo>();
        let offset = 4 + // Skip orders Vec length prefix
            self.orders_len() as usize * std::mem::size_of::<RevenueShareOrder>() + // orders data
            4; // Skip approved_builders Vec length prefix
        let start = offset + index as usize * size;
        Ok(bytemuck::from_bytes_mut(&mut self.data[start..start + size]))
    }

    pub fn add_order(&mut self, order: RevenueShareOrder) -> DriftResult {

        msg!("add_order order_len: {:?} builder_len: {:?}", self.orders_len(), self.approved_builders_len());
        for i in 0..self.orders_len() {
            msg!("getting i: {}", i);
            let existing_order = self.get_order_mut(i)?;
            msg!("got i: {}", i);
            if existing_order.is_available() {
                msg!("existing: {:?}", existing_order);
                msg!("new:      {:?}", order);
                *existing_order = order;
                return Ok(());
            }
        }

        Err(ErrorCode::RevenueShareEscrowOrdersAccountFull.into())
    }
}

pub trait RevenueShareEscrowLoader<'a> {
    fn load_zc(&self) -> DriftResult<RevenueShareEscrowZeroCopy>;
    fn load_zc_mut(&self) -> DriftResult<RevenueShareEscrowZeroCopyMut>;
    fn load_zc_mut_from_data<'b>(
        data: RefMut<'b, &mut [u8]>,
    ) -> DriftResult<RevenueShareEscrowZeroCopyMut<'b>>;
}

impl<'a> RevenueShareEscrowLoader<'a> for AccountInfo<'a> {
    fn load_zc(&self) -> DriftResult<RevenueShareEscrowZeroCopy> {
        let owner = self.owner;

        validate!(
            owner == &ID,
            ErrorCode::DefaultError,
            "invalid RevenueShareEscrow owner",
        )?;

        let data = self.try_borrow_data().safe_unwrap()?;

        let (discriminator, data) = Ref::map_split(data, |d| d.split_at(8));
        validate!(
            *discriminator == RevenueShareEscrow::discriminator(),
            ErrorCode::DefaultError,
            "invalid signed_msg user orders discriminator",
        )?;

        let hdr_size = std::mem::size_of::<RevenueShareEscrowFixed>();
        let (fixed, data) = Ref::map_split(data, |d| d.split_at(hdr_size));
        Ok(RevenueShareEscrowZeroCopy {
            fixed: Ref::map(fixed, |b| bytemuck::from_bytes(b)),
            data,
        })
    }

    fn load_zc_mut(&self) -> DriftResult<RevenueShareEscrowZeroCopyMut> {
        let owner = self.owner;

        validate!(
            owner == &ID,
            ErrorCode::DefaultError,
            "invalid RevenueShareEscrow owner",
        )?;

        let data = self.try_borrow_mut_data().safe_unwrap()?;

        let (discriminator, data) = RefMut::map_split(data, |d| d.split_at_mut(8));
        validate!(
            *discriminator == RevenueShareEscrow::discriminator(),
            ErrorCode::DefaultError,
            "invalid signed_msg user orders discriminator",
        )?;

        let hdr_size = std::mem::size_of::<RevenueShareEscrowFixed>();
        let (fixed, data) = RefMut::map_split(data, |d| d.split_at_mut(hdr_size));
        Ok(RevenueShareEscrowZeroCopyMut {
            fixed: RefMut::map(fixed, |b| bytemuck::from_bytes_mut(b)),
            data,
        })
    }

    fn load_zc_mut_from_data<'b>(
        data: RefMut<'b, &mut [u8]>,
    ) -> DriftResult<RevenueShareEscrowZeroCopyMut<'b>> {
        if data.len() < RevenueShareEscrow::discriminator().len() {
            return Err(ErrorCode::DefaultError.into());
        }

        let (discriminator, data) = RefMut::map_split(data, |d| d.split_at_mut(8));
        validate!(
            *discriminator == RevenueShareEscrow::discriminator(),
            ErrorCode::DefaultError,
            "invalid signed_msg user orders discriminator",
        )?;

        let hdr_size = std::mem::size_of::<RevenueShareEscrowFixed>();
        let (fixed, data) = RefMut::map_split(data, |d| d.split_at_mut(hdr_size));
        Ok(RevenueShareEscrowZeroCopyMut {
            fixed: RefMut::map(fixed, |b| bytemuck::from_bytes_mut(b)),
            data,
        })
    }
}
