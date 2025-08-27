use std::cell::{Ref, RefMut};

use anchor_lang::prelude::Pubkey;
use anchor_lang::*;
use anchor_lang::{account, zero_copy};
use borsh::{BorshDeserialize, BorshSerialize};
use prelude::AccountInfo;

use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::user::{MarketType, OrderStatus, User};
use crate::validate;
use crate::{msg, ID};

pub const BUILDER_PDA_SEED: &str = "BUILD";
pub const BUILDER_ESCROW_PDA_SEED: &str = "B_ESCROW";

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq, Default)]
pub enum BuilderOrderBitFlag {
    #[default]
    Init = 0b00000000,
    Open = 0b00000001,
    Completed = 0b00000010,
    Referral = 0b00000100,
}

#[account(zero_copy(unsafe))]
#[derive(Eq, PartialEq, Debug, Default)]
pub struct Builder {
    /// the owner of this account, a builder or referrer
    pub authority: Pubkey,
    pub total_referrer_rewards: u64,
    pub total_builder_rewards: u64,
    pub padding: [u8; 18],
}

impl Builder {
    pub fn space() -> usize {
        8 + 32 + 8 + 8 + 18
    }
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
pub struct BuilderOrder {
    /// fees accrued so far for this order slot. This is not exclusively fees from this order_id
    /// and may include fees from other orders in the same market. This may be swept to the
    /// builder's SpotPosition during settle_pnl.
    pub fees_accrued: u64,
    /// the order_id of the current active order in this slot. It's only relevant while bit_flag = Open
    pub order_id: u32,
    pub fee_bps: u16,
    pub market_index: u16,
    /// the subaccount_id of the user who created this order. It's only relevant while bit_flag = Open
    pub sub_account_id: u16,
    /// the index of the BuilderEscrow.approved_builders list, that this order's fee will settle to. Ignored
    /// if bit_flag = Referral.
    pub builder_idx: u8,
    /// bitflags that describe the state of the order.
    /// [`BuilderOrderBitFlag::Init`]: this order slot is available for use.
    /// [`BuilderOrderBitFlag::Open`]: this order slot is occupied, `order_id` is the `sub_account_id`'s active order.
    /// [`BuilderOrderBitFlag::Completed`]: this order has been filled or canceled, and is waiting to be settled into.
    /// the builder's account order_id and sub_account_id are no longer relevant, it may be merged with other orders.
    /// [`BuilderOrderBitFlag::Referral`]: this order stores referral rewards waiting to be settled. If it is set, no
    /// other bitflag should be set.
    pub bit_flags: u8,
    /// the index into the User's orders list when this BuilderOrder was created, make sure to verify that order_id matches.
    pub user_order_index: u8,
    pub market_type: MarketType,
    pub padding: [u8; 10],
}

impl BuilderOrder {
    pub fn new(
        builder_idx: u8,
        sub_account_id: u16,
        order_id: u32,
        fee_bps: u16,
        market_type: MarketType,
        market_index: u16,
        bit_flags: u8,
        user_order_index: u8,
    ) -> Self {
        Self {
            builder_idx,
            order_id,
            fee_bps,
            market_type,
            market_index,
            fees_accrued: 0,
            bit_flags,
            sub_account_id,
            user_order_index,
            padding: [0; 10],
        }
    }

    pub fn space() -> usize {
        std::mem::size_of::<BuilderOrder>()
    }

    pub fn add_bit_flag(&mut self, flag: BuilderOrderBitFlag) {
        self.bit_flags |= flag as u8;
    }

    pub fn is_bit_flag_set(&self, flag: BuilderOrderBitFlag) -> bool {
        (self.bit_flags & flag as u8) != 0
    }

    // An order is Open after it is created, the slot is considered occupied
    // and it is waiting to become `Completed` (filled or canceled).
    pub fn is_open(&self) -> bool {
        self.is_bit_flag_set(BuilderOrderBitFlag::Open)
    }

    // An order is Completed after it is filled or canceled. It is waiting to be settled
    // into the builder's account
    pub fn is_completed(&self) -> bool {
        self.is_bit_flag_set(BuilderOrderBitFlag::Completed)
    }

    /// An order slot is available (can be written to) if it is neither Completed nor Open.
    pub fn is_available(&self) -> bool {
        !self.is_completed() && !self.is_open() && !self.is_referral_order()
    }

    pub fn is_referral_order(&self) -> bool {
        self.is_bit_flag_set(BuilderOrderBitFlag::Referral)
    }

    /// Checks if `self` can be merged with `other`. Merged orders track cumulative fees accrued
    /// and are settled together, making more efficient use of the orders list.
    pub fn is_mergeable(&self, other: &BuilderOrder) -> bool {
        (self.is_referral_order() == other.is_referral_order())
            && other.is_completed()
            && other.market_index == self.market_index
            && other.market_type == self.market_type
            && other.builder_idx == self.builder_idx
    }

    /// Merges `other` into `self`. The orders must be mergeable.
    pub fn merge(mut self, other: &BuilderOrder) -> DriftResult<BuilderOrder> {
        validate!(
            self.is_mergeable(other),
            ErrorCode::DefaultError,
            "Orders are not mergeable"
        )?;
        self.fees_accrued = self
            .fees_accrued
            .checked_add(other.fees_accrued)
            .ok_or(ErrorCode::MathError)?;
        Ok(self)
    }
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct BuilderInfo {
    // pub padding0: u32,
    pub authority: Pubkey, // builder authority
    // pub padding: u64, // force alignment to 8 bytes
    pub max_fee_bps: u16,
    pub padding2: [u8; 2],
}

impl BuilderInfo {
    pub fn space() -> usize {
        std::mem::size_of::<BuilderInfo>()
    }

    pub fn is_revoked(&self) -> bool {
        self.max_fee_bps == 0
    }
}

#[account]
#[derive(Eq, PartialEq, Debug, Default)]
#[repr(C)]
pub struct BuilderEscrow {
    /// the owner of this account, a user
    pub authority: Pubkey,
    pub referrer: Pubkey,
    pub padding0: u32, // align with orders 4 bytes len prefix
    pub orders: Vec<BuilderOrder>,
    pub padding1: u32, // align with approved_builders 4 bytes len prefix
    pub approved_builders: Vec<BuilderInfo>,
}

impl BuilderEscrow {
    pub fn space(num_orders: usize, num_builders: usize) -> usize {
        8 + // discriminator
        std::mem::size_of::<BuilderEscrowFixed>() + // fixed header
        4 + // orders Vec length prefix
        4 + // padding0
        num_orders * std::mem::size_of::<BuilderOrder>() + // orders data
        4 + // approved_builders Vec length prefix
        4 + // padding1
        num_builders * std::mem::size_of::<BuilderInfo>() // builders data
    }

    pub fn validate(&self) -> DriftResult<()> {
        validate!(
            self.orders.len() <= 128 && self.approved_builders.len() <= 128,
            ErrorCode::DefaultError,
            "BuilderEscrow orders and approved_builders len must be between 1 and 128"
        )?;
        Ok(())
    }
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
pub struct BuilderEscrowFixed {
    pub authority: Pubkey,
    pub referrer: Pubkey,
}

pub struct BuilderEscrowZeroCopy<'a> {
    pub fixed: Ref<'a, BuilderEscrowFixed>,
    pub data: Ref<'a, [u8]>,
}

impl<'a> BuilderEscrowZeroCopy<'a> {
    pub fn orders_len(&self) -> u32 {
        let length_bytes = &self.data[4..8];
        u32::from_le_bytes([
            length_bytes[0],
            length_bytes[1],
            length_bytes[2],
            length_bytes[3],
        ])
    }
    pub fn approved_builders_len(&self) -> u32 {
        let orders_data_size = self.orders_len() as usize * std::mem::size_of::<BuilderOrder>();
        let offset = 4 + // BuilderEscrow.padding0
        4 + // vec len
        orders_data_size + 4; // BuilderEscrow.padding1
        let length_bytes = &self.data[offset..offset + 4];
        u32::from_le_bytes([
            length_bytes[0],
            length_bytes[1],
            length_bytes[2],
            length_bytes[3],
        ])
    }

    pub fn get_order(&self, index: u32) -> DriftResult<&BuilderOrder> {
        validate!(
            index < self.orders_len(),
            ErrorCode::DefaultError,
            "Order index out of bounds"
        )?;
        let size = std::mem::size_of::<BuilderOrder>();
        let start = 4 + // BuilderEscrow.padding0
        4 + // vec len
        index as usize * size; // orders data
        Ok(bytemuck::from_bytes(&self.data[start..start + size]))
    }

    pub fn get_approved_builder(&self, index: u32) -> DriftResult<&BuilderInfo> {
        validate!(
            index < self.approved_builders_len(),
            ErrorCode::DefaultError,
            "Builder index out of bounds"
        )?;
        let size = std::mem::size_of::<BuilderInfo>();
        let offset = 4 + 4 + // Skip orders Vec length prefix + padding0
            self.orders_len() as usize * std::mem::size_of::<BuilderOrder>() + // orders data
            4; // Skip approved_builders Vec length prefix + padding1
        let start = offset + index as usize * size;
        Ok(bytemuck::from_bytes(&self.data[start..start + size]))
    }

    pub fn iter_orders(&self) -> impl Iterator<Item = DriftResult<&BuilderOrder>> + '_ {
        (0..self.orders_len()).map(move |i| self.get_order(i))
    }

    pub fn iter_approved_builders(&self) -> impl Iterator<Item = DriftResult<&BuilderInfo>> + '_ {
        (0..self.approved_builders_len()).map(move |i| self.get_approved_builder(i))
    }
}

pub struct BuilderEscrowZeroCopyMut<'a> {
    pub fixed: RefMut<'a, BuilderEscrowFixed>,
    pub data: RefMut<'a, [u8]>,
}

impl<'a> BuilderEscrowZeroCopyMut<'a> {
    pub fn has_referrer(&self) -> bool {
        self.fixed.referrer != Pubkey::default()
    }

    pub fn get_referrer(&self) -> Option<Pubkey> {
        if self.has_referrer() {
            Some(self.fixed.referrer)
        } else {
            None
        }
    }

    pub fn orders_len(&self) -> u32 {
        // skip BuilderEscrow.padding0
        let length_bytes = &self.data[4..8];
        u32::from_le_bytes([
            length_bytes[0],
            length_bytes[1],
            length_bytes[2],
            length_bytes[3],
        ])
    }
    pub fn approved_builders_len(&self) -> u32 {
        // Calculate offset to the approved_builders Vec length
        let orders_data_size = self.orders_len() as usize * std::mem::size_of::<BuilderOrder>();
        let offset = 4 + // BuilderEscrow.padding0
        4 + // vec len
        orders_data_size +
        4; // BuilderEscrow.padding1
        let length_bytes = &self.data[offset..offset + 4];
        u32::from_le_bytes([
            length_bytes[0],
            length_bytes[1],
            length_bytes[2],
            length_bytes[3],
        ])
    }

    pub fn get_order_mut(&mut self, index: u32) -> DriftResult<&mut BuilderOrder> {
        validate!(
            index < self.orders_len(),
            ErrorCode::DefaultError,
            "Order index out of bounds"
        )?;
        let size = std::mem::size_of::<BuilderOrder>();
        let start = 4 + // BuilderEscrow.padding0
        4 + // vec len
        index as usize * size;
        Ok(bytemuck::from_bytes_mut(
            &mut self.data[start..(start + size)],
        ))
    }

    /// Returns the index of an order for a given sub_account_id and order_id, if present.
    pub fn find_order_index(&self, sub_account_id: u16, order_id: u32) -> Option<u32> {
        for i in 0..self.orders_len() {
            if let Ok(existing_order) = self.get_order(i) {
                if existing_order.order_id == order_id
                    && existing_order.sub_account_id == sub_account_id
                {
                    return Some(i);
                }
            }
        }
        None
    }

    /// Returns the index for the referral order, creating one if necessary.
    pub fn find_or_create_referral_index(&mut self, market_index: u16) -> Option<u32> {
        // look for an existing referral order
        for i in 0..self.orders_len() {
            if let Ok(existing_order) = self.get_order(i) {
                if existing_order.is_referral_order() && existing_order.market_index == market_index
                {
                    return Some(i);
                }
            }
        }

        // try to create a referral order in an available order slot
        match self.add_order(BuilderOrder::new(
            0,
            0,
            0,
            0,
            MarketType::Spot,
            0,
            BuilderOrderBitFlag::Referral as u8,
            0,
        )) {
            Ok(idx) => Some(idx),
            Err(_) => {
                msg!("Failed to add referral order, BuilderEscrow is full");
                None
            }
        }
    }

    pub fn get_order(&self, index: u32) -> DriftResult<&BuilderOrder> {
        validate!(
            index < self.orders_len(),
            ErrorCode::DefaultError,
            "Order index out of bounds"
        )?;
        let size = std::mem::size_of::<BuilderOrder>();
        let start = 4 + // BuilderEscrow.padding0
        4 + // vec len
        index as usize * size; // orders data
        Ok(bytemuck::from_bytes(&self.data[start..start + size]))
    }

    pub fn get_approved_builder_mut(&mut self, index: u8) -> DriftResult<&mut BuilderInfo> {
        validate!(
            index < self.approved_builders_len().cast::<u8>()?,
            ErrorCode::DefaultError,
            "Builder index out of bounds, index: {}, orderslen: {}, builderslen: {}",
            index,
            self.orders_len(),
            self.approved_builders_len()
        )?;
        let size = std::mem::size_of::<BuilderInfo>();
        let offset = 4 + // BuilderEscrow.padding0
            4 + // vec len
            self.orders_len() as usize * std::mem::size_of::<BuilderOrder>() + // orders data
            4 + // BuilderEscrow.padding1
            4; // vec len
        let start = offset + index as usize * size;
        Ok(bytemuck::from_bytes_mut(
            &mut self.data[start..start + size],
        ))
    }

    pub fn add_order(&mut self, order: BuilderOrder) -> DriftResult<u32> {
        for i in 0..self.orders_len() {
            let existing_order = self.get_order_mut(i)?;
            if existing_order.is_mergeable(&order) {
                *existing_order = existing_order.merge(&order)?;
                return Ok(i);
            } else if existing_order.is_available() {
                *existing_order = order;
                return Ok(i);
            }
        }

        Err(ErrorCode::BuilderEscrowOrdersAccountFull.into())
    }

    pub fn find_order_mut(
        &mut self,
        sub_account_id: u16,
        order_id: u32,
    ) -> Option<&mut BuilderOrder> {
        for i in 0..self.orders_len() {
            if let Ok(existing_order) = self.get_order(i) {
                if existing_order.order_id == order_id
                    && existing_order.sub_account_id == sub_account_id
                {
                    return self.get_order_mut(i).ok();
                }
            }
        }
        None
    }

    pub fn find_order(&mut self, sub_account_id: u16, order_id: u32) -> Option<&BuilderOrder> {
        for i in 0..self.orders_len() {
            if let Ok(existing_order) = self.get_order(i) {
                if existing_order.order_id == order_id
                    && existing_order.sub_account_id == sub_account_id
                {
                    return self.get_order(i).ok();
                }
            }
        }
        None
    }

    /// Marks any [`BuilderOrder`]s as Complete if there is no longer a corresponding
    /// open order in the user's account. This is used to lazily reconcile state when
    /// in place_order and settle_pnl instead of requiring explicit updates on cancels.
    pub fn revoke_completed_orders(&mut self, user: &User) -> DriftResult<()> {
        for i in 0..self.orders_len() {
            if let Ok(builder_order) = self.get_order_mut(i) {
                if builder_order.is_referral_order() {
                    continue;
                }
                if user.sub_account_id != builder_order.sub_account_id {
                    continue;
                }
                if builder_order.is_open() && !builder_order.is_completed() {
                    let user_order = user.orders[builder_order.user_order_index as usize];
                    let still_open = user_order.status == OrderStatus::Open
                        && user_order.order_id == builder_order.order_id;
                    if !still_open {
                        if builder_order.fees_accrued > 0 {
                            builder_order.add_bit_flag(BuilderOrderBitFlag::Completed);
                        } else {
                            // order had no fees accrued, we can just clear out the slot
                            *builder_order = BuilderOrder::default();
                        }
                    }
                }
            }
        }

        Ok(())
    }
}

pub trait BuilderEscrowLoader<'a> {
    fn load_zc(&self) -> DriftResult<BuilderEscrowZeroCopy>;
    fn load_zc_mut(&self) -> DriftResult<BuilderEscrowZeroCopyMut>;
}

impl<'a> BuilderEscrowLoader<'a> for AccountInfo<'a> {
    fn load_zc(&self) -> DriftResult<BuilderEscrowZeroCopy> {
        let owner = self.owner;

        validate!(
            owner == &ID,
            ErrorCode::DefaultError,
            "invalid BuilderEscrow owner",
        )?;

        let data = self.try_borrow_data().safe_unwrap()?;

        let (discriminator, data) = Ref::map_split(data, |d| d.split_at(8));
        validate!(
            *discriminator == BuilderEscrow::discriminator(),
            ErrorCode::DefaultError,
            "invalid signed_msg user orders discriminator",
        )?;

        let hdr_size = std::mem::size_of::<BuilderEscrowFixed>();
        let (fixed, data) = Ref::map_split(data, |d| d.split_at(hdr_size));
        Ok(BuilderEscrowZeroCopy {
            fixed: Ref::map(fixed, |b| bytemuck::from_bytes(b)),
            data,
        })
    }

    fn load_zc_mut(&self) -> DriftResult<BuilderEscrowZeroCopyMut> {
        let owner = self.owner;

        validate!(
            owner == &ID,
            ErrorCode::DefaultError,
            "invalid BuilderEscrow owner",
        )?;

        let data = self.try_borrow_mut_data().safe_unwrap()?;

        let (discriminator, data) = RefMut::map_split(data, |d| d.split_at_mut(8));
        validate!(
            *discriminator == BuilderEscrow::discriminator(),
            ErrorCode::DefaultError,
            "invalid signed_msg user orders discriminator",
        )?;

        let hdr_size = std::mem::size_of::<BuilderEscrowFixed>();
        let (fixed, data) = RefMut::map_split(data, |d| d.split_at_mut(hdr_size));
        Ok(BuilderEscrowZeroCopyMut {
            fixed: RefMut::map(fixed, |b| bytemuck::from_bytes_mut(b)),
            data,
        })
    }
}
