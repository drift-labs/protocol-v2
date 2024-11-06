use std::cell::{Ref, RefMut};

use anchor_lang::*;
use borsh::{BorshDeserialize, BorshSerialize};
use prelude::AccountInfo;
use crate::error::{DriftResult, ErrorCode};
use crate::math::safe_unwrap::SafeUnwrap;
use crate::{validate, ID};
use anchor_lang::prelude::Pubkey;
use anchor_lang::{account, zero_copy};
use solana_program::msg;

use crate::state::traits::Size;

pub const SWIFT_PDA_SEED: &str = "SWIFT";
pub const SWIFT_SLOT_EVICTION_BUFFER: u64 = 10;

mod tests;

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
pub struct SwiftOrderId {
    pub uuid: [u8; 8],
    pub max_slot: u64,
    pub order_id: u32,
    pub padding: u32,
}

impl SwiftOrderId {
    pub fn new(uuid: [u8; 8], max_slot: u64, order_id: u32) -> Self {
        Self {
            uuid,
            max_slot,
            order_id,
            padding: 0,
        }
    }
}

impl Size for SwiftUserOrders {
    const SIZE: usize = 816;
}

#[account]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct SwiftUserOrders {
    pub user_pubkey: Pubkey,
    pub padding: u32,
    pub swift_order_data: Vec<SwiftOrderId>,
}

#[zero_copy]
#[derive(Default, Eq, PartialEq, Debug)]
pub struct SwiftUserOrdersFixed {
    pub user_pubkey: Pubkey,
    pub padding: u32,
    pub len: u32,
}

pub struct SwiftUserOrdersZeroCopy<'a> {
    pub fixed: Ref<'a, SwiftUserOrdersFixed>,
    pub data: Ref<'a, [u8]>,
}

impl<'a> SwiftUserOrdersZeroCopy<'a> {
    pub fn len(&self) -> u32 {
        self.fixed.len
    }

    pub fn get(&self, index: u32) -> &SwiftOrderId {
        let size = std::mem::size_of::<SwiftOrderId>();
        let start = index as usize * size;
        bytemuck::from_bytes(&self.data[start..start + size])
    }

    pub fn iter(&self) -> impl Iterator<Item = &SwiftOrderId> + '_ {
        (0..self.len()).map(move |i| self.get(i))
    }
}

pub struct SwiftUserOrdersZeroCopyMut<'a> {
    pub fixed: RefMut<'a, SwiftUserOrdersFixed>,
    pub data: RefMut<'a, [u8]>,
}

impl<'a> SwiftUserOrdersZeroCopyMut<'a> {
    pub fn len(&self) -> u32 {
        self.fixed.len
    }

    pub fn get_mut(&mut self, index: u32) -> &mut SwiftOrderId {
        let size = std::mem::size_of::<SwiftOrderId>();
        let start = index as usize * size;
        bytemuck::from_bytes_mut(&mut 
            self.data[start..start + size])
    }

    pub fn check_exists_and_prune_stale_swift_order_ids(
        &mut self,
        swift_order_id: SwiftOrderId,
        current_slot: u64,
    ) -> bool {
        let mut uuid_exists = false;
        for i in 0..self.len() {
            let existing_swift_order_id = self.get_mut(i);
            if existing_swift_order_id.uuid == swift_order_id.uuid
                && existing_swift_order_id.max_slot + SWIFT_SLOT_EVICTION_BUFFER >= current_slot
            {
                uuid_exists = true;
            } else {
                if existing_swift_order_id.max_slot + SWIFT_SLOT_EVICTION_BUFFER < current_slot {
                    existing_swift_order_id.uuid = [0; 8];
                    existing_swift_order_id.max_slot = 0;
                    existing_swift_order_id.order_id = 0;
                }
            }
        }
        uuid_exists
    }

    pub fn add_swift_order_id(&mut self, swift_order_id: SwiftOrderId) -> DriftResult {
        if swift_order_id.max_slot == 0
            || swift_order_id.order_id == 0
            || swift_order_id.uuid == [0; 8]
        {
            return Err(ErrorCode::InvalidSwiftOrderId.into());
        }

        for i in 0..self.len() {
            if self.get_mut(i).max_slot == 0 {
                *self.get_mut(i) = swift_order_id;
                return Ok(());
            }
        }

        Err(ErrorCode::SwiftUserOrdersAccountFull.into())
    }
}

pub trait SwiftUserOrdersLoader<'a> {
    fn load(&self) -> DriftResult<SwiftUserOrdersZeroCopy>;
    fn load_mut(&self) -> DriftResult<SwiftUserOrdersZeroCopyMut>;
}

impl<'a> SwiftUserOrdersLoader<'a> for AccountInfo<'a> {
    fn load(&self) -> DriftResult<SwiftUserOrdersZeroCopy> {
        let owner = self.owner;

        validate!(
            owner == &ID,
            ErrorCode::DefaultError,
            "invalid swift user orders owner",
        );

        let data = self.try_borrow_data().safe_unwrap()?;

        let (discriminator, data) = Ref::map_split(data, |d| d.split_at(8));
        validate!(
            *discriminator == SwiftUserOrders::discriminator(),
            ErrorCode::DefaultError,
            "invalid swift user orders discriminator",
        );

        let (fixed, data) = Ref::map_split(data, |d| d.split_at(40));
        Ok(SwiftUserOrdersZeroCopy { fixed: Ref::map(fixed, |b| bytemuck::from_bytes(b)), data })
    }

    fn load_mut(&self) -> DriftResult<SwiftUserOrdersZeroCopyMut> {
        let owner = self.owner;

        validate!(
            owner == &ID,
            ErrorCode::DefaultError,
            "invalid swift user orders owner",
        );

        let data = self.try_borrow_mut_data().safe_unwrap()?;

        let (discriminator, data) = RefMut::map_split(data, |d| d.split_at_mut(8));
        validate!(
            *discriminator == SwiftUserOrders::discriminator(),
            ErrorCode::DefaultError,
            "invalid swift user orders discriminator",
        );

        let (fixed, data) = RefMut::map_split(data, |d| d.split_at_mut(40));
        Ok(SwiftUserOrdersZeroCopyMut { fixed: RefMut::map(fixed, |b| bytemuck::from_bytes_mut(b)), data })
    }
}


pub fn derive_swift_user_pda(user_account_pubkey: &Pubkey) -> DriftResult<Pubkey> {
    let (swift_pubkey, _) = Pubkey::find_program_address(
        &[SWIFT_PDA_SEED.as_bytes(), user_account_pubkey.as_ref()],
        &ID,
    );
    Ok(swift_pubkey)
}

// #[account]
// #[derive(Default, Eq, PartialEq, Debug)]
// pub struct SwiftUserOrders2 {
//     pub user_pubkey: Pubkey,
//     pub padding: u32,
//     pub swift_order_data: Vec<SwiftOrderId2>,
// }

// #[zero_copy]
// #[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
// pub struct SwiftOrderId2 {
//     pub uuid: [u8; 8],
//     pub max_slot: u64,
//     pub order_id: u32,
//     pub padding: u32,
// }

// #[zero_copy]
// #[derive(Default, Eq, PartialEq, Debug)]
// pub struct SwiftUserOrdersFixed {
//     pub user_pubkey: Pubkey,
//     pub padding: u32,
//     pub len: u32,
// }

// #[derive(Debug)]
// pub struct SwiftUserOrdersZeroCopy<'a> {
//     pub fixed: Ref<'a, SwiftUserOrdersFixed>,
//     pub data: Ref<'a, [u8]>,
// }

// impl<'a> SwiftUserOrdersZeroCopy<'a> {
//     pub fn deserialize(data: Ref<'a, &[u8]>) -> DriftResult<Self> {
//         let (fixed, data) = Ref::map_split(data, |d| d.split_at(40));
//         Ok(Self { fixed: Ref::map(fixed, |b| bytemuck::from_bytes(b)), data })
//     }

//     pub fn len(&self) -> u32 {
//         self.fixed.len
//     }

//     pub fn get(&self, index: u32) -> &SwiftOrderId2 {
//         let size = std::mem::size_of::<SwiftOrderId2>();
//         let start = index as usize * size;
//         println!("size {}", size);
//         println!("start {}", start);
//         bytemuck::from_bytes(&self.data[start..start + size])
//     }
// }


#[cfg(test)]
mod tests2 {
    use std::cell::RefCell;

    use super::*;

    #[test]
    fn tests() {
        println!("fixed size {}", std::mem::size_of::<SwiftUserOrders>());
    }
}

// #[cfg(test)]
// mod tests2 {
//     use std::cell::RefCell;

//     use super::*;

//     #[test]
//     fn test_swift_user_orders_3() {
//         println!("fixed size {}", std::mem::size_of::<SwiftUserOrdersFixed>());
//         let mut orders: SwiftUserOrders2 = SwiftUserOrders2 {
//             user_pubkey: Pubkey::default(),
//             padding: 0,
//             swift_order_data: Vec::with_capacity(100),
//         };

//         for i in 0..100 {
//             orders.swift_order_data.push(SwiftOrderId2 {
//                 uuid: [0; 8],
//                 max_slot: 0,
//                 order_id: i as u32,
//                 padding: 0,
//             });
//         }
//         let bytes = orders.try_to_vec().unwrap();
//         let bytes_ref = RefCell::new(&bytes[..]);
//         let orders_fixed = SwiftUserOrdersZeroCopy::deserialize(bytes_ref.borrow()).unwrap();
//         assert_eq!(orders_fixed.fixed.len, 100);
//         for i in 0..100 {
//             println!("i {}", i);
//             assert_eq!(orders_fixed.get(i), &SwiftOrderId2 {
//                 uuid: [0; 8],
//                 max_slot: 0,
//                 order_id: i as u32,
//                 padding: 0,
//             });
//         }
//     }
// }
