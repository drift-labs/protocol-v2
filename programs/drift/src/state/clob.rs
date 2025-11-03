use std::cell::{Ref, RefMut};
use anchor_lang::*;
use anchor_lang::prelude::Pubkey;
use bytemuck::{Pod, Zeroable};
use static_assertions::const_assert_eq;
// use crate::controller::position::PositionDirection;
use crate::state::user::{MarketType};
use crate::state::dynamic_accounts::{DynamicAccount, DerefOrBorrow, DerefOrBorrowMut};
use crate::error::DriftResult;
use prelude::AccountInfo;
use hypertree::{FreeList, RedBlackTree, RedBlackTreeReadOnly, PodBool};
use hypertree::{HyperTreeWriteOperations, HyperTreeReadOperations};

/// Fully owned Clob, used in clients that can copy.
pub type ClobValue = DynamicAccount<ClobFixed, Vec<u8>>;
pub type ClobRef<'a> = DynamicAccount<&'a ClobFixed, &'a [u8]>;
pub type ClobRefMut<'a> = DynamicAccount<&'a mut ClobFixed, &'a mut [u8]>;

pub type DataIndex = u32;
pub const NIL: DataIndex = DataIndex::MAX;

/// TODO: hardcode to 80? so tree nodes are packed tightly and nicely aligned
pub const MARKET_BLOCK_SIZE: usize = core::mem::size_of::<hypertree::RBNode<ClobOrder>>();

mod types {
    use super::*;
    // pub type ClaimedSeatTree<'a> = RedBlackTree<'a, ClaimedSeat>;
    // pub type ClaimedSeatTreeReadOnly<'a> = RedBlackTreeReadOnly<'a, ClaimedSeat>;
    pub type Bookside<'a> = RedBlackTree<'a, ClobOrder>;
    pub type BooksideReadOnly<'a> = RedBlackTreeReadOnly<'a, ClobOrder>;
}

/// TODO: should be no more than 64 bytes because of MARKET_BLOCK_SIZE
#[repr(C, packed)]
#[derive(Default, Debug, Copy, Clone, Zeroable, Pod)]
pub struct ClobOrder {
    pub is_bid: PodBool,
    pub price: u64,
    pub base_asset_amount: u64,
    pub base_asset_amount_filled: u64,
    pub quote_asset_amount_filled: u64,
    pub trader_index: DataIndex,

    pub reduce_only: PodBool,
    pub post_only: PodBool,
}

impl ClobOrder {
    fn get_is_bid(&self) -> bool {
        self.is_bid.0 == 1
    }
}

impl core::fmt::Display for ClobOrder {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let base_asset_amount = self.base_asset_amount;
        let price = self.price;
        write!(f, "{}@{}", base_asset_amount, price)
    }
}

impl core::cmp::Ord for ClobOrder {
    fn cmp(&self, other: &Self) -> core::cmp::Ordering {
        debug_assert!(self.is_bid == other.is_bid);

        if self.get_is_bid() {
            // Bids: higher price is greater (best bid becomes tree max)
            let self_price = self.price;
            let other_price = other.price;
            (self_price).cmp(&other_price)
        } else {
            // Asks: lower price is greater (best ask becomes tree max)
            let other_price = other.price;
            let self_price = self.price;
            (other_price).cmp(&(self_price))
        }
    }
}

impl core::cmp::PartialOrd for ClobOrder {
    fn partial_cmp(&self, other: &Self) -> Option<core::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl core::cmp::PartialEq for ClobOrder {
    fn eq(&self, other: &Self) -> bool {
        if self.trader_index != other.trader_index {
            return false;
        }
        // No Reverse variant in our OrderType; equality based on price only for lookups
        self.price == other.price
    }
}

impl core::cmp::Eq for ClobOrder {}

#[repr(C, packed)]
#[derive(Default, Copy, Clone, Pod, Zeroable)]
pub struct ClobUnusedFreeListPadding {
    _padding: [u64; 9],
    _padding2: [u8; 4],
}
// 4 bytes are for the free list, rest is payload.
const_assert_eq!(
    std::mem::size_of::<ClobUnusedFreeListPadding>(),
    76
);
// Does not need to align to word boundaries because does not deserialize.

#[account(zero_copy(unsafe))]
#[derive(Default)]
pub struct ClobFixed {
    pub market_type: MarketType,
    pub market_index: u16,

    /// The sequence number of the next order.
    // order_sequence_number: u64,

    /// Num bytes allocated as RestingOrder or ClaimedSeat or FreeList. Does not
    /// include the fixed bytes.
    num_bytes_allocated: u32,

    /// Red-black tree root representing the bids in the order book.
    bids_root_index: DataIndex,
    bids_best_index: DataIndex,

    /// Red-black tree root representing the asks in the order book.
    asks_root_index: DataIndex,
    asks_best_index: DataIndex,

    /// Red-black tree root representing the seats
    claimed_seats_root_index: DataIndex,

    /// LinkedList representing all free blocks that could be used for ClaimedSeats or RestingOrders
    free_list_head_index: DataIndex,

    // _padding2: [u32; 1],

    // Unused padding. Saved in case a later version wants to be backwards
    // compatible. Also, it is nice to have the fixed size be a round number,
    // 256 bytes.
    // _padding3: [u64; 8],
}

impl ClobFixed {
    pub fn new(
        market_index: u16,
    ) -> Self {
        let mut s = Self { market_type: MarketType::Perp, market_index, ..Default::default() };
        s.bids_root_index = NIL;
        s.bids_best_index = NIL;
        s.asks_root_index = NIL;
        s.asks_best_index = NIL;
        s.claimed_seats_root_index = NIL;
        s.free_list_head_index = NIL;
        s.num_bytes_allocated = 0;
        s
    }
}

pub struct ClobZeroCopy<'a> {
    pub fixed: Ref<'a, ClobFixed>,
    pub data: Ref<'a, [u8]>,
}

pub struct ClobZeroCopyMut<'a> {
    pub fixed: RefMut<'a, ClobFixed>,
    pub data: RefMut<'a, [u8]>,
}

// pub trait ClobSidesView<'a> {
impl<
    Fixed: DerefOrBorrow<ClobFixed>,
    Dynamic: DerefOrBorrow<[u8]>
> DynamicAccount<Fixed, Dynamic>
{
    fn borrow_market(&self) -> ClobRef {
        ClobRef {
            fixed: self.fixed.deref_or_borrow(),
            dynamic: self.dynamic.deref_or_borrow(),
        }
    }

    fn get_bids(&self) -> types::BooksideReadOnly {
        let DynamicAccount { dynamic, fixed } = self.borrow_market();
        types::BooksideReadOnly::new(
            dynamic,
            fixed.bids_root_index,
            fixed.bids_best_index,
        )
    }

    fn get_asks(&self) -> types::BooksideReadOnly {
        let DynamicAccount { dynamic, fixed } = self.borrow_market();
        types::BooksideReadOnly::new(
            dynamic,
            fixed.asks_root_index,
            fixed.asks_best_index,
        )
    }
}

// impl<'a> ClobSidesView<'a> for ClobZeroCopy<'a> {
//     fn data_slice(&'a self) -> &'a [u8] { &*self.data }
//     fn fixed_ref(&self) -> &ClobFixed { &*self.fixed }
// }

// impl<'a> ClobSidesView<'a> for ClobZeroCopyMut<'a> {
//     fn data_slice(&'a self) -> &'a [u8] { &*self.data }
//     fn fixed_ref(&self) -> &ClobFixed { &*self.fixed }
// }

// impl<'a> ClobZeroCopyMut<'a> {
impl<
    Fixed: DerefOrBorrowMut<ClobFixed> + DerefOrBorrow<ClobFixed>,
    Dynamic: DerefOrBorrowMut<[u8]> + DerefOrBorrow<[u8]>,
> DynamicAccount<Fixed, Dynamic> {
    fn borrow_mut(&mut self) -> ClobRefMut {
        ClobRefMut {
            fixed: self.fixed.deref_or_borrow_mut(),
            dynamic: self.dynamic.deref_or_borrow_mut(),
        }
    }

    pub fn market_expand(&mut self) -> DriftResult<()> {
        let DynamicAccount { fixed, dynamic } = self.borrow_mut();
        let mut free_list: FreeList<ClobUnusedFreeListPadding> =
            FreeList::new(dynamic, fixed.free_list_head_index);

        free_list.add(fixed.num_bytes_allocated);
        fixed.num_bytes_allocated += MARKET_BLOCK_SIZE as u32;
        fixed.free_list_head_index = free_list.get_head();
        Ok(())
    }
}

pub trait ClobLoader<'a> {
    fn load_zc(&self) -> DriftResult<ClobZeroCopy>;
    fn load_zc_mut(&self) -> DriftResult<ClobZeroCopyMut>;
}

impl<'a> ClobLoader<'a> for AccountInfo<'a> {
    fn load_zc(&self) -> DriftResult<ClobZeroCopy> {
        todo!()
    }

    fn load_zc_mut(&self) -> DriftResult<ClobZeroCopyMut> {
        todo!()
    }
}

/// TODO move out these helper functions
/// 
#[inline(always)]
fn insert_order_into_tree(
    is_bid: bool,
    fixed: &mut ClobFixed,
    dynamic: &mut [u8],
    free_address: DataIndex,
    resting_order: &ClobOrder,
) {
    let mut tree: types::Bookside = if is_bid {
        types::Bookside::new(dynamic, fixed.bids_root_index, fixed.bids_best_index)
    } else {
        types::Bookside::new(dynamic, fixed.asks_root_index, fixed.asks_best_index)
    };
    tree.insert(free_address, *resting_order);

    if is_bid {
        // trace!(
        //     "insert order bid {resting_order:?} root:{}->{} max:{}->{}->{}",
        //     fixed.bids_root_index,
        //     tree.get_root_index(),
        //     fixed.bids_best_index,
        //     tree.get_max_index(),
        //     tree.get_next_lower_index::<RestingOrder>(tree.get_max_index()),
        // );
        fixed.bids_root_index = tree.get_root_index();
        fixed.bids_best_index = tree.get_max_index();
    } else {
        // trace!(
        //     "insert order ask {resting_order:?} root:{}->{} max:{}->{}->{}",
        //     fixed.asks_root_index,
        //     tree.get_root_index(),
        //     fixed.asks_best_index,
        //     tree.get_max_index(),
        //     tree.get_next_lower_index::<RestingOrder>(tree.get_max_index()),
        // );
        fixed.asks_root_index = tree.get_root_index();
        fixed.asks_best_index = tree.get_max_index();
    }
}

pub fn get_free_address_on_market_fixed(
    fixed: &mut ClobFixed,
    dynamic: &mut [u8],
) -> DataIndex {
    let mut free_list: FreeList<ClobUnusedFreeListPadding> =
        FreeList::new(dynamic, fixed.free_list_head_index);
    let free_address: DataIndex = free_list.remove();
    fixed.free_list_head_index = free_list.get_head();
    free_address
}

#[cfg(test)]
mod tests;

/// TODO remove dis
#[cfg(test)]
mod amm_fill_tests;