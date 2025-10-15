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

pub const REVENUE_SHARE_PDA_SEED: &str = "REV_SHARE";
pub const REVENUE_SHARE_ESCROW_PDA_SEED: &str = "REV_ESCROW";

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq, Default)]
pub enum RevenueShareOrderBitFlag {
    #[default]
    Init = 0b00000000,
    Open = 0b00000001,
    Completed = 0b00000010,
    Referral = 0b00000100,
}

#[account(zero_copy(unsafe))]
#[derive(Eq, PartialEq, Debug, Default)]
pub struct RevenueShare {
    /// the owner of this account, a builder or referrer
    pub authority: Pubkey,
    pub total_referrer_rewards: u64,
    pub total_builder_rewards: u64,
    pub padding: [u8; 18],
}

impl RevenueShare {
    pub fn space() -> usize {
        8 + 32 + 8 + 8 + 18
    }
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
pub struct RevenueShareOrder {
    /// fees accrued so far for this order slot. This is not exclusively fees from this order_id
    /// and may include fees from other orders in the same market. This may be swept to the
    /// builder's SpotPosition during settle_pnl.
    pub fees_accrued: u64,
    /// the order_id of the current active order in this slot. It's only relevant while bit_flag = Open
    pub order_id: u32,
    /// the builder fee on this order, in tenths of a bps, e.g. 100 = 0.01%
    pub fee_tenth_bps: u16,
    pub market_index: u16,
    /// the subaccount_id of the user who created this order. It's only relevant while bit_flag = Open
    pub sub_account_id: u16,
    /// the index of the RevenueShareEscrow.approved_builders list, that this order's fee will settle to. Ignored
    /// if bit_flag = Referral.
    pub builder_idx: u8,
    /// bitflags that describe the state of the order.
    /// [`RevenueShareOrderBitFlag::Init`]: this order slot is available for use.
    /// [`RevenueShareOrderBitFlag::Open`]: this order slot is occupied, `order_id` is the `sub_account_id`'s active order.
    /// [`RevenueShareOrderBitFlag::Completed`]: this order has been filled or canceled, and is waiting to be settled into.
    /// the builder's account order_id and sub_account_id are no longer relevant, it may be merged with other orders.
    /// [`RevenueShareOrderBitFlag::Referral`]: this order stores referral rewards waiting to be settled for this market.
    /// If it is set, no other bitflag should be set.
    pub bit_flags: u8,
    /// the index into the User's orders list when this RevenueShareOrder was created, make sure to verify that order_id matches.
    pub user_order_index: u8,
    pub market_type: MarketType,
    pub padding: [u8; 10],
}

impl RevenueShareOrder {
    pub fn new(
        builder_idx: u8,
        sub_account_id: u16,
        order_id: u32,
        fee_tenth_bps: u16,
        market_type: MarketType,
        market_index: u16,
        bit_flags: u8,
        user_order_index: u8,
    ) -> Self {
        Self {
            builder_idx,
            order_id,
            fee_tenth_bps,
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
        std::mem::size_of::<RevenueShareOrder>()
    }

    pub fn add_bit_flag(&mut self, flag: RevenueShareOrderBitFlag) {
        self.bit_flags |= flag as u8;
    }

    pub fn is_bit_flag_set(&self, flag: RevenueShareOrderBitFlag) -> bool {
        (self.bit_flags & flag as u8) != 0
    }

    // An order is Open after it is created, the slot is considered occupied
    // and it is waiting to become `Completed` (filled or canceled).
    pub fn is_open(&self) -> bool {
        self.is_bit_flag_set(RevenueShareOrderBitFlag::Open)
    }

    // An order is Completed after it is filled or canceled. It is waiting to be settled
    // into the builder's account
    pub fn is_completed(&self) -> bool {
        self.is_bit_flag_set(RevenueShareOrderBitFlag::Completed)
    }

    /// An order slot is available (can be written to) if it is neither Completed nor Open.
    pub fn is_available(&self) -> bool {
        !self.is_completed() && !self.is_open() && !self.is_referral_order()
    }

    pub fn is_referral_order(&self) -> bool {
        self.is_bit_flag_set(RevenueShareOrderBitFlag::Referral)
    }

    /// Checks if `self` can be merged with `other`. Merged orders track cumulative fees accrued
    /// and are settled together, making more efficient use of the orders list.
    pub fn is_mergeable(&self, other: &RevenueShareOrder) -> bool {
        (self.is_referral_order() == other.is_referral_order())
            && other.is_completed()
            && other.market_index == self.market_index
            && other.market_type == self.market_type
            && other.builder_idx == self.builder_idx
    }

    /// Merges `other` into `self`. The orders must be mergeable.
    pub fn merge(mut self, other: &RevenueShareOrder) -> DriftResult<RevenueShareOrder> {
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
    pub authority: Pubkey, // builder authority
    pub max_fee_tenth_bps: u16,
    pub padding: [u8; 6],
}

impl BuilderInfo {
    pub fn space() -> usize {
        std::mem::size_of::<BuilderInfo>()
    }

    pub fn is_revoked(&self) -> bool {
        self.max_fee_tenth_bps == 0
    }
}

#[account]
#[derive(Eq, PartialEq, Debug)]
#[repr(C)]
pub struct RevenueShareEscrow {
    /// the owner of this account, a user
    pub authority: Pubkey,
    pub referrer: Pubkey,
    pub referrer_boost_expire_ts: u32,
    pub referrer_reward_offset: i8,
    pub referee_fee_numerator_offset: i8,
    pub referrer_boost_numerator: i8,
    pub reserved_fixed: [u8; 17],
    pub padding0: u32, // align with [`RevenueShareEscrow::orders`] 4 bytes len prefix
    pub orders: Vec<RevenueShareOrder>,
    pub padding1: u32, // align with [`RevenueShareEscrow::approved_builders`] 4 bytes len prefix
    pub approved_builders: Vec<BuilderInfo>,
}

impl RevenueShareEscrow {
    pub fn space(num_orders: usize, num_builders: usize) -> usize {
        8 + // discriminator
        std::mem::size_of::<RevenueShareEscrowFixed>() + // fixed header
        4 + // orders Vec length prefix
        4 + // padding0
        num_orders * std::mem::size_of::<RevenueShareOrder>() + // orders data
        4 + // approved_builders Vec length prefix
        4 + // padding1
        num_builders * std::mem::size_of::<BuilderInfo>() // builders data
    }

    pub fn validate(&self) -> DriftResult<()> {
        validate!(
            self.orders.len() <= 128 && self.approved_builders.len() <= 128,
            ErrorCode::DefaultError,
            "RevenueShareEscrow orders and approved_builders len must be between 1 and 128"
        )?;
        Ok(())
    }
}

#[zero_copy]
#[derive(Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct RevenueShareEscrowFixed {
    pub authority: Pubkey,
    pub referrer: Pubkey,
    pub referrer_boost_expire_ts: u32,
    pub referrer_reward_offset: i8,
    pub referee_fee_numerator_offset: i8,
    pub referrer_boost_numerator: i8,
    pub reserved_fixed: [u8; 17],
}

impl Default for RevenueShareEscrowFixed {
    fn default() -> Self {
        Self {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            referrer_boost_expire_ts: 0,
            referrer_reward_offset: 0,
            referee_fee_numerator_offset: 0,
            referrer_boost_numerator: 0,
            reserved_fixed: [0; 17],
        }
    }
}

impl Default for RevenueShareEscrow {
    fn default() -> Self {
        Self {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            referrer_boost_expire_ts: 0,
            referrer_reward_offset: 0,
            referee_fee_numerator_offset: 0,
            referrer_boost_numerator: 0,
            reserved_fixed: [0; 17],
            padding0: 0,
            orders: Vec::new(),
            padding1: 0,
            approved_builders: Vec::new(),
        }
    }
}

pub struct RevenueShareEscrowZeroCopy<'a> {
    pub fixed: Ref<'a, RevenueShareEscrowFixed>,
    pub data: Ref<'a, [u8]>,
}

impl<'a> RevenueShareEscrowZeroCopy<'a> {
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
        let orders_data_size =
            self.orders_len() as usize * std::mem::size_of::<RevenueShareOrder>();
        let offset = 4 + // RevenueShareEscrow.padding0
        4 + // vec len
        orders_data_size + 4; // RevenueShareEscrow.padding1
        let length_bytes = &self.data[offset..offset + 4];
        u32::from_le_bytes([
            length_bytes[0],
            length_bytes[1],
            length_bytes[2],
            length_bytes[3],
        ])
    }

    pub fn get_order(&self, index: u32) -> DriftResult<&RevenueShareOrder> {
        validate!(
            index < self.orders_len(),
            ErrorCode::DefaultError,
            "Order index out of bounds"
        )?;
        let size = std::mem::size_of::<RevenueShareOrder>();
        let start = 4 + // RevenueShareEscrow.padding0
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
            self.orders_len() as usize * std::mem::size_of::<RevenueShareOrder>() + // orders data
            4; // Skip approved_builders Vec length prefix + padding1
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

pub struct RevenueShareEscrowZeroCopyMut<'a> {
    pub fixed: RefMut<'a, RevenueShareEscrowFixed>,
    pub data: RefMut<'a, [u8]>,
}

impl<'a> RevenueShareEscrowZeroCopyMut<'a> {
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
        // skip RevenueShareEscrow.padding0
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
        let orders_data_size =
            self.orders_len() as usize * std::mem::size_of::<RevenueShareOrder>();
        let offset = 4 + // RevenueShareEscrow.padding0
        4 + // vec len
        orders_data_size +
        4; // RevenueShareEscrow.padding1
        let length_bytes = &self.data[offset..offset + 4];
        u32::from_le_bytes([
            length_bytes[0],
            length_bytes[1],
            length_bytes[2],
            length_bytes[3],
        ])
    }

    pub fn get_order_mut(&mut self, index: u32) -> DriftResult<&mut RevenueShareOrder> {
        validate!(
            index < self.orders_len(),
            ErrorCode::DefaultError,
            "Order index out of bounds"
        )?;
        let size = std::mem::size_of::<RevenueShareOrder>();
        let start = 4 + // RevenueShareEscrow.padding0
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

    /// Returns the index for the referral order, creating one if necessary. Returns None if a new order
    /// cannot be created.
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
        match self.add_order(RevenueShareOrder::new(
            0,
            0,
            0,
            0,
            MarketType::Perp,
            market_index,
            RevenueShareOrderBitFlag::Referral as u8,
            0,
        )) {
            Ok(idx) => Some(idx),
            Err(_) => {
                msg!("Failed to add referral order, RevenueShareEscrow is full");
                None
            }
        }
    }

    pub fn get_order(&self, index: u32) -> DriftResult<&RevenueShareOrder> {
        validate!(
            index < self.orders_len(),
            ErrorCode::DefaultError,
            "Order index out of bounds"
        )?;
        let size = std::mem::size_of::<RevenueShareOrder>();
        let start = 4 + // RevenueShareEscrow.padding0
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
        let offset = 4 + // RevenueShareEscrow.padding0
            4 + // vec len
            self.orders_len() as usize * std::mem::size_of::<RevenueShareOrder>() + // orders data
            4 + // RevenueShareEscrow.padding1
            4; // vec len
        let start = offset + index as usize * size;
        Ok(bytemuck::from_bytes_mut(
            &mut self.data[start..start + size],
        ))
    }

    pub fn add_order(&mut self, order: RevenueShareOrder) -> DriftResult<u32> {
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

        Err(ErrorCode::RevenueShareEscrowOrdersAccountFull.into())
    }

    /// Marks any [`RevenueShareOrder`]s as Complete if there is no longer a corresponding
    /// open order in the user's account. This is used to lazily reconcile state when
    /// in place_order and settle_pnl instead of requiring explicit updates on cancels.
    pub fn revoke_completed_orders(&mut self, user: &User) -> DriftResult<()> {
        for i in 0..self.orders_len() {
            if let Ok(rev_share_order) = self.get_order_mut(i) {
                if rev_share_order.is_referral_order() {
                    continue;
                }
                if user.sub_account_id != rev_share_order.sub_account_id {
                    continue;
                }
                if rev_share_order.is_open() && !rev_share_order.is_completed() {
                    let user_order = user.orders[rev_share_order.user_order_index as usize];
                    let still_open = user_order.status == OrderStatus::Open
                        && user_order.order_id == rev_share_order.order_id;
                    if !still_open {
                        if rev_share_order.fees_accrued > 0 {
                            rev_share_order.add_bit_flag(RevenueShareOrderBitFlag::Completed);
                        } else {
                            // order had no fees accrued, we can just clear out the slot
                            *rev_share_order = RevenueShareOrder::default();
                        }
                    }
                }
            }
        }

        Ok(())
    }
}

pub trait RevenueShareEscrowLoader<'a> {
    fn load_zc(&self) -> DriftResult<RevenueShareEscrowZeroCopy>;
    fn load_zc_mut(&self) -> DriftResult<RevenueShareEscrowZeroCopyMut>;
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
}
