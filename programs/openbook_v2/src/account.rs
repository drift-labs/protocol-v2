#![allow(dead_code)]

use bytemuck::Zeroable;
use crate::*;

#[zero_copy]
#[derive(AnchorDeserialize, AnchorSerialize, Debug)]
pub struct OracleConfig {
    pub conf_filter: f64,
    pub max_staleness_slots: i64,
    pub reserved: [u8; 72],
}

#[account(zero_copy(unsafe))]
#[repr(packed)]
pub struct Market {
    /// PDA bump
    pub bump: u8,

    /// Number of decimals used for the base token.
    ///
    /// Used to convert the oracle's price into a native/native price.
    pub base_decimals: u8,
    pub quote_decimals: u8,

    pub padding1: [u8; 5],

    // Pda for signing vault txs
    pub market_authority: Pubkey,

    /// No expiry = 0. Market will expire and no trading allowed after time_expiry
    pub time_expiry: i64,

    /// Admin who can collect fees from the market
    pub collect_fee_admin: Pubkey,
    /// Admin who must sign off on all order creations
    pub open_orders_admin: NonZeroPubkeyOption,
    /// Admin who must sign off on all event consumptions
    pub consume_events_admin: NonZeroPubkeyOption,
    /// Admin who can set market expired, prune orders and close the market
    pub close_market_admin: NonZeroPubkeyOption,

    /// Name. Trailing zero bytes are ignored.
    pub name: [u8; 16],

    /// Address of the BookSide account for bids
    pub bids: Pubkey,
    /// Address of the BookSide account for asks
    pub asks: Pubkey,
    /// Address of the EventHeap account
    pub event_heap: Pubkey,

    /// Oracles account address
    pub oracle_a: NonZeroPubkeyOption,
    pub oracle_b: NonZeroPubkeyOption,
    /// Oracle configuration
    pub oracle_config: OracleConfig,

    /// Number of quote native in a quote lot. Must be a power of 10.
    ///
    /// Primarily useful for increasing the tick size on the market: A lot price
    /// of 1 becomes a native price of quote_lot_size/base_lot_size becomes a
    /// ui price of quote_lot_size*base_decimals/base_lot_size/quote_decimals.
    pub quote_lot_size: i64,

    /// Number of base native in a base lot. Must be a power of 10.
    ///
    /// Example: If base decimals for the underlying asset is 6, base lot size
    /// is 100 and and base position lots is 10_000 then base position native is
    /// 1_000_000 and base position ui is 1.
    pub base_lot_size: i64,

    /// Total number of orders seen
    pub seq_num: u64,

    /// Timestamp in seconds that the market was registered at.
    pub registration_time: i64,

    /// Fees
    ///
    /// Fee (in 10^-6) when matching maker orders.
    /// maker_fee < 0 it means some of the taker_fees goes to the maker
    /// maker_fee > 0, it means no taker_fee to the maker, and maker fee goes to the referral
    pub maker_fee: i64,
    /// Fee (in 10^-6) for taker orders, always >= 0.
    pub taker_fee: i64,

    /// Total fees accrued in native quote
    pub fees_accrued: u128,
    /// Total fees settled in native quote
    pub fees_to_referrers: u128,

    /// Referrer rebates to be distributed
    pub referrer_rebates_accrued: u64,

    /// Fees generated and available to withdraw via sweep_fees
    pub fees_available: u64,

    /// Cumulative maker volume (same as taker volume) in quote native units
    pub maker_volume: u128,

    /// Cumulative taker volume in quote native units due to place take orders
    pub taker_volume_wo_oo: u128,

    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,

    pub market_base_vault: Pubkey,
    pub base_deposit_total: u64,

    pub market_quote_vault: Pubkey,
    pub quote_deposit_total: u64,

    pub reserved: [u8; 128],
}

pub const MAX_ORDERTREE_NODES: usize = 1024;

#[account(zero_copy)]
pub struct BookSide {
    pub roots: [OrderTreeRoot; 2],
    pub reserved_roots: [OrderTreeRoot; 4],
    pub reserved: [u8; 256],
    pub nodes: OrderTreeNodes,
}

impl BookSide {
    pub fn find_min(&self) -> Option<u64> {
        let mut p = 0_u64;
        for node in self.nodes.nodes.iter() {
            if node.tag == LEAF_NODE_TAG {
                let leaf_node = LeafNode::try_from_slice(&node.try_to_vec().unwrap()).unwrap();
                let price = leaf_node.price_data();
                if price < p || p == 0 {
                    p = price;
                }
            }
        }
        if p > 0 {
            return Some(p)
        }
        return None
    }

    pub fn find_max(&self) -> Option<u64> {
        let mut p = 0_u64;
        for node in self.nodes.nodes.iter() {
            if node.tag == LEAF_NODE_TAG {
                let leaf_node = LeafNode::try_from_slice(&node.try_to_vec().unwrap()).unwrap();
                let price = leaf_node.price_data();
                if price > p {
                    p = price;
                }
            }
        }
        if p > 0 {
            return Some(p)
        }
        return None;
    }
}

#[zero_copy]
#[derive(AnchorSerialize)]
pub struct AnyNode {
    pub tag: u8,
    pub data: [u8; 79],
    // essential to make AnyNode alignment the same as other node types
    pub force_align: u64,
}

#[zero_copy]
pub struct OrderTreeNodes {
    pub order_tree_type: u8, // OrderTreeType, but that's not POD
    pub padding: [u8; 3],
    pub bump_index: u32,
    pub free_list_len: u32,
    pub free_list_head: NodeHandle,
    pub reserved: [u8; 512],
    pub nodes: [AnyNode; MAX_ORDERTREE_NODES],
}

pub type NodeHandle = u32;

#[zero_copy]
#[derive(Debug)]
pub struct OrderTreeRoot {
    pub maybe_node: NodeHandle,
    pub leaf_count: u32,
}

/// LeafNodes represent an order in the binary tree
#[derive(
    Debug,
    Copy,
    Clone,
    PartialEq,
    Eq,
// bytemuck::Pod,
// bytemuck::Zeroable,
    AnchorSerialize,
    AnchorDeserialize,
)]
// #[repr(C)]
pub struct LeafNode {
    /// NodeTag
    pub tag: u8,

    /// Index into the owning OpenOrdersAccount's OpenOrders
    pub owner_slot: u8,

    /// Time in seconds after `timestamp` at which the order expires.
    /// A value of 0 means no expiry.
    pub time_in_force: u16,

    pub padding: [u8; 4],

    /// The binary tree key, see new_node_key()
    pub key: u128,

    /// Address of the owning OpenOrdersAccount
    pub owner: Pubkey,

    /// Number of base lots to buy or sell, always >=1
    pub quantity: i64,

    /// The time the order was placed
    pub timestamp: u64,

    /// If the effective price of an oracle pegged order exceeds this limit,
    /// it will be considered invalid and may be removed.
    ///
    /// Only applicable in the oracle_pegged OrderTree
    pub peg_limit: i64,

    /// User defined id for this order, used in FillEvents
    pub client_order_id: u64,
}

impl LeafNode {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner_slot: u8,
        key: u128,
        owner: Pubkey,
        quantity: i64,
        timestamp: u64,
        time_in_force: u16,
        peg_limit: i64,
        client_order_id: u64,
    ) -> Self {
        Self {
            tag: 2,
            owner_slot,
            time_in_force,
            padding: Default::default(),
            key,
            owner,
            quantity,
            timestamp,
            peg_limit,
            client_order_id,
        }
    }

    /// The order's price_data as stored in the key
    ///
    /// Needs to be unpacked differently for fixed and oracle pegged orders.
    #[inline(always)]
    pub fn price_data(&self) -> u64 {
        (self.key >> 64) as u64
    }

    /// Time at which this order will expire, u64::MAX if never
    #[inline(always)]
    pub fn expiry(&self) -> u64 {
        if self.time_in_force == 0 {
            u64::MAX
        } else {
            self.timestamp + self.time_in_force as u64
        }
    }

    /// Returns if the order is expired at `now_ts`
    #[inline(always)]
    pub fn is_expired(&self, now_ts: u64) -> bool {
        self.time_in_force > 0 && now_ts >= self.timestamp + self.time_in_force as u64
    }
}

#[zero_copy]
#[derive(AnchorSerialize, AnchorDeserialize, Debug, Default, PartialEq)]
pub struct NonZeroPubkeyOption {
    key: Pubkey,
}

pub trait NonZeroKey {
    fn non_zero_key(&self) -> NonZeroPubkeyOption;
}

impl<T> NonZeroKey for Option<T>
    where
        T: Key,
{
    fn non_zero_key(&self) -> NonZeroPubkeyOption {
        self.as_ref().map(|this| this.key()).into()
    }
}

impl PartialEq<NonZeroPubkeyOption> for Pubkey {
    fn eq(&self, other: &NonZeroPubkeyOption) -> bool {
        other.is_some() && *self == other.key
    }
}

impl PartialEq<Pubkey> for NonZeroPubkeyOption {
    fn eq(&self, other: &Pubkey) -> bool {
        self.is_some() && self.key == *other
    }
}

// impl From<NonZeroPubkeyOption> for Option<Pubkey> {
//     fn from(NonZeroPubkeyOption) -> Self {
//         if pubkey_option.is_some() {
//             Some(pubkey_option.key)
//         } else {
//             None
//         }
//     }
// }

impl From<Option<Pubkey>> for NonZeroPubkeyOption {
    fn from(normal_option: Option<Pubkey>) -> Self {
        match normal_option {
            Some(key) => Self { key },
            None => Self::zeroed(),
        }
    }
}

impl NonZeroPubkeyOption {
    pub fn is_some(&self) -> bool {
        *self != Self::zeroed()
    }

    pub fn is_none(&self) -> bool {
        *self == Self::zeroed()
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum Side {
    Bid,
    Ask,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum PlaceOrderType {
    Limit,
    ImmediateOrCancel,
    PostOnly,
    Market,
    PostOnlySlide,
    FillOrKill,
}