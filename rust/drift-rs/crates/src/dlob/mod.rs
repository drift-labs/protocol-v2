use std::{
    cmp::Reverse,
    collections::BTreeMap,
    fmt::Debug,
    iter::Peekable,
    sync::{
        atomic::{AtomicBool, AtomicU64},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use arrayvec::ArrayVec;
use dashmap::{mapref::one::RefMut, DashMap};
use fxhash::FxBuildHasher;
use solana_pubkey::Pubkey;

use crate::{
    constants::ProgramData,
    dlob::util::order_hash,
    math::auction::is_auction_complete,
    types::{
        accounts::{PerpMarket, User},
        MarketId, MarketType, Order, OrderExt, OrderStatus, OrderTriggerCondition, OrderType,
        PositionDirection,
    },
};

pub mod builder;
#[cfg(test)]
mod tests;
pub mod types;
pub mod util;

pub use types::*;
pub use util::OrderDelta;

/// log target
const TARGET: &str = "dlob";

type Direction = PositionDirection;
type MetadataMap = DashMap<u64, OrderMetadata, FxBuildHasher>;
type OrderEventMap = DashMap<u64, Vec<OrderEvent>, FxBuildHasher>;

/// Collection of orders
#[derive(Debug)]
struct Orders<T: OrderKey + Debug + Clone> {
    pub bids: BTreeMap<Reverse<T::Key>, T>,
    pub asks: BTreeMap<T::Key, T>,
}

impl<T: OrderKey + Clone + Debug> Default for Orders<T> {
    fn default() -> Self {
        Self {
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
        }
    }
}

impl<T: Clone + Debug + From<(u64, Order)> + OrderKey> Orders<T> {
    fn insert_raw(&mut self, is_bid: bool, order: T) {
        if is_bid {
            self.bids.insert(Reverse(order.key()), order);
        } else {
            self.asks.insert(order.key(), order);
        }
    }
    pub fn insert(&mut self, order_id: u64, order: Order) {
        self.insert_raw(Direction::Long == order.direction, (order_id, order).into());
    }

    pub fn remove(&mut self, order_id: u64, order: Order) -> bool {
        match order.direction {
            Direction::Long => {
                let order: T = (order_id, order).into();
                self.bids.remove(&Reverse(order.key())).is_some()
            }
            Direction::Short => {
                let order: T = (order_id, order).into();
                self.asks.remove(&order.key()).is_some()
            }
        }
    }
}

/// Orderbook for a specific market
///
/// Orders are kept in lists of similar types for efficient comparisons
///
/// aggregated L2 and L3 views are also maintained
#[derive(Default)]
struct Orderbook {
    /// market auctions with fixed price bounds, changes by slot
    market_orders: Orders<MarketOrder>,
    /// oracle auctions with dynamic price bounds, changes by slot
    oracle_orders: Orders<OracleOrder>,
    /// orders to fill at fixed price
    resting_limit_orders: Orders<LimitOrder>,
    /// orders to fill at offset from oracle price
    floating_limit_orders: Orders<FloatingLimitOrder>,
    /// list of (un)triggered orders
    /// triggered orders are moved to market_orders or oracle_orders
    trigger_orders: Orders<TriggerOrder>,
    /// L2 book snapshot
    l2_snapshot: Snapshot<L2Book>,
    /// L3 book snapshot
    l3_snapshot: Snapshot<L3Book>,
    /// market tick size
    market_tick_size: u64,
    /// slot where dynamic orders where last checked
    last_modified_slot: u64,
    /// market index of this book
    market: MarketId,
}

impl Orderbook {
    /// Create a new Orderbook with object pools for efficient memory management
    pub fn new(market: MarketId, market_tick_size: u64) -> Self {
        Self {
            market_orders: Orders::default(),
            oracle_orders: Orders::default(),
            resting_limit_orders: Orders::default(),
            floating_limit_orders: Orders::default(),
            trigger_orders: Orders::default(),
            market_tick_size,
            last_modified_slot: 0,
            market,
            l2_snapshot: Default::default(),
            l3_snapshot: Default::default(),
        }
    }

    /// Update the L2 snapshot
    pub fn update_l2_view(&self, oracle_price: u64) {
        self.l2_snapshot.write(|b| {
            b.load_orderbook(self, oracle_price);
        });
    }

    /// Update the L3 snapshot
    pub fn update_l3_view(
        &self,
        oracle_price: u64,
        metadata: &MetadataMap,
        order_events: &OrderEventMap,
    ) {
        self.l3_snapshot.write(|b| {
            b.load_orderbook(self, oracle_price, metadata, order_events);
        });
    }

    /// Update auction order prices to new `slot`
    pub fn update_slot(&mut self, slot: u64) {
        log::trace!(target: TARGET,"update book slot. market:{},slot:{slot}", self.market.index());
        self.expire_auction_orders(slot);
        self.last_modified_slot = slot;
    }

    /// Expire all auctions past current `slot`
    ///
    /// limit orders with finishing auctions are moved to resting orders
    /// expired orders are removed from the orderbook
    fn expire_auction_orders(&mut self, slot: u64) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let filter_fn = move |x: &MarketOrder, orderbook: &mut Orders<LimitOrder>, is_bid: bool| {
            if crate::dlob::types::order_is_auction_complete(slot, x.slot, x.duration) {
                if crate::dlob::types::order_is_expired(x.max_ts, now) {
                    log::trace!(target: TARGET, "auction expired: {}@{}", x.id, slot);
                    false
                } else if x.is_limit {
                    log::trace!(target: TARGET, "auction => resting: {}@{}", x.id, slot);
                    orderbook.insert_raw(is_bid, x.to_limit_order());
                    false
                } else {
                    true
                }
            } else {
                true
            }
        };
        self.market_orders
            .asks
            .retain(|_, x| filter_fn(x, &mut self.resting_limit_orders, false));
        self.market_orders
            .bids
            .retain(|_, x| filter_fn(x, &mut self.resting_limit_orders, true));

        let filter_fn =
            move |x: &OracleOrder, orderbook: &mut Orders<FloatingLimitOrder>, is_bid: bool| {
                if crate::dlob::types::order_is_auction_complete(slot, x.slot, x.duration) {
                    if crate::dlob::types::order_is_expired(x.max_ts, now) {
                        log::trace!(target: TARGET, "auction expired: {}@{}", x.id, slot);
                        false
                    } else if x.is_limit {
                        log::trace!(target: TARGET, "auction => resting: {}@{}", x.id, slot);
                        orderbook.insert_raw(is_bid, x.to_floating_limit_order());
                        false
                    } else {
                        true
                    }
                } else {
                    true
                }
            };
        self.oracle_orders
            .asks
            .retain(|_, x| filter_fn(x, &mut self.floating_limit_orders, false));
        self.oracle_orders
            .bids
            .retain(|_, x| filter_fn(x, &mut self.floating_limit_orders, true));
    }
}

/// Channel for sending User order updates to DLOB instance
#[derive(Clone)]
pub struct DLOBNotifier {
    sender: crossbeam::channel::Sender<DLOBEvent>,
}

impl DLOBNotifier {
    pub fn new(sender: crossbeam::channel::Sender<DLOBEvent>) -> Self {
        Self { sender }
    }

    /// Updates the DLOB with user account changes by comparing old and new user states.
    ///
    /// This method processes user account updates and sends appropriate DLOB events to maintain
    /// the order book state. It handles two scenarios:
    /// 1. **User Update**: When both old and new user states are provided, it compares the orders
    ///    and sends delta events for changes (creates, updates, removes)
    /// 2. **New User**: When only a new user is provided, it creates events for all open orders
    ///
    /// # Parameters
    ///
    /// * `pubkey` - The public key of the user account being updated
    /// * `old_user` - The previous state of the user account, if any. `None` indicates a new user
    /// * `new_user` - The current state of the user account
    /// * `slot` - The slot number when this update occurred
    ///
    /// # Panics
    ///
    /// This method will panic if it cannot send events to the DLOB channel, which typically
    /// indicates the DLOB processing thread has been dropped or the channel is full.
    ///
    /// # Example
    ///
    /// ```rust
    /// // Update existing user
    /// notifier.user_update(user_pubkey, Some(&old_user), &new_user, current_slot);
    ///
    /// // Add new user
    /// notifier.user_update(user_pubkey, None, &new_user, current_slot);
    /// ```
    pub fn user_update(&self, pubkey: Pubkey, old_user: Option<&User>, new_user: &User, slot: u64) {
        let deltas = match old_user {
            Some(old_user) => crate::dlob::util::compare_user_orders(pubkey, old_user, new_user).1,
            None => new_user
                .orders
                .iter()
                .filter(|o| {
                    o.status == OrderStatus::Open
                        && o.base_asset_amount > o.base_asset_amount_filled
                })
                .map(|o| OrderDelta::Create { order: *o })
                .collect(),
        };
        if deltas.is_empty() {
            return;
        }
        self.sender
            .send(DLOBEvent::Deltas {
                deltas,
                pubkey,
                slot,
            })
            .expect("Failed to send DLOB event - channel may be closed");
    }

    #[inline]
    pub fn slot_and_oracle_update(&self, market: MarketId, slot: u64, oracle_price: u64) {
        self.sender
            .send(DLOBEvent::SlotAndOracleUpdate {
                slot,
                oracle_price,
                market,
            })
            .expect("Failed to send slot update event - channel may be closed");
    }
}

/// Aggregates orderbooks for multiple markets
///
/// The DLOB is incrementally built and event driven, consumers spawn the notifier and submit slot and user order updates
/// to maintain live orderbook state.
///
/// Users can call [`get_l3_snapshot`](DLOB::get_l3_snapshot) to obtain an L3 snapshot
/// and inspect the bids and asks through the returned `L3Book`.
pub struct DLOB {
    /// Map from market to orderbook
    markets: DashMap<MarketId, Orderbook, FxBuildHasher>,
    /// Map from DLOB internal order ID to event history
    order_events: OrderEventMap,
    /// Map from DLOB internal order ID to order metadata
    metadata: MetadataMap,
    /// static drift program data e.g market tick sizes
    program_data: &'static ProgramData,
    /// last slot update
    last_modified_slot: AtomicU64,
    // Maintain live L2 snapshots (default: false)
    enable_l2_snapshot: AtomicBool,
    // Maintain live L3 snapshots (default: true)
    enable_l3_snapshot: AtomicBool,
}

impl Default for DLOB {
    fn default() -> Self {
        Self {
            markets: DashMap::default(),
            metadata: DashMap::default(),
            order_events: DashMap::default(),
            program_data: Box::leak(Box::new(ProgramData::uninitialized())),
            last_modified_slot: Default::default(),
            enable_l2_snapshot: AtomicBool::new(false),
            enable_l3_snapshot: AtomicBool::new(true),
        }
    }
}

impl DLOB {
    #[allow(unused_variables)]
    /// Record an event for an order
    fn record_order_event(&self, order_id: u64, event: OrderEvent) {
        #[cfg(feature = "dlob_dbg")]
        {
            self.order_events
                .entry(order_id)
                .or_insert_with(Vec::new)
                .push(event);
        }
    }

    #[allow(unused_variables)]
    /// Log all events for a missing order (helper function for use in load_orderbook)
    fn log_missing_order_events_helper(order_id: u64, order_events: &OrderEventMap) {
        #[cfg(feature = "dlob_dbg")]
        {
            if let Some(events) = order_events.get(&order_id) {
                log::warn!(
                    target: TARGET,
                    "=== MISSING ORDER EVENT LOG: order_id={} ({} events) ===",
                    order_id,
                    events.len()
                );
                for (idx, event) in events.iter().enumerate() {
                    match &event.event_type {
                        OrderEventType::Insert => {
                            log::warn!(
                                target: TARGET,
                                "  [{}] INSERT @ slot={}, user={}, order_id={}, order={:?}",
                                idx + 1,
                                event.slot,
                                event.user,
                                event.order_id,
                                event.order
                            );
                        }
                        OrderEventType::Update => {
                            log::warn!(
                                target: TARGET,
                                "  [{}] UPDATE @ slot={}, user={}, order_id={}, old_order={:?}, new_order={:?}",
                                idx + 1,
                                event.slot,
                                event.user,
                                event.order_id,
                                event.old_order,
                                event.order
                            );
                        }
                        OrderEventType::Remove => {
                            log::warn!(
                                target: TARGET,
                                "  [{}] REMOVE @ slot={}, user={}, order_id={}, order={:?}",
                                idx + 1,
                                event.slot,
                                event.user,
                                event.order_id,
                                event.order
                            );
                        }
                    }
                }
                log::warn!(target: TARGET, "=== END MISSING ORDER EVENT LOG ===");
            } else {
                log::warn!(
                    target: TARGET,
                    "Missing order {} has no event history",
                    order_id
                );
            }
        }
    }

    /// Enable live L2 snapshots for all orderbooks (default: disabled)
    pub fn enable_l2_snapshot(&self) {
        self.enable_l2_snapshot
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
    /// Disable live L3 snapshots for all orderbooks (default: enabled)
    pub fn disable_l3_snapshot(&self) {
        self.enable_l3_snapshot
            .store(false, std::sync::atomic::Ordering::Relaxed);
    }

    /// Provides a writer channel into the DLOB which acts as a sink for external events
    pub fn spawn_notifier(&'static self) -> DLOBNotifier {
        let (tx, rx) = crossbeam::channel::bounded(2048);
        std::thread::spawn(move || {
            while let Ok(event) = rx.recv() {
                match event {
                    DLOBEvent::SlotAndOracleUpdate {
                        market,
                        slot,
                        oracle_price,
                    } => {
                        self.update_slot_and_oracle_price(market, slot, oracle_price);
                    }
                    DLOBEvent::Deltas {
                        pubkey: user,
                        slot,
                        deltas,
                    } => {
                        for delta in deltas {
                            match delta {
                                OrderDelta::Create { order } => {
                                    self.insert_order(&user, slot, order);
                                }
                                OrderDelta::Remove { order } => {
                                    self.remove_order(&user, slot, order);
                                }
                            }
                        }
                    }
                }
            }
            log::error!(target: TARGET, "notifier thread finished");
        });

        DLOBNotifier::new(tx)
    }

    /// run function on a market Orderbook
    fn with_orderbook_mut(&self, market_id: &MarketId, f: impl Fn(RefMut<MarketId, Orderbook>)) {
        let ob = self.markets.entry(*market_id).or_insert({
            // initialize book on first write
            let market_tick_size: u64 = match market_id.kind() {
                MarketType::Perp => self
                    .program_data
                    .perp_market_config_by_index(market_id.index())
                    .map(|m| m.order_tick_size)
                    .unwrap_or(1),
                MarketType::Spot => self
                    .program_data
                    .spot_market_config_by_index(market_id.index())
                    .map(|m| m.order_tick_size)
                    .unwrap_or(1),
            };
            Orderbook::new(*market_id, market_tick_size)
        });
        f(ob);
    }

    /// Update orderbook slot and oracle price for market
    fn update_slot_and_oracle_price(&self, market: MarketId, slot: u64, oracle_price: u64) {
        let last_modified_slot = self
            .last_modified_slot
            .load(std::sync::atomic::Ordering::Relaxed);

        if slot < last_modified_slot {
            log::warn!(
                target: TARGET, "ignoring out of order slot update: update:{slot},ours:{last_modified_slot}",
            );
            return;
        }

        self.with_orderbook_mut(&market, |mut book| {
            book.update_slot(slot);
            if self
                .enable_l2_snapshot
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                book.update_l2_view(oracle_price);
            }
            if self
                .enable_l3_snapshot
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                book.update_l3_view(oracle_price, &self.metadata, &self.order_events);
            }
        });

        self.last_modified_slot
            .store(slot, std::sync::atomic::Ordering::Relaxed)
    }

    /// Get an L2 book of current orders at the current slot
    ///
    /// # Panics
    /// If orderbook doesn't exist. Use `get_l2_snapshot_safe` to handle missing orderbooks
    pub fn get_l2_snapshot(&self, market_index: u16, market_type: MarketType) -> Arc<L2Book> {
        let book = self
            .markets
            .get(&MarketId::new(market_index, market_type))
            .unwrap_or_else(|| {
                panic!(
                    "orderbook missing for market {}, {:?}",
                    market_index, market_type
                )
            });
        book.l2_snapshot.read()
    }

    /// Get an L2 book of current orders at the current slot
    ///
    /// Returns `None` if orderbook doesn't exist for this market
    pub fn get_l2_snapshot_safe(
        &self,
        market_index: u16,
        market_type: MarketType,
    ) -> Option<Arc<L2Book>> {
        let book = self
            .markets
            .get(&MarketId::new(market_index, market_type))?;
        Some(book.l2_snapshot.read())
    }

    /// Get an L3 book of current orders at the current slot
    ///
    /// # Panics
    /// If orderbook doesn't exist. Use `get_l3_snapshot_safe` to handle missing orderbooks
    pub fn get_l3_snapshot(&self, market_index: u16, market_type: MarketType) -> Arc<L3Book> {
        let book = self
            .markets
            .get(&MarketId::new(market_index, market_type))
            .unwrap_or_else(|| {
                panic!(
                    "orderbook missing for market {}, {:?}",
                    market_index, market_type
                )
            });
        book.l3_snapshot.read()
    }

    /// Get an L3 book of current orders at the current slot
    ///
    /// Returns `None` if orderbook doesn't exist for this market
    pub fn get_l3_snapshot_safe(
        &self,
        market_index: u16,
        market_type: MarketType,
    ) -> Option<Arc<L3Book>> {
        let book = self
            .markets
            .get(&MarketId::new(market_index, market_type))?;
        Some(book.l3_snapshot.read())
    }

    pub fn find_crossing_region(
        &self,
        oracle_price: u64,
        market_index: u16,
        market_type: MarketType,
        perp_market: Option<&PerpMarket>,
    ) -> Option<CrossingRegion> {
        let book = self.get_l3_snapshot(market_index, market_type);

        let mut bids = book.bids(Some(oracle_price), perp_market, None).peekable();
        let mut asks = book.asks(Some(oracle_price), perp_market, None).peekable();

        let best_bid = bids.peek()?.price;
        let best_ask = asks.peek()?.price;

        if best_bid < best_ask {
            return None;
        }

        let crossing_bids: Vec<L3Order> =
            bids.take_while(|b| b.price > best_ask).cloned().collect();
        let crossing_asks: Vec<L3Order> =
            asks.take_while(|a| a.price < best_bid).cloned().collect();

        if crossing_asks.is_empty() || crossing_bids.is_empty() {
            return None;
        }

        Some(CrossingRegion {
            slot: book.slot,
            crossing_bids,
            crossing_asks,
        })
    }

    fn remove_order(&self, user: &Pubkey, slot: u64, order: Order) {
        let order_id = order_hash(user, order.order_id);

        self.record_order_event(
            order_id,
            OrderEvent {
                event_type: OrderEventType::Remove,
                slot,
                order: Some(order),
                old_order: None,
                user: *user,
                order_id,
            },
        );

        self.with_orderbook_mut(&MarketId::new(order.market_index, order.market_type), |mut orderbook| {
            if let Some(metadata) = self.metadata.get(&order_id) {
                let metadata_ref = *metadata;
                drop(metadata); // release dashmap ref

                log::trace!(target: TARGET, "remove order: {order_id} @ status: {:?}, kind: {:?}/{:?}, slot: {slot}", order.status, metadata_ref.kind, order.order_type);

                let order_removed = match metadata_ref.kind {
                    OrderKind::Market => {
                        orderbook.market_orders.remove(order_id, order) || orderbook.resting_limit_orders.remove(order_id, order)
                    }
                    OrderKind::Oracle => {
                        orderbook.oracle_orders.remove(order_id, order) || orderbook.floating_limit_orders.remove(order_id, order)
                    }
                    OrderKind::Limit => {
                        orderbook.resting_limit_orders.remove(order_id, order)
                    }
                    OrderKind::FloatingLimit => {
                        orderbook.floating_limit_orders.remove(order_id, order)
                    }
                    OrderKind::TriggerMarket | OrderKind::TriggerLimit => {
                        orderbook.trigger_orders.remove(order_id, order)
                    }
                };

                if order_removed {
                    self.metadata.remove(&order_id);
                } else {
                    log::warn!(
                        target: TARGET,
                        "remove order failed: {order_id} not removed. kind: {:?}, user: {}, order_id: {}",
                        metadata_ref.kind,
                        metadata_ref.user,
                        metadata_ref.order_id,
                    );
                    DLOB::log_missing_order_events_helper(order_id, &self.order_events);
                }
            }
        });
    }

    /// Insert an onchain order type into the DLOB
    ///
    /// this transforms the order into an internal order representation and organizes them based on
    /// order semantics e.g. limit order auctions and market order auctions are equivalent until auction end time
    fn insert_order(&self, user: &Pubkey, slot: u64, order: Order) {
        let order_id = order_hash(user, order.order_id);
        log::trace!(target: TARGET, "insert order: {order_id} @ {slot}");

        self.record_order_event(
            order_id,
            OrderEvent {
                event_type: OrderEventType::Insert,
                slot,
                order: Some(order),
                old_order: None,
                user: *user,
                order_id,
            },
        );

        self.with_orderbook_mut(
            &MarketId::new(order.market_index, order.market_type),
            |mut orderbook| {
               let kind = match order.order_type {
                    OrderType::Market => {
                        orderbook.market_orders.insert(order_id, order);
                        OrderKind::Market
                    }
                    OrderType::Oracle => {
                        orderbook.oracle_orders.insert(order_id, order);
                        OrderKind::Oracle
                    }
                    OrderType::Limit => {
                        /*
                        maker orders:
                            - limit order with POST_ONLY=true
                            - limit order with POST_ONLY=false and auction is completed*
                        crossing:
                            - limit orders with both POST_ONLY=true cannot cross
                            - limit orders with both POST_ONLY=FALSE can cross, *older order becomes maker
                            - limit order with POST_ONLY=TRUE can become maker for POST_ONLY=FALSE
                        */
                        let is_floating = order.oracle_price_offset != 0;
                        let is_post_only = order.post_only;
                        let has_auction_price = (order.auction_end_price != 0 && order.auction_start_price != 0) && !is_auction_complete(&order, slot);
                        let order_kind = if !is_post_only {
                            match (has_auction_price, is_floating) {
                                (true, true) => {
                                    orderbook.oracle_orders.insert(order_id, order);
                                    OrderKind::Oracle
                                }
                                (true, false) => {
                                    orderbook.market_orders.insert(order_id, order);
                                    OrderKind::Market
                                }
                                (false, true) => {
                                    orderbook.floating_limit_orders.insert(order_id, order);
                                    OrderKind::FloatingLimit
                                }
                                (false, false) => {
                                    orderbook.resting_limit_orders.insert(order_id, order);
                                    OrderKind::Limit
                                }
                            }
                        } else {
                            // post only cannot have an auction (maker side only)
                            if is_floating {
                                orderbook.floating_limit_orders.insert(order_id, order);
                                OrderKind::FloatingLimit
                            } else {
                                orderbook.resting_limit_orders.insert(order_id, order);
                                OrderKind::Limit
                            }
                        };
                        log::trace!(target: TARGET, "insert limit order: {order_id},{:?}", order_kind);
                        order_kind
                    }
                    OrderType::TriggerMarket => match order.trigger_condition {
                        OrderTriggerCondition::Above | OrderTriggerCondition::Below => {
                            log::trace!(target: TARGET, "insert trigger market order: {order_id}");
                            orderbook.trigger_orders.insert(order_id, order);
                            OrderKind::TriggerMarket

                        }
                        OrderTriggerCondition::TriggeredAbove | OrderTriggerCondition::TriggeredBelow => {
                            if order.is_oracle_trigger_market() {
                                log::trace!(target: TARGET, "insert triggered oracle order: {order_id}");
                                orderbook.oracle_orders.insert(order_id, order);
                                OrderKind::Oracle
                            } else {
                                log::trace!(target: TARGET, "insert triggered market order: {order_id}");
                                orderbook.market_orders.insert(order_id, order);
                                OrderKind::Market
                           }
                        }
                    },
                    OrderType::TriggerLimit => match order.trigger_condition {
                        OrderTriggerCondition::Above | OrderTriggerCondition::Below => {
                            log::trace!(target: TARGET, "insert trigger limit order: {order_id}");
                            orderbook.trigger_orders.insert(order_id, order);
                            OrderKind::TriggerLimit
                        }
                        OrderTriggerCondition::TriggeredAbove
                        | OrderTriggerCondition::TriggeredBelow => {
                            log::trace!(target: TARGET, "insert triggered limit order: {order_id}");
                            let is_resting = is_auction_complete(&order, slot);
                            if is_resting {
                                orderbook.resting_limit_orders.insert(order_id, order);
                                OrderKind::Limit
                            } else {
                                // trigger limit does not have an option for oracle offset
                                orderbook.market_orders.insert(order_id, order);
                                OrderKind::Market
                            }
                        }
                    },
                };
                self.metadata.insert(order_id, OrderMetadata::new(*user, kind, order.order_id, order.max_ts.unsigned_abs()));
            },
        );
    }

    /// Helper to find a crossing pair of limit orders at the top of the book, if any.
    ///
    /// The crossing orders could from the same user account and so un-fillable
    fn find_limit_cross(&self, bid: &L3Order, ask: &L3Order) -> Option<(L3Order, L3Order)> {
        if bid.price < ask.price || bid.user == ask.user {
            return None;
        }
        match (bid.is_post_only(), ask.is_post_only()) {
            (true, false) => Some((ask.clone(), bid.clone())),
            (false, true) => Some((bid.clone(), ask.clone())),
            (false, false) => {
                // TODO: use slot
                if bid.max_ts < ask.max_ts {
                    Some((bid.clone(), ask.clone()))
                } else {
                    Some((ask.clone(), bid.clone()))
                }
            }
            (true, true) => None,
        }
    }

    /// At the current slot return all auctions crossing resting limit orders (i.e uncross)
    ///
    /// ## Panics
    ///
    /// if market_index,market_type has not been initialized on this dlob instance
    ///
    pub fn find_crosses_for_auctions(
        &self,
        market_index: u16,
        market_type: MarketType,
        slot: u64,
        oracle_price: u64,
        perp_market: Option<&PerpMarket>,
        trigger_price: u64,
        depth: Option<usize>,
    ) -> CrossesAndTopMakers {
        let book = self.get_l3_snapshot(market_index, market_type);
        let mut all_crosses = Vec::with_capacity(16);

        let (vamm_bid, vamm_ask, vamm_min_order) = if let Some(m) = perp_market {
            let r = m.amm.reserve_price().unwrap_or(0);
            (
                m.amm
                    .bid_price(r, m.amm.short_spread, m.amm.reference_price_offset)
                    .ok(),
                m.amm
                    .ask_price(r, m.amm.long_spread, m.amm.reference_price_offset)
                    .ok(),
                m.market_stats.min_order_size,
            )
        } else {
            (None, None, u64::MAX)
        };
        log::trace!(target: TARGET, "VAMM market={} bid={vamm_bid:?} ask={vamm_ask:?}", market_index);

        let (taker_asks, resting_asks): (Vec<L3Order>, Vec<L3Order>) = book
            .top_asks(
                depth.unwrap_or(64),
                Some(oracle_price),
                perp_market,
                Some(trigger_price),
            )
            .cloned()
            .partition(|x| x.is_taker());

        let (taker_bids, resting_bids): (Vec<L3Order>, Vec<L3Order>) = book
            .top_bids(
                depth.unwrap_or(64),
                Some(oracle_price),
                perp_market,
                Some(trigger_price),
            )
            .cloned()
            .partition(|x| x.is_taker());

        let mut vamm_taker_ask = None;
        let mut vamm_taker_bid = None;

        let mut limit_crosses = None;
        if let (Some(best_bid), Some(best_ask)) = (resting_bids.first(), resting_asks.first()) {
            // check for crossing resting limit orders
            limit_crosses = self.find_limit_cross(best_bid, best_ask);
            // check for VAMM crossing resting limit orders
            if best_ask.size > vamm_min_order
                && vamm_bid.is_some_and(|v| v > best_ask.price && best_ask.is_post_only())
            {
                vamm_taker_bid = Some(best_ask.clone());
            }
            if best_bid.size > vamm_min_order
                && vamm_ask.is_some_and(|v| v < best_bid.price && best_bid.is_post_only())
            {
                vamm_taker_ask = Some(best_bid.clone());
            }
        }

        let top_3_maker_bids: ArrayVec<Pubkey, 3> =
            resting_bids.iter().take(3).map(|o| o.user).collect();

        // Check for crosses between auction bids and resting asks
        for taker_bid in taker_bids {
            let new_crosses = self.find_crosses_for_taker_order_inner(
                slot,
                taker_bid.price,
                taker_bid.size,
                true,
                resting_asks.iter().peekable(),
                |taker_price: u64, taker_size: u64| {
                    taker_size > vamm_min_order && vamm_ask.is_some_and(|v| taker_price > v)
                },
            );

            if !new_crosses.is_empty() {
                all_crosses.push((taker_bid, new_crosses));
            } else {
                break;
            }
        }

        let top_3_maker_asks: ArrayVec<Pubkey, 3> =
            resting_asks.iter().take(3).map(|o| o.user).collect();

        // Check for crosses between auction asks and resting bids
        for taker_ask in taker_asks {
            let new_crosses = self.find_crosses_for_taker_order_inner(
                slot,
                taker_ask.price,
                taker_ask.size,
                false,
                resting_bids.iter().peekable(),
                |taker_price: u64, taker_size: u64| {
                    taker_size > vamm_min_order && vamm_bid.is_some_and(|v| taker_price < v)
                },
            );

            if !new_crosses.is_empty() {
                all_crosses.push((taker_ask, new_crosses));
            } else {
                break;
            }
        }

        CrossesAndTopMakers {
            top_maker_asks: top_3_maker_asks,
            top_maker_bids: top_3_maker_bids,
            crosses: all_crosses,
            limit_crosses,
            vamm_taker_ask,
            vamm_taker_bid,
        }
    }

    /// At the current slot and oracle price return all orders crossing a given taker order
    ///
    /// # Parameters
    ///
    /// * `current_slot` - The current slot number, used for time-sensitive order logic.
    /// * `oracle_price` - The current oracle price, used for price calculations and trigger conditions.
    /// * `taker_order` - The taker order for which to find matching maker orders. Contains price, size, direction, and market info.
    /// * `perp_market` - PerpMarket struct provides vamm price, fallback price, and trigger price
    /// * `depth` - Optional order depth to consider for matches. default: 20
    ///
    /// ## Panics
    ///
    /// if market_index,market_type has not been initialized on this dlob instance
    ///
    /// # Returns
    ///
    /// Returns a `MakerCrosses` struct containing the list of matched maker orders, the slot, whether the match is partial, and if a vAMM cross occurred.
    pub fn find_crosses_for_taker_order(
        &self,
        current_slot: u64,
        oracle_price: u64,
        taker_order: TakerOrder,
        perp_market: Option<&PerpMarket>,
        depth: Option<usize>,
    ) -> MakerCrosses {
        let book = self.get_l3_snapshot(taker_order.market_index, taker_order.market_type);
        let is_long = taker_order.direction == PositionDirection::Long;
        let depth = depth.unwrap_or(32);
        let vamm_min_order = perp_market
            .map(|p| p.market_stats.min_order_size)
            .unwrap_or(u64::MAX);

        if is_long {
            let vamm_price = perp_market
                .and_then(|p| {
                    let r = p.amm.reserve_price().ok()?;
                    p.amm
                        .ask_price(r, p.amm.long_spread, p.amm.reference_price_offset)
                        .ok()
                })
                .unwrap_or(u64::MAX);
            self.find_crosses_for_taker_order_inner(
                current_slot,
                taker_order.price,
                taker_order.size,
                true,
                book.top_asks(depth, Some(oracle_price), perp_market, None)
                    .filter(|o| o.is_post_only())
                    .peekable(),
                |taker_price, taker_size| taker_size > vamm_min_order && taker_price > vamm_price,
            )
        } else {
            let vamm_price = perp_market
                .and_then(|p| {
                    let r = p.amm.reserve_price().ok()?;
                    p.amm
                        .bid_price(r, p.amm.short_spread, p.amm.reference_price_offset)
                        .ok()
                })
                .unwrap_or(u64::MIN);
            self.find_crosses_for_taker_order_inner(
                current_slot,
                taker_order.price,
                taker_order.size,
                false,
                book.top_bids(depth, Some(oracle_price), perp_market, None)
                    .filter(|o| o.is_post_only())
                    .peekable(),
                |taker_price, taker_size| taker_size > vamm_min_order && taker_price < vamm_price,
            )
        }
    }

    /// Find crosses for given `taker_order` consuming or updating `resting_limit_orders` upon finding a match
    fn find_crosses_for_taker_order_inner<'a>(
        &self,
        current_slot: u64,
        taker_price: u64,
        taker_size: u64,
        is_long: bool,
        mut resting_limit_orders: Peekable<impl Iterator<Item = &'a L3Order>>,
        has_vamm_cross: impl Fn(u64, u64) -> bool,
    ) -> MakerCrosses {
        let mut candidates = ArrayVec::<(L3Order, u64), 16>::new();
        let mut remaining_size = taker_size;

        let price_crosses = if is_long {
            |taker_price: u64, maker_price: u64| taker_price > maker_price
        } else {
            |taker_price: u64, maker_price: u64| taker_price < maker_price
        };

        while let Some(maker_order) = resting_limit_orders.peek() {
            if !price_crosses(taker_price, maker_order.price) {
                break;
            }

            let fill_size = remaining_size.min(maker_order.size);

            candidates.push(((*maker_order).clone(), fill_size));
            remaining_size -= fill_size;

            if fill_size == maker_order.size {
                // Fully consumed — advance the iterator
                resting_limit_orders.next();
            } else {
                // Partially filled, allow subsequent matches against this maker order
                break;
            }
            if candidates.len() == candidates.capacity() {
                log::debug!(target: TARGET, "reached max number crosses");
                break;
            }
            if remaining_size == 0 {
                break;
            }
        }

        MakerCrosses {
            has_vamm_cross: has_vamm_cross(taker_price, taker_size),
            orders: candidates,
            slot: current_slot,
            is_partial: remaining_size != 0,
            taker_direction: if is_long {
                Direction::Long
            } else {
                Direction::Short
            },
        }
    }
}

/// L3 Orderbook view
#[derive(Debug, Default, Clone)]
pub struct L3Book {
    pub slot: u64,
    /// oracle price used to construct the snapshot
    oracle_price: u64,
    /// bids with fixed price
    bids: Vec<L3Order>,
    /// bids offset from oracle
    floating_bids: Vec<L3Order>,
    /// taker only bids at VAMM price
    vamm_bids: Vec<L3Order>,
    /// trigger orders (bids) - sorted by trigger price, post-trigger price calculated dynamically
    trigger_bids: Vec<L3Order>,
    /// asks with fixed price
    asks: Vec<L3Order>,
    /// asks offset from oracle
    floating_asks: Vec<L3Order>,
    /// taker only asks at VAMM price
    vamm_asks: Vec<L3Order>,
    /// trigger orders (asks) - sorted by trigger price, post-trigger price calculated dynamically
    trigger_asks: Vec<L3Order>,
}

impl L3Book {
    /// Return iterator over list of trigger-able bids at given `trigger_price`
    pub fn trigger_bids(&self, trigger_price: u64) -> impl Iterator<Item = &L3Order> {
        self.trigger_bids.iter().filter(move |x| {
            (x.is_trigger_above() && trigger_price > x.price)
                || (!x.is_trigger_above() && trigger_price < x.price)
        })
    }
    /// Return iterator over list of trigger-able asks at given `trigger_price`
    pub fn trigger_asks(&self, trigger_price: u64) -> impl Iterator<Item = &L3Order> {
        self.trigger_asks.iter().filter(move |x| {
            (x.is_trigger_above() && trigger_price > x.price)
                || (!x.is_trigger_above() && trigger_price < x.price)
        })
    }
    /// Get all L3 bids
    ///
    /// # Parameters
    /// - `oracle_price`: oracle price for floating order price calculations
    /// - `perp_market`: Used to calculate VAMM fallback price of market/oracle (taker) auctions.
    ///   use `None` if only interested in maker orders
    /// - `trigger_price`: Optional trigger price for calculating post-trigger prices of trigger orders.
    ///   If provided, trigger orders will be included and sorted by their post-trigger price.
    ///
    /// # Returns
    /// Returns an iterator over the bids
    pub fn bids<'b>(
        &self,
        oracle_price: Option<u64>,
        perp_market: Option<&'b PerpMarket>,
        trigger_price: Option<u64>,
    ) -> impl Iterator<Item = &L3Order> + use<'_, 'b> {
        let mut bids_iter = self.bids.iter().peekable();
        let mut floating_iter = self.floating_bids.iter().peekable();
        let mut vamm_iter = self.vamm_bids.iter().peekable();
        let mut trigger_iter = self.trigger_bids.iter().peekable();
        let oracle_diff: i64 =
            (oracle_price.unwrap_or_default() as i64).saturating_sub(self.oracle_price as i64);

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let slot = self.slot;
        let oracle_price_for_vamm = oracle_price.unwrap_or(self.oracle_price) as i64;

        // Skip non-triggering trigger orders
        if let Some(trig_price) = trigger_price {
            while let Some(x) = trigger_iter.peek() {
                if trig_price > x.price && x.is_trigger_above()
                    || trig_price < x.price && !x.is_trigger_above()
                {
                    break;
                }
                trigger_iter.next();
            }
        }

        enum Src {
            Fixed,
            Floating,
            Vamm,
            Trigger,
        }

        let next_from = move || {
            let a = bids_iter.peek();
            let f = floating_iter.peek();
            let t = trigger_iter.peek();
            let v = vamm_iter.peek();

            let mut best_price = u64::MIN;
            let mut best_src = None;

            if let Some(x) = a {
                best_price = x.price;
                best_src = Some(Src::Fixed);
            }

            if let Some(x) = f {
                let price = (x.price as i64 + oracle_diff) as u64;
                if price > best_price {
                    best_price = price;
                    best_src = Some(Src::Floating);
                }
            }

            if let Some(market) = perp_market {
                // include trigger orders at their post-trigger price
                if let (Some(x), Some(trig_price)) = (t, trigger_price) {
                    let would_trigger = (x.is_trigger_above() && trig_price > x.price)
                        || (!x.is_trigger_above() && trig_price < x.price);
                    if would_trigger {
                        if let Some(post_trigger_price) =
                            x.post_trigger_price(slot, oracle_price_for_vamm as u64, market)
                        {
                            if post_trigger_price > best_price {
                                best_price = post_trigger_price;
                                best_src = Some(Src::Trigger);
                            }
                        }
                    }
                }

                if let Some(x) = v {
                    if let Ok(liq) = drift::vlp::amm::math::amm::calculate_amm_available_liquidity(
                        &market.amm,
                        &PositionDirection::Long,
                        market.order_step_size,
                    ) {
                        if let Ok(vamm_price) = market.amm.get_fallback_price(
                            &market.market_stats,
                            &PositionDirection::Long,
                            liq,
                            oracle_price_for_vamm,
                            x.max_ts.saturating_sub(now) as i64,
                            market.market_stats.min_order_size,
                        ) {
                            if vamm_price > best_price {
                                best_src = Some(Src::Vamm);
                            }
                        }
                    }
                }
            }

            match best_src {
                Some(Src::Fixed) => bids_iter.next(),
                Some(Src::Floating) => floating_iter.next(),
                Some(Src::Vamm) => vamm_iter.next(),
                Some(Src::Trigger) => trigger_iter.next(),
                None => None,
            }
        };

        std::iter::from_fn(next_from)
    }
    /// Get the top N bids
    ///
    /// # Parameters
    /// - `count`: Maximum number of bids to return
    /// - `oracle_price`: Current oracle price for floating order price adjustments
    /// - `perp_market`: Used to calculate VAMM fallback price of market/oracle (taker) auctions.
    ///    use `None` if only interested in maker orders
    /// - `trigger_price`: Optional trigger price for calculating post-trigger prices of trigger orders.
    ///
    /// # Returns
    /// Returns an iterator over the highest-priced bids
    pub fn top_bids<'b>(
        &self,
        count: usize,
        oracle_price: Option<u64>,
        perp_market: Option<&'b PerpMarket>,
        trigger_price: Option<u64>,
    ) -> impl Iterator<Item = &L3Order> + use<'_, 'b> {
        self.bids(oracle_price, perp_market, trigger_price)
            .take(count)
    }

    /// Get all L3 asks
    ///
    /// # Parameters
    /// - `oracle_price`: oracle price for floating order price calculations
    /// - `perp_market`: Used to calculate VAMM fallback price of market/oracle (taker) auctions. i.e finished their
    ///  auction period and did not specify a custom limit price
    /// - `trigger_price`: Optional trigger price for calculating post-trigger prices of trigger orders.
    ///  If provided, trigger orders will be included and sorted by their post-trigger price.
    ///
    /// # Returns
    /// Returns an iterator over the asks
    pub fn asks<'b>(
        &self,
        oracle_price: Option<u64>,
        perp_market: Option<&'b PerpMarket>,
        trigger_price: Option<u64>,
    ) -> impl Iterator<Item = &L3Order> + use<'_, 'b> {
        let mut asks_iter = self.asks.iter().peekable();
        let mut floating_iter = self.floating_asks.iter().peekable();
        let mut vamm_iter = self.vamm_asks.iter().peekable();
        let mut trigger_iter = self.trigger_asks.iter().peekable();

        let oracle_diff: i64 =
            (oracle_price.unwrap_or_default() as i64).saturating_sub(self.oracle_price as i64);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Skip non-triggering trigger orders
        if let Some(trig_price) = trigger_price {
            while let Some(x) = trigger_iter.peek() {
                if trig_price > x.price && x.is_trigger_above()
                    || trig_price < x.price && !x.is_trigger_above()
                {
                    break;
                }
                trigger_iter.next();
            }
        }

        let slot = self.slot;
        let oracle_price_for_vamm = oracle_price.unwrap_or(self.oracle_price) as i64;

        enum Src {
            Fixed,
            Floating,
            Vamm,
            Trigger,
        }

        let next_from = move || {
            let a = asks_iter.peek();
            let f = floating_iter.peek();
            let v = vamm_iter.peek();
            let t = trigger_iter.peek();

            let mut best_price = u64::MAX;
            let mut best_src = None;

            if let Some(x) = a {
                best_price = x.price;
                best_src = Some(Src::Fixed);
            }

            if let Some(x) = f {
                let price = (x.price as i64 + oracle_diff) as u64;
                if price < best_price {
                    best_price = price;
                    best_src = Some(Src::Floating);
                }
            }

            if let Some(market) = perp_market {
                // include trigger orders at their post-trigger price
                if let (Some(x), Some(trig_price)) = (t, trigger_price) {
                    let would_trigger = (x.is_trigger_above() && trig_price > x.price)
                        || (!x.is_trigger_above() && trig_price < x.price);
                    if would_trigger {
                        if let Some(post_trigger_price) =
                            x.post_trigger_price(slot, oracle_price_for_vamm as u64, market)
                        {
                            if post_trigger_price < best_price {
                                best_src = Some(Src::Trigger);
                                best_price = post_trigger_price;
                            }
                        }
                    }
                }

                if let Some(x) = v {
                    if let Ok(liq) = drift::vlp::amm::math::amm::calculate_amm_available_liquidity(
                        &market.amm,
                        &PositionDirection::Short,
                        market.order_step_size,
                    ) {
                        if let Ok(vamm_price) = market.amm.get_fallback_price(
                            &market.market_stats,
                            &PositionDirection::Short,
                            liq,
                            oracle_price_for_vamm,
                            x.max_ts.saturating_sub(now) as i64,
                            market.market_stats.min_order_size,
                        ) {
                            if vamm_price < best_price {
                                best_src = Some(Src::Vamm);
                            }
                        }
                    }
                }
            }

            match best_src {
                Some(Src::Fixed) => asks_iter.next(),
                Some(Src::Floating) => floating_iter.next(),
                Some(Src::Trigger) => trigger_iter.next(),
                Some(Src::Vamm) => vamm_iter.next(),
                None => None,
            }
        };

        std::iter::from_fn(next_from)
    }

    /// Get the top N asks
    ///
    /// # Parameters
    /// - `count`: Maximum number of asks to return
    /// - `oracle_price`: oracle price for floating order price adjustments
    /// - `perp_market`: Used to calculate VAMM fallback price of market/oracle (taker) auctions. i.e finished their
    ///   auction period and did not specify a custom limit price
    /// - `trigger_price`: Optional trigger price for calculating post-trigger prices of trigger orders.
    ///
    /// # Returns
    /// Returns an iterator over the lowest-priced asks
    pub fn top_asks<'b>(
        &self,
        count: usize,
        oracle_price: Option<u64>,
        perp_market: Option<&'b PerpMarket>,
        trigger_price: Option<u64>,
    ) -> impl Iterator<Item = &L3Order> + use<'_, 'b> {
        self.asks(oracle_price, perp_market, trigger_price)
            .take(count)
    }

    /// Populate an `L3Book` instance given an `Orderbook` and `metadata`
    fn load_orderbook(
        &mut self,
        orderbook: &Orderbook,
        oracle_price: u64,
        metadata: &MetadataMap,
        order_events: &OrderEventMap,
    ) {
        self.bids.clear();
        self.asks.clear();
        self.floating_bids.clear();
        self.floating_asks.clear();
        self.vamm_bids.clear();
        self.vamm_asks.clear();
        self.trigger_bids.clear();
        self.trigger_asks.clear();

        self.slot = orderbook.last_modified_slot;
        self.oracle_price = oracle_price;
        let market_tick_size = orderbook.market_tick_size;

        // Debug counters: track orders with missing metadata
        let mut missing_metadata_count = 0u32;
        let mut total_orders_count = 0u32;

        let mut missing_fn = move |order_id: u64| {
            missing_metadata_count += 1;
            DLOB::log_missing_order_events_helper(order_id, order_events);
            log::info!(target: TARGET, "missing order id: {:?}", order_id);
        };

        // Add resting limit orders
        for order in orderbook.resting_limit_orders.bids.values() {
            total_orders_count += 1;
            if let Some(meta) = metadata.get(&order.id) {
                self.bids.push(L3Order {
                    price: order.get_price(),
                    size: order.size,
                    flags: (L3Order::RO_FLAG * (order.reduce_only as u8))
                        | L3Order::IS_LONG
                        | (L3Order::IS_POST_ONLY * (order.post_only as u8)),
                    user: meta.user,
                    order_id: meta.order_id,
                    kind: meta.kind,
                    max_ts: order.max_ts,
                });
            } else {
                missing_fn(order.id);
            }
        }

        for order in orderbook.resting_limit_orders.asks.values() {
            total_orders_count += 1;
            if let Some(meta) = metadata.get(&order.id) {
                self.asks.push(L3Order {
                    price: order.get_price(),
                    size: order.size,
                    flags: (L3Order::RO_FLAG * (order.reduce_only as u8))
                        | (L3Order::IS_POST_ONLY * (order.post_only as u8)),
                    user: meta.user,
                    order_id: meta.order_id,
                    kind: meta.kind,
                    max_ts: order.max_ts,
                });
            } else {
                missing_fn(order.id);
            }
        }

        // Add trigger orders
        //
        // Store trigger orders separately - they will be sorted by post-trigger price
        // dynamically when asks/bids() is called with a trigger_price parameter.
        // We include all trigger orders here (not just those near oracle) since
        // the trigger_price parameter in queries may differ from the oracle_price used here.
        for order in orderbook.trigger_orders.bids.values() {
            total_orders_count += 1;
            if let Some(meta) = metadata.get(&order.id) {
                self.trigger_bids.push(L3Order {
                    price: order.price, // This is the trigger price, not the post-trigger price
                    size: order.size,
                    flags: (L3Order::RO_FLAG * (order.reduce_only as u8))
                        | L3Order::IS_LONG
                        | (L3Order::IS_TRIGGER_ABOVE
                            * ((order.condition == OrderTriggerCondition::Above) as u8)),
                    user: meta.user,
                    order_id: meta.order_id,
                    kind: meta.kind,
                    max_ts: order.max_ts,
                });
            } else {
                missing_fn(order.id);
            }
        }

        for order in orderbook.trigger_orders.asks.values() {
            total_orders_count += 1;
            if let Some(meta) = metadata.get(&order.id) {
                self.trigger_asks.push(L3Order {
                    price: order.price, // This is the trigger price, not the post-trigger price
                    size: order.size,
                    flags: (L3Order::RO_FLAG * (order.reduce_only as u8))
                        | (L3Order::IS_TRIGGER_ABOVE
                            * ((order.condition == OrderTriggerCondition::Above) as u8)),
                    user: meta.user,
                    order_id: meta.order_id,
                    kind: meta.kind,
                    max_ts: order.max_ts,
                });
            } else {
                missing_fn(order.id);
            }
        }

        for order in orderbook.market_orders.bids.values() {
            total_orders_count += 1;
            if let Some(meta) = metadata.get(&order.id) {
                let price = order
                    .get_price(self.slot, oracle_price, market_tick_size)
                    .unwrap_or_default(); // 0 => fill at vamm price
                let order = L3Order {
                    price,
                    size: order.size(),
                    flags: (L3Order::RO_FLAG * (order.reduce_only as u8)) | L3Order::IS_LONG,
                    user: meta.user,
                    order_id: meta.order_id,
                    max_ts: order.max_ts,
                    kind: meta.kind,
                };
                if order.price > 0 {
                    self.bids.push(order);
                } else {
                    self.vamm_bids.push(order);
                }
            } else {
                missing_fn(order.id);
            }
        }

        for order in orderbook.market_orders.asks.values() {
            total_orders_count += 1;
            if let Some(meta) = metadata.get(&order.id) {
                let price = order
                    .get_price(self.slot, oracle_price, market_tick_size)
                    .unwrap_or_default(); // 0 => fill at vamm price
                let order = L3Order {
                    price,
                    size: order.size(),
                    flags: (L3Order::RO_FLAG * (order.reduce_only as u8)),
                    user: meta.user,
                    order_id: meta.order_id,
                    max_ts: order.max_ts,
                    kind: meta.kind,
                };
                if order.price > 0 {
                    self.asks.push(order);
                } else {
                    self.vamm_asks.push(order);
                }
            } else {
                missing_fn(order.id);
            }
        }

        // Add floating limit orders
        for order in orderbook.floating_limit_orders.bids.values() {
            total_orders_count += 1;
            if let Some(meta) = metadata.get(&order.id) {
                self.floating_bids.push(L3Order {
                    price: order.get_price(oracle_price, market_tick_size),
                    size: order.size,
                    flags: (L3Order::RO_FLAG * (order.reduce_only as u8))
                        | L3Order::IS_LONG
                        | (L3Order::IS_POST_ONLY * (order.post_only as u8)),
                    user: meta.user,
                    order_id: meta.order_id,
                    max_ts: order.max_ts,
                    kind: meta.kind,
                });
            } else {
                missing_fn(order.id);
            }
        }

        for order in orderbook.floating_limit_orders.asks.values() {
            total_orders_count += 1;
            if let Some(meta) = metadata.get(&order.id) {
                self.floating_asks.push(L3Order {
                    price: order.get_price(oracle_price, market_tick_size),
                    size: order.size,
                    flags: (L3Order::RO_FLAG * (order.reduce_only as u8))
                        | (L3Order::IS_POST_ONLY * (order.post_only as u8)),
                    user: meta.user,
                    order_id: meta.order_id,
                    max_ts: order.max_ts,
                    kind: meta.kind,
                });
            } else {
                missing_fn(order.id);
            }
        }

        // Add oracle orders as taker orders
        for order in orderbook.oracle_orders.bids.values() {
            total_orders_count += 1;
            if let Some(meta) = metadata.get(&order.id) {
                let price = order
                    .get_price(self.slot, oracle_price, market_tick_size)
                    .unwrap_or_default();
                let order = L3Order {
                    price,
                    size: order.size(),
                    flags: (L3Order::RO_FLAG * (order.reduce_only as u8)) | L3Order::IS_LONG,
                    user: meta.user,
                    order_id: meta.order_id,
                    max_ts: order.max_ts,
                    kind: meta.kind,
                };
                if order.price > 0 {
                    self.floating_bids.push(order);
                } else {
                    self.vamm_bids.push(order);
                }
            } else {
                missing_fn(order.id);
            }
        }

        for order in orderbook.oracle_orders.asks.values() {
            total_orders_count += 1;
            if let Some(meta) = metadata.get(&order.id) {
                let price = order
                    .get_price(self.slot, oracle_price, market_tick_size)
                    .unwrap_or_default();
                let order = L3Order {
                    price,
                    size: order.size(),
                    flags: (L3Order::RO_FLAG * (order.reduce_only as u8)),
                    user: meta.user,
                    order_id: meta.order_id,
                    max_ts: order.max_ts,
                    kind: meta.kind,
                };
                if order.price > 0 {
                    self.floating_asks.push(order);
                } else {
                    self.vamm_asks.push(order);
                }
            } else {
                missing_fn(order.id);
            }
        }

        // Log warning if we found orders without metadata
        if missing_metadata_count > 0 {
            log::warn!(
                target: TARGET,
                "L3Book: Found {} orders without metadata out of {} total orders (market: {})",
                missing_metadata_count,
                total_orders_count,
                orderbook.market.index()
            );
        }

        // Sort bids in descending order (highest first)
        self.bids.sort_by(|a, b| b.price.cmp(&a.price));
        // Sort asks in ascending order (lowest first)
        self.asks.sort_by(|a, b| a.price.cmp(&b.price));
        // sort by expiry time (smallest buffer from vamm price first)
        self.vamm_bids.sort_by(|a, b| a.max_ts.cmp(&b.max_ts));
        // sort by expiry time (smallest buffer from vamm price first)
        self.vamm_asks.sort_by(|a, b| a.max_ts.cmp(&b.max_ts));
        // Sort bids in descending order (highest first)
        self.floating_bids.sort_by(|a, b| b.price.cmp(&a.price));
        // Sort asks in ascending order (lowest first)
        self.floating_asks.sort_by(|a, b| a.price.cmp(&b.price));
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct L2Book {
    /// price → aggregated size (maker orders only)
    pub bids: BTreeMap<u64, u64>,
    /// price → aggregated size (maker orders only)
    pub asks: BTreeMap<u64, u64>,
    /// cumulative order size at VAMM ask
    pub vamm_ask_size: u64,
    /// cumulative order size at VAMM bid
    pub vamm_bid_size: u64,
    pub oracle_price: u64,
    pub slot: u64,
}

impl std::fmt::Display for L2Book {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "L2 Order Book:")?;
        writeln!(f, "-------------")?;

        // Get top 5 asks in order (highest to lowest)
        let asks: Vec<_> = self.asks.iter().take(5).collect();
        for (price, size) in asks {
            writeln!(f, "ASK: {:>10} | {:>10}", price, size)?;
        }

        writeln!(f, "-------------")?;

        // Get top 5 bids (highest to lowest)
        let bids: Vec<_> = self.bids.iter().rev().take(5).collect();
        for (price, size) in bids {
            writeln!(f, "BID: {:>10} | {:>10}", price, size)?;
        }

        Ok(())
    }
}

impl L2Book {
    /// Get the best bid and ask from maker orders (resting limit orders)
    ///
    /// Returns `(best_bid, best_ask)` where each is an `Option<(price, size)>`.
    /// The best bid is the highest price bid, and the best ask is the lowest price ask.
    /// Returns `None` if there are no orders on that side.
    ///
    /// # Example
    /// ```rust
    /// let (bid, ask) = l2_book.bbo();
    /// if let (Some((bid_price, bid_size)), Some((ask_price, ask_size))) = (bid, ask) {
    ///     println!("Best bid: {} @ {}", bid_size, bid_price);
    ///     println!("Best ask: {} @ {}", ask_size, ask_price);
    /// }
    /// ```
    pub fn bbo(&self) -> (Option<(u64, u64)>, Option<(u64, u64)>) {
        (
            self.bids.first_key_value().map(|x| (*x.0, *x.1)),
            self.asks.first_key_value().map(|x| (*x.0, *x.1)),
        )
    }

    /// Get the top N maker bids (resting limit orders) sorted by price descending
    ///
    /// Returns a vector of `(price, size)` tuples for the highest-priced maker bids.
    ///
    /// # Example
    /// ```rust
    /// let top_bids = l2_book.top_bids(5);
    /// for (price, size) in top_bids {
    ///     println!("Bid: {} @ {}", size, price);
    /// }
    /// ```
    pub fn top_bids(&self, count: usize) -> Vec<(u64, u64)> {
        self.bids.iter().take(count).map(|x| (*x.0, *x.1)).collect()
    }

    /// Get the top N maker asks (resting limit orders) sorted by price ascending
    ///
    /// Returns a vector of `(price, size)` tuples for the lowest-priced maker asks.
    ///
    /// # Example
    /// ```rust
    /// let top_asks = l2_book.top_asks(5);
    /// for (price, size) in top_asks {
    ///     println!("Ask: {} @ {}", size, price);
    /// }
    /// ```
    pub fn top_asks(&self, count: usize) -> Vec<(u64, u64)> {
        self.asks.iter().take(count).map(|x| (*x.0, *x.1)).collect()
    }

    fn reset(&mut self) {
        self.bids.clear();
        self.asks.clear();
        self.slot = 0;
        self.oracle_price = 0;
        self.vamm_ask_size = 0;
        self.vamm_bid_size = 0;
    }

    /// Initialize the L2Book with all order types
    ///
    /// NOTE: orders with size 64::MAX indicate max leverage orders
    fn load_orderbook(&mut self, orderbook: &Orderbook, oracle_price: u64) {
        self.reset();
        self.slot = orderbook.last_modified_slot;
        self.oracle_price = oracle_price;
        let market_tick_size = orderbook.market_tick_size;

        // Process resting limit orders (fixed price orders)
        for order in orderbook.resting_limit_orders.bids.values() {
            let size = self.bids.entry(order.price).or_insert(0);
            *size = size.saturating_add(order.size);
        }
        for order in orderbook.resting_limit_orders.asks.values() {
            let size = self.asks.entry(order.price).or_insert(0);
            *size = size.saturating_add(order.size);
        }

        // Process floating limit orders (oracle-relative price orders)
        for order in orderbook.floating_limit_orders.bids.values() {
            let price = order.get_price(oracle_price, market_tick_size);
            let size = self.bids.entry(price).or_insert(0);
            *size = size.saturating_add(order.size);
        }
        for order in orderbook.floating_limit_orders.asks.values() {
            let price = order.get_price(oracle_price, market_tick_size);
            let size = self.asks.entry(price).or_insert(0);
            *size = size.saturating_add(order.size);
        }

        // Process trigger orders as taker orders
        for order in orderbook
            .trigger_orders
            .bids
            .values()
            .filter(|o| o.price <= oracle_price)
        {
            let price = order.price;
            let size = self.bids.entry(price).or_insert(0);

            *size = size.saturating_add(order.size);
        }
        for order in orderbook
            .trigger_orders
            .asks
            .values()
            .filter(|o| o.price >= oracle_price)
        {
            let price = order.price;
            let size = self.asks.entry(price).or_insert(0);

            *size = size.saturating_add(order.size);
        }

        // Process market orders as taker orders
        for order in orderbook.market_orders.bids.values() {
            if order.size > 0 {
                if let Some(price) = order.get_price(self.slot, oracle_price, market_tick_size) {
                    let size = self.bids.entry(price).or_insert(0);
                    *size = size.saturating_add(order.size);
                } else {
                    self.vamm_bid_size += order.size;
                }
            }
        }
        for order in orderbook.market_orders.asks.values() {
            if order.size > 0 {
                if let Some(price) = order.get_price(self.slot, oracle_price, market_tick_size) {
                    let size = self.asks.entry(price).or_insert(0);
                    *size = size.saturating_add(order.size);
                } else {
                    self.vamm_ask_size += order.size;
                }
            }
        }

        // Process oracle orders as taker orders
        for order in orderbook.oracle_orders.bids.values() {
            if order.size > 0 {
                if let Some(price) = order.get_price(self.slot, oracle_price, market_tick_size) {
                    let size = self.bids.entry(price).or_insert(0);
                    *size = size.saturating_add(order.size);
                } else {
                    self.vamm_bid_size += order.size;
                }
            }
        }
        for order in orderbook.oracle_orders.asks.values() {
            if order.size > 0 {
                if let Some(price) = order.get_price(self.slot, oracle_price, market_tick_size) {
                    let size = self.asks.entry(price).or_insert(0);
                    *size = size.saturating_add(order.size);
                } else {
                    self.vamm_ask_size += order.size;
                }
            }
        }
    }
}
