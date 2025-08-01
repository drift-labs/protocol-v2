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
use crate::validate;
use crate::{impl_zero_copy_loader, msg, ID};

pub const REVENUE_SHARE_PDA_SEED: &str = "REV_SHARE";
pub const REVENUE_SHARE_ESCROW_PDA_SEED: &str = "REV_ESCROW";

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
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
#[repr(C)]
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
#[repr(C)]
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
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct RevenueShareOrder {
    /// set in place_order
    pub beneficiary: Pubkey, // builder/referrer, 111... if zeroed
    pub order_id: u32,
    pub fee_bps: u8,
    pub market_type: u8,
    pub market_index: u16,

    /// set in fill_order
    /// u64 max fee is $18T, u32 is $4k
    /// this gets sweeped into into the Builder's RevenueShare in settle_pnl
    pub fee_accrued: u64,

    /// set in fill_order or cancel_order
    /// some way to signal that the order was filled or canceled
    /// if order is complete, then zero out after sweeping
    /// * should this also signal if it's a referrer or builder rev share?
    pub bit_flags: u8,

    pub padding: [u8; 15], // idk if need padding
}

impl RevenueShareOrder {
    pub fn space() -> usize {
        32 + 4 + 1 + 1 + 2 + 8 + 1 + 15
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

impl Size for RevenueShareEscrow {
    const SIZE: usize = 1000; // whats this for given that it can be reized?
}

impl RevenueShareEscrow {
    pub fn space(num_orders: usize, num_builders: usize) -> usize {
        8 + 32
            + 32
            + 32
            + num_orders * RevenueShareOrder::space()
            + 32
            + num_builders * BuilderInfo::space()
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
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct RevenueShareEscrowFixed {
    pub authority: Pubkey,
    pub referrer: Pubkey,
    pub orders_len: u32,
    pub approved_builders_len: u32,
}

pub struct RevenueShareEscrowZeroCopy<'a> {
    pub fixed: Ref<'a, RevenueShareEscrowFixed>,
    pub data: Ref<'a, [u8]>,
}

impl<'a> RevenueShareEscrowZeroCopy<'a> {
    pub fn orders_len(&self) -> u32 {
        self.fixed.orders_len
    }
    pub fn approved_builders_len(&self) -> u32 {
        self.fixed.approved_builders_len
    }

    pub fn get_order(&self, index: u32) -> &RevenueShareOrder {
        let size = std::mem::size_of::<RevenueShareOrder>();
        let start = index as usize * size;
        bytemuck::from_bytes(&self.data[start..start + size])
    }

    pub fn get_approved_builder(&self, index: u32) -> &BuilderInfo {
        let size = std::mem::size_of::<BuilderInfo>();
        let offset = self.orders_len() as usize * std::mem::size_of::<RevenueShareOrder>();
        let start = offset + index as usize * size;
        bytemuck::from_bytes(&self.data[start..start + size])
    }

    pub fn iter_orders(&self) -> impl Iterator<Item = &RevenueShareOrder> + '_ {
        (0..self.orders_len()).map(move |i| self.get_order(i))
    }

    pub fn iter_approved_builders(&self) -> impl Iterator<Item = &BuilderInfo> + '_ {
        (0..self.approved_builders_len()).map(move |i| self.get_approved_builder(i))
    }
}

pub struct RevenueShareEscrowZeroCopyMut<'a> {
    pub fixed: RefMut<'a, RevenueShareEscrowFixed>,
    pub data: RefMut<'a, [u8]>,
}

impl<'a> RevenueShareEscrowZeroCopyMut<'a> {
    pub fn orders_len(&self) -> u32 {
        self.fixed.orders_len
    }
    pub fn approved_builders_len(&self) -> u32 {
        self.fixed.approved_builders_len
    }

    pub fn get_order_mut(&mut self, index: u32) -> &mut RevenueShareOrder {
        let size = std::mem::size_of::<RevenueShareOrder>();
        let start = index as usize * size;
        bytemuck::from_bytes_mut(&mut self.data[start..start + size])
    }

    pub fn get_approved_builder_mut(&mut self, index: u32) -> &mut BuilderInfo {
        let size = std::mem::size_of::<BuilderInfo>();
        let offset = self.orders_len() as usize * std::mem::size_of::<RevenueShareOrder>();
        let start = offset + index as usize * size;
        bytemuck::from_bytes_mut(&mut self.data[start..start + size])
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

        let (fixed, data) = Ref::map_split(data, |d| d.split_at(40));
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

        let (fixed, data) = RefMut::map_split(data, |d| d.split_at_mut(40));
        Ok(RevenueShareEscrowZeroCopyMut {
            fixed: RefMut::map(fixed, |b| bytemuck::from_bytes_mut(b)),
            data,
        })
    }
}
