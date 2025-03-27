use std::cell::{Ref, RefMut};

use crate::error::{DriftResult, ErrorCode};
use crate::math::safe_unwrap::SafeUnwrap;
use crate::msg;
use crate::{validate, ID};
use anchor_lang::prelude::Pubkey;
use anchor_lang::*;
use anchor_lang::{account, zero_copy};
use borsh::{BorshDeserialize, BorshSerialize};
use prelude::AccountInfo;

use crate::state::traits::Size;

pub const SIGNED_MSG_PDA_SEED: &str = "SIGNED_MSG";
pub const SIGNED_MSG_WS_PDA_SEED: &str = "SIGNED_MSG_WS";
pub const SIGNED_MSG_SLOT_EVICTION_BUFFER: u64 = 10;

mod tests;

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
pub struct SignedMsgOrderId {
    pub uuid: [u8; 8],
    pub max_slot: u64,
    pub order_id: u32,
    pub padding: u32,
}

impl SignedMsgOrderId {
    pub fn new(uuid: [u8; 8], max_slot: u64, order_id: u32) -> Self {
        Self {
            uuid,
            max_slot,
            order_id,
            padding: 0,
        }
    }
}

impl Size for SignedMsgUserOrders {
    const SIZE: usize = 816;
}

/**
 * This struct is a duplicate of SignedMsgUserOrdersZeroCopy
 * It is used to give anchor an struct to generate the idl for clients
 * The struct SignedMsgUserOrdersZeroCopy is used to load the data in efficiently
 */
#[account]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct SignedMsgUserOrders {
    pub authority_pubkey: Pubkey,
    pub padding: u32,
    pub signed_msg_order_data: Vec<SignedMsgOrderId>,
}

impl SignedMsgUserOrders {
    /// 8 orders - 268 bytes - 0.00275616 SOL for rent
    /// 16 orders - 460 bytes - 0.00409248 SOL for rent
    /// 32 orders - 844 bytes - 0.00676512 SOL for rent
    /// 64 orders - 1612 bytes - 0.012110400 SOL for rent
    pub fn space(num_orders: usize) -> usize {
        8 + 32 + 4 + 32 + num_orders * 24
    }

    pub fn validate(&self) -> DriftResult<()> {
        validate!(
            self.signed_msg_order_data.len() >= 1 && self.signed_msg_order_data.len() <= 128,
            ErrorCode::DefaultError,
            "SignedMsgUserOrders len must be between 1 and 128"
        )?;
        Ok(())
    }
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
pub struct SignedMsgUserOrdersFixed {
    pub user_pubkey: Pubkey,
    pub padding: u32,
    pub len: u32,
}

pub struct SignedMsgUserOrdersZeroCopy<'a> {
    pub fixed: Ref<'a, SignedMsgUserOrdersFixed>,
    pub data: Ref<'a, [u8]>,
}

impl<'a> SignedMsgUserOrdersZeroCopy<'a> {
    pub fn len(&self) -> u32 {
        self.fixed.len
    }

    pub fn get(&self, index: u32) -> &SignedMsgOrderId {
        let size = std::mem::size_of::<SignedMsgOrderId>();
        let start = index as usize * size;
        bytemuck::from_bytes(&self.data[start..start + size])
    }

    pub fn iter(&self) -> impl Iterator<Item = &SignedMsgOrderId> + '_ {
        (0..self.len()).map(move |i| self.get(i))
    }
}

pub struct SignedMsgUserOrdersZeroCopyMut<'a> {
    pub fixed: RefMut<'a, SignedMsgUserOrdersFixed>,
    pub data: RefMut<'a, [u8]>,
}

impl<'a> SignedMsgUserOrdersZeroCopyMut<'a> {
    pub fn len(&self) -> u32 {
        self.fixed.len
    }

    pub fn get_mut(&mut self, index: u32) -> &mut SignedMsgOrderId {
        let size = std::mem::size_of::<SignedMsgOrderId>();
        let start = index as usize * size;
        bytemuck::from_bytes_mut(&mut self.data[start..start + size])
    }

    pub fn check_exists_and_prune_stale_signed_msg_order_ids(
        &mut self,
        signed_msg_order_id: SignedMsgOrderId,
        current_slot: u64,
    ) -> bool {
        let mut uuid_exists = false;
        for i in 0..self.len() {
            let existing_signed_msg_order_id = self.get_mut(i);
            if existing_signed_msg_order_id.uuid == signed_msg_order_id.uuid
                && existing_signed_msg_order_id.max_slot + SIGNED_MSG_SLOT_EVICTION_BUFFER
                    >= current_slot
            {
                uuid_exists = true;
            } else {
                if existing_signed_msg_order_id.max_slot + SIGNED_MSG_SLOT_EVICTION_BUFFER
                    < current_slot
                {
                    existing_signed_msg_order_id.uuid = [0; 8];
                    existing_signed_msg_order_id.max_slot = 0;
                    existing_signed_msg_order_id.order_id = 0;
                }
            }
        }
        uuid_exists
    }

    pub fn add_signed_msg_order_id(
        &mut self,
        signed_msg_order_id: SignedMsgOrderId,
    ) -> DriftResult {
        if signed_msg_order_id.max_slot == 0
            || signed_msg_order_id.order_id == 0
            || signed_msg_order_id.uuid == [0; 8]
        {
            return Err(ErrorCode::InvalidSignedMsgOrderId.into());
        }

        for i in 0..self.len() {
            if self.get_mut(i).max_slot == 0 {
                *self.get_mut(i) = signed_msg_order_id;
                return Ok(());
            }
        }

        Err(ErrorCode::SignedMsgUserOrdersAccountFull.into())
    }
}

pub trait SignedMsgUserOrdersLoader<'a> {
    fn load(&self) -> DriftResult<SignedMsgUserOrdersZeroCopy>;
    fn load_mut(&self) -> DriftResult<SignedMsgUserOrdersZeroCopyMut>;
}

impl<'a> SignedMsgUserOrdersLoader<'a> for AccountInfo<'a> {
    fn load(&self) -> DriftResult<SignedMsgUserOrdersZeroCopy> {
        let owner = self.owner;

        validate!(
            owner == &ID,
            ErrorCode::DefaultError,
            "invalid signed_msg user orders owner",
        )?;

        let data = self.try_borrow_data().safe_unwrap()?;

        let (discriminator, data) = Ref::map_split(data, |d| d.split_at(8));
        validate!(
            *discriminator == SignedMsgUserOrders::discriminator(),
            ErrorCode::DefaultError,
            "invalid signed_msg user orders discriminator",
        )?;

        let (fixed, data) = Ref::map_split(data, |d| d.split_at(40));
        Ok(SignedMsgUserOrdersZeroCopy {
            fixed: Ref::map(fixed, |b| bytemuck::from_bytes(b)),
            data,
        })
    }

    fn load_mut(&self) -> DriftResult<SignedMsgUserOrdersZeroCopyMut> {
        let owner = self.owner;

        validate!(
            owner == &ID,
            ErrorCode::DefaultError,
            "invalid signed_msg user orders owner",
        )?;

        let data = self.try_borrow_mut_data().safe_unwrap()?;

        let (discriminator, data) = RefMut::map_split(data, |d| d.split_at_mut(8));
        validate!(
            *discriminator == SignedMsgUserOrders::discriminator(),
            ErrorCode::DefaultError,
            "invalid signed_msg user orders discriminator",
        )?;

        let (fixed, data) = RefMut::map_split(data, |d| d.split_at_mut(40));
        Ok(SignedMsgUserOrdersZeroCopyMut {
            fixed: RefMut::map(fixed, |b| bytemuck::from_bytes_mut(b)),
            data,
        })
    }
}

pub fn derive_signed_msg_user_pda(user_account_pubkey: &Pubkey) -> DriftResult<Pubkey> {
    let (signed_msg_pubkey, _) = Pubkey::find_program_address(
        &[SIGNED_MSG_PDA_SEED.as_bytes(), user_account_pubkey.as_ref()],
        &ID,
    );
    Ok(signed_msg_pubkey)
}

/**
 * Used to store authenticated delegates for swift-like ws connections
 */
#[account]
#[derive(Default, Eq, PartialEq, Debug)]
pub struct SignedMsgWsDelegates {
    pub delegates: Vec<Pubkey>,
}

impl SignedMsgWsDelegates {
    pub fn space(&self, add: bool) -> usize {
        let delegate_count = if add {
            self.delegates.len() + 1
        } else {
            self.delegates.len() - 1
        };
        8 + 4 + delegate_count * 32
    }
}
