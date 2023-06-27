use anyhow::{anyhow, Result};
use std::collections::HashMap;

use anchor_lang::prelude::Pubkey;
use drift::{
    controller::position::PositionDirection,
    state::{
        oracle::OraclePriceData,
        user::{MarketType, Order, OrderStatus, OrderTriggerCondition, OrderType},
    },
};

use crate::types::DriftClientAccountSubscriber;

#[derive(Debug, Clone, Copy)]
pub enum SortDirection {
    Ascending,
    Descending,
}

pub trait DlobNode {
    fn get_price(
        &self,
        oracle_price_data: OraclePriceData,
        slot: u64,
        tick_size: u64,
    ) -> Option<u64>;
    fn is_vamm_node(&self) -> bool;
    fn order(&self) -> Order;
    fn user(&self) -> Pubkey;
    fn get_sort_value(&self) -> i128;
    fn get_sort_direction(&self) -> SortDirection;
}

pub struct TakingLimitOrderNode {
    user: Pubkey,
    order: Order,
    sort_direction: SortDirection,
}
impl DlobNode for TakingLimitOrderNode {
    fn get_price(
        &self,
        oracle_price_data: OraclePriceData,
        slot: u64,
        tick_size: u64,
    ) -> Option<u64> {
        self.order
            .get_limit_price(Some(oracle_price_data.price), None, slot, tick_size)
            .unwrap()
    }
    fn get_sort_value(&self) -> i128 {
        self.order.slot as i128
    }
    fn get_sort_direction(&self) -> SortDirection {
        self.sort_direction
    }
    fn is_vamm_node(&self) -> bool {
        false
    }
    fn order(&self) -> Order {
        self.order
    }
    fn user(&self) -> Pubkey {
        self.user
    }
}

pub struct RestingLimitOrderNode {
    user: Pubkey,
    order: Order,
    sort_direction: SortDirection,
}
impl DlobNode for RestingLimitOrderNode {
    fn get_price(
        &self,
        oracle_price_data: OraclePriceData,
        slot: u64,
        tick_size: u64,
    ) -> Option<u64> {
        self.order
            .get_limit_price(Some(oracle_price_data.price), None, slot, tick_size)
            .unwrap()
    }
    fn get_sort_value(&self) -> i128 {
        self.order.price as i128
    }
    fn get_sort_direction(&self) -> SortDirection {
        self.sort_direction
    }
    fn is_vamm_node(&self) -> bool {
        false
    }
    fn order(&self) -> Order {
        self.order
    }
    fn user(&self) -> Pubkey {
        self.user
    }
}

pub struct FloatingLimitOrderNode {
    user: Pubkey,
    order: Order,
    sort_direction: SortDirection,
}
impl DlobNode for FloatingLimitOrderNode {
    fn get_price(
        &self,
        oracle_price_data: OraclePriceData,
        slot: u64,
        tick_size: u64,
    ) -> Option<u64> {
        self.order
            .get_limit_price(Some(oracle_price_data.price), None, slot, tick_size)
            .unwrap()
    }
    fn get_sort_value(&self) -> i128 {
        self.order.oracle_price_offset as i128
    }
    fn get_sort_direction(&self) -> SortDirection {
        self.sort_direction
    }
    fn is_vamm_node(&self) -> bool {
        false
    }
    fn order(&self) -> Order {
        self.order
    }
    fn user(&self) -> Pubkey {
        self.user
    }
}

pub struct MarketOrderNode {
    user: Pubkey,
    order: Order,
}
impl DlobNode for MarketOrderNode {
    fn get_price(
        &self,
        oracle_price_data: OraclePriceData,
        slot: u64,
        tick_size: u64,
    ) -> Option<u64> {
        self.order
            .get_limit_price(Some(oracle_price_data.price), None, slot, tick_size)
            .unwrap()
    }
    fn get_sort_value(&self) -> i128 {
        self.order.slot as i128
    }
    /// Market orders are always ascending
    fn get_sort_direction(&self) -> SortDirection {
        SortDirection::Ascending
    }
    fn is_vamm_node(&self) -> bool {
        false
    }
    fn order(&self) -> Order {
        self.order
    }
    fn user(&self) -> Pubkey {
        self.user
    }
}

pub struct TriggerOrderNode {
    user: Pubkey,
    order: Order,
    sort_direction: SortDirection,
}
impl DlobNode for TriggerOrderNode {
    fn get_price(
        &self,
        oracle_price_data: OraclePriceData,
        slot: u64,
        tick_size: u64,
    ) -> Option<u64> {
        self.order
            .get_limit_price(Some(oracle_price_data.price), None, slot, tick_size)
            .unwrap()
    }
    fn get_sort_value(&self) -> i128 {
        self.order.trigger_price as i128
    }
    fn get_sort_direction(&self) -> SortDirection {
        self.sort_direction
    }
    fn is_vamm_node(&self) -> bool {
        false
    }
    fn order(&self) -> Order {
        self.order
    }
    fn user(&self) -> Pubkey {
        self.user
    }
}

pub struct NormalNodeList {
    ask: Vec<Box<dyn DlobNode>>,
    bid: Vec<Box<dyn DlobNode>>,
}

pub struct TriggerNodeList {
    above: Vec<Box<dyn DlobNode>>,
    below: Vec<Box<dyn DlobNode>>,
}

pub struct NodeLists {
    resting_limit: NormalNodeList,
    floating_limit: NormalNodeList,
    taking_limit: NormalNodeList,
    market: NormalNodeList,
    trigger: TriggerNodeList,
}
impl NodeLists {
    fn default() -> NodeLists {
        NodeLists {
            resting_limit: NormalNodeList {
                ask: vec![],
                bid: vec![],
            },
            floating_limit: NormalNodeList {
                ask: vec![],
                bid: vec![],
            },
            taking_limit: NormalNodeList {
                ask: vec![],
                bid: vec![],
            },
            market: NormalNodeList {
                ask: vec![],
                bid: vec![],
            },
            trigger: TriggerNodeList {
                above: vec![],
                below: vec![],
            },
        }
    }
}

pub struct Dlob {
    pub account_subscriber: Box<dyn DriftClientAccountSubscriber>,

    dlob_init: bool,
    perp_order_lists: HashMap<u16, NodeLists>, // market index -> list of orders
    spot_order_lists: HashMap<u16, NodeLists>, // market index -> list of orders
}

impl Dlob {
    pub fn builder() -> DlobBuilder {
        DlobBuilder::default()
    }

    /// Loads on-chain accounts into the load drift client and assembles the , you should call this after builder.build()
    pub fn load(&mut self) -> Result<(), anyhow::Error> {
        self.account_subscriber.load()?;
        self.init_dlob()?;
        Ok(())
    }

    fn init_dlob(&mut self) -> Result<(), anyhow::Error> {
        if self.dlob_init {
            return Ok(());
        }

        // TOOD: get all user orders and insert their orders

        self.dlob_init = true;
        Ok(())
    }

    fn get_trigger_orders_list(
        &mut self,
        market_type: MarketType,
        trigger_condition: OrderTriggerCondition,
        market_index: u16,
    ) -> &mut Vec<Box<dyn DlobNode>> {
        match market_type {
            MarketType::Perp => match trigger_condition {
                OrderTriggerCondition::Above => {
                    &mut self
                        .perp_order_lists
                        .get_mut(&market_index)
                        .unwrap()
                        .trigger
                        .above
                }
                OrderTriggerCondition::Below => {
                    &mut self
                        .perp_order_lists
                        .get_mut(&market_index)
                        .unwrap()
                        .trigger
                        .below
                }
                _ => {
                    panic!("Invalid trigger condition {:?}", trigger_condition)
                }
            },
            MarketType::Spot => match trigger_condition {
                OrderTriggerCondition::Above => {
                    &mut self
                        .spot_order_lists
                        .get_mut(&market_index)
                        .unwrap()
                        .trigger
                        .above
                }
                OrderTriggerCondition::Below => {
                    &mut self
                        .spot_order_lists
                        .get_mut(&market_index)
                        .unwrap()
                        .trigger
                        .below
                }
                _ => {
                    panic!("Invalid trigger condition {:?}", trigger_condition)
                }
            },
            _ => {
                panic!("Invalid market type")
            }
        }
    }

    fn insert_inactive_trigger_order(
        &mut self,
        user: Pubkey,
        order: Order,
    ) -> Result<(), anyhow::Error> {
        let list = &mut self.get_trigger_orders_list(
            order.market_type,
            order.trigger_condition,
            order.market_index,
        );
        match order.trigger_condition {
            OrderTriggerCondition::Above => {
                let new_node = Box::new(TriggerOrderNode {
                    user: user,
                    order: order.clone(),
                    sort_direction: SortDirection::Ascending,
                });
                let index = match list.binary_search_by(|probe| {
                    probe.get_sort_value().cmp(&new_node.get_sort_value())
                }) {
                    Ok(index) => index,
                    Err(index) => index,
                };
                list.insert(index, new_node);
            }
            OrderTriggerCondition::Below => {
                let new_node = Box::new(TriggerOrderNode {
                    user: user,
                    order: order.clone(),
                    sort_direction: SortDirection::Descending,
                });
                let index = match list.binary_search_by(|probe| {
                    new_node.get_sort_value().cmp(&probe.get_sort_value())
                }) {
                    Ok(index) => index,
                    Err(index) => index,
                };
                list.insert(index, new_node);
            }
            _ => {
                panic!(
                    "Invalid inactive trigger condition {:?}",
                    order.trigger_condition
                )
            }
        }

        Ok(())
    }

    fn get_market_orders_list(
        &mut self,
        market_type: MarketType,
        direction: PositionDirection,
        market_index: u16,
    ) -> &mut Vec<Box<dyn DlobNode>> {
        match market_type {
            MarketType::Perp => match direction {
                PositionDirection::Long => {
                    &mut self
                        .perp_order_lists
                        .get_mut(&market_index)
                        .unwrap()
                        .market
                        .bid
                }
                PositionDirection::Short => {
                    &mut self
                        .perp_order_lists
                        .get_mut(&market_index)
                        .unwrap()
                        .market
                        .ask
                }
                _ => {
                    panic!("Invalid position direction {:?}", direction)
                }
            },
            MarketType::Spot => match direction {
                PositionDirection::Long => {
                    &mut self
                        .spot_order_lists
                        .get_mut(&market_index)
                        .unwrap()
                        .market
                        .bid
                }
                PositionDirection::Short => {
                    &mut self
                        .spot_order_lists
                        .get_mut(&market_index)
                        .unwrap()
                        .market
                        .ask
                }
                _ => {
                    panic!("Invalid position direction {:?}", direction)
                }
            },
            _ => {
                panic!("Invalid market type")
            }
        }
    }

    fn insert_market_order(&mut self, user: Pubkey, order: Order) -> Result<(), anyhow::Error> {
        let list = &mut self.get_market_orders_list(
            order.market_type,
            order.direction,
            order.market_index,
        );

        let new_node = Box::new(MarketOrderNode {
            user: user,
            order: order.clone(),
        });
        let index = match list
            .binary_search_by(|probe| probe.get_sort_value().cmp(&new_node.get_sort_value()))
        {
            Ok(index) => index,
            Err(index) => index,
        };
        list.insert(index, new_node);
        Ok(())
    }

    fn get_floating_limit_orders_list(
        &mut self,
        market_type: MarketType,
        direction: PositionDirection,
        market_index: u16,
    ) -> &mut Vec<Box<dyn DlobNode>> {
        match market_type {
            MarketType::Perp => match direction {
                PositionDirection::Long => {
                    &mut self
                        .perp_order_lists
                        .get_mut(&market_index)
                        .unwrap()
                        .floating_limit
                        .bid
                }
                PositionDirection::Short => {
                    &mut self
                        .perp_order_lists
                        .get_mut(&market_index)
                        .unwrap()
                        .floating_limit
                        .ask
                }
                _ => {
                    panic!("Invalid position direction {:?}", direction)
                }
            },
            MarketType::Spot => match direction {
                PositionDirection::Long => {
                    &mut self
                        .spot_order_lists
                        .get_mut(&market_index)
                        .unwrap()
                        .floating_limit
                        .bid
                }
                PositionDirection::Short => {
                    &mut self
                        .spot_order_lists
                        .get_mut(&market_index)
                        .unwrap()
                        .floating_limit
                        .ask
                }
                _ => {
                    panic!("Invalid position direction {:?}", direction)
                }
            },
            _ => {
                panic!("Invalid market type")
            }
        }
    }

    fn insert_floating_limit_order(
        &mut self,
        user: Pubkey,
        order: Order,
    ) -> Result<(), anyhow::Error> {
        let list = &mut self.get_floating_limit_orders_list(
            order.market_type,
            order.direction,
            order.market_index,
        );

        match order.direction {
            PositionDirection::Long => {
                let new_node = Box::new(FloatingLimitOrderNode {
                    user: user,
                    order: order.clone(),
                    sort_direction: SortDirection::Descending,
                });
                let index = match list.binary_search_by(|probe| {
                    new_node.get_sort_value().cmp(&probe.get_sort_value())
                }) {
                    Ok(index) => index,
                    Err(index) => index,
                };
                list.insert(index, new_node);
            }
            PositionDirection::Short => {
                let new_node = Box::new(FloatingLimitOrderNode {
                    user: user,
                    order: order.clone(),
                    sort_direction: SortDirection::Ascending,
                });
                let index = match list.binary_search_by(|probe| {
                    probe.get_sort_value().cmp(&new_node.get_sort_value())
                }) {
                    Ok(index) => index,
                    Err(index) => index,
                };
                list.insert(index, new_node);
            }
        }
        Ok(())
    }

    fn insert_resting_limit_order(
        &mut self,
        slot: u64,
        user: Pubkey,
        order: Order,
    ) -> Result<(), anyhow::Error> {
        match order.market_type {
            MarketType::Perp => {
                match order.direction {
                    PositionDirection::Long => {
                        // TODO: sorted insert
                        self.perp_order_lists
                            .get_mut(&order.market_index)
                            .unwrap()
                            .resting_limit
                            .bid
                            .push(Box::new(RestingLimitOrderNode {
                                user,
                                order: order.clone(),
                                sort_direction: SortDirection::Descending,
                            }));
                    }
                    PositionDirection::Short => {
                        // TODO: sorted insert
                        self.perp_order_lists
                            .get_mut(&order.market_index)
                            .unwrap()
                            .resting_limit
                            .ask
                            .push(Box::new(RestingLimitOrderNode {
                                user,
                                order: order.clone(),
                                sort_direction: SortDirection::Ascending,
                            }));
                    }
                }
            }
            MarketType::Spot => {
                match order.direction {
                    PositionDirection::Long => {
                        // TODO: sorted insert
                        self.spot_order_lists
                            .get_mut(&order.market_index)
                            .unwrap()
                            .resting_limit
                            .bid
                            .push(Box::new(RestingLimitOrderNode {
                                user,
                                order: order.clone(),
                                sort_direction: SortDirection::Descending,
                            }));
                    }
                    PositionDirection::Short => {
                        // TODO: sorted insert
                        self.spot_order_lists
                            .get_mut(&order.market_index)
                            .unwrap()
                            .resting_limit
                            .ask
                            .push(Box::new(RestingLimitOrderNode {
                                user,
                                order: order.clone(),
                                sort_direction: SortDirection::Ascending,
                            }));
                    }
                }
            }
            _ => {
                return Err(anyhow!("invalid market type"));
            }
        }
        Ok(())
    }

    fn insert_taking_limit_order(
        &mut self,
        slot: u64,
        user: Pubkey,
        order: Order,
    ) -> Result<(), anyhow::Error> {
        match order.market_type {
            MarketType::Perp => {
                match order.direction {
                    PositionDirection::Long => {
                        // TODO: sorted insert
                        self.perp_order_lists
                            .get_mut(&order.market_index)
                            .unwrap()
                            .taking_limit
                            .bid
                            .push(Box::new(RestingLimitOrderNode {
                                user,
                                order: order.clone(),
                                sort_direction: SortDirection::Descending,
                            }));
                    }
                    PositionDirection::Short => {
                        // TODO: sorted insert
                        self.perp_order_lists
                            .get_mut(&order.market_index)
                            .unwrap()
                            .taking_limit
                            .ask
                            .push(Box::new(RestingLimitOrderNode {
                                user,
                                order: order.clone(),
                                sort_direction: SortDirection::Ascending,
                            }));
                    }
                }
            }
            MarketType::Spot => {
                match order.direction {
                    PositionDirection::Long => {
                        // TODO: sorted insert
                        self.spot_order_lists
                            .get_mut(&order.market_index)
                            .unwrap()
                            .taking_limit
                            .bid
                            .push(Box::new(RestingLimitOrderNode {
                                user,
                                order: order.clone(),
                                sort_direction: SortDirection::Descending,
                            }));
                    }
                    PositionDirection::Short => {
                        // TODO: sorted insert
                        self.spot_order_lists
                            .get_mut(&order.market_index)
                            .unwrap()
                            .taking_limit
                            .ask
                            .push(Box::new(RestingLimitOrderNode {
                                user,
                                order: order.clone(),
                                sort_direction: SortDirection::Ascending,
                            }));
                    }
                }
            }
            _ => {
                return Err(anyhow!("invalid market type"));
            }
        }
        Ok(())
    }

    fn ensure_market_index_in_list(&mut self, market_type: MarketType, market_index: u16) {
        match market_type {
            MarketType::Perp => {
                if !self.perp_order_lists.contains_key(&market_index) {
                    self.perp_order_lists
                        .insert(market_index, NodeLists::default());
                }
            }
            MarketType::Spot => {
                if !self.spot_order_lists.contains_key(&market_index) {
                    self.spot_order_lists
                        .insert(market_index, NodeLists::default());
                }
            }
        };
    }

    fn insert_order(&mut self, slot: u64, user: Pubkey, order: Order) -> Result<(), anyhow::Error> {
        assert!(self.dlob_init, "must call init_dlob first");

        match order.status {
            OrderStatus::Init => return Ok(()),
            _ => {}
        };

        match order.order_type {
            OrderType::Limit
            | OrderType::Market
            | OrderType::TriggerLimit
            | OrderType::TriggerMarket
            | OrderType::Oracle => {}
            _ => return Ok(()),
        };

        self.ensure_market_index_in_list(order.market_type, order.market_index);

        let is_inactive_trigger = match order.order_type {
            OrderType::TriggerLimit | OrderType::TriggerMarket => !order.triggered(),
            _ => false,
        };

        if is_inactive_trigger {
            self.insert_inactive_trigger_order(user, order)?;
        } else {
            match order.order_type {
                OrderType::Market | OrderType::TriggerMarket | OrderType::Oracle => {
                    self.insert_market_order(user, order)?;
                }
                _ => {
                    if order.oracle_price_offset != 0 {
                        self.insert_floating_limit_order(user, order)?;
                    } else {
                        match order.is_resting_limit_order(slot).unwrap() {
                            true => self.insert_resting_limit_order(slot, user, order)?,
                            false => self.insert_taking_limit_order(slot, user, order)?,
                        };
                    }
                }
            }
        }

        Ok(())
    }
}

pub struct DlobBuilder {
    pub account_subscriber: Option<Box<dyn DriftClientAccountSubscriber>>,
}

impl Default for DlobBuilder {
    fn default() -> Self {
        Self {
            account_subscriber: None,
        }
    }
}

impl DlobBuilder {
    pub fn account_subscriber(
        mut self,
        account_subscriber: Box<dyn DriftClientAccountSubscriber>,
    ) -> Self {
        self.account_subscriber = Some(account_subscriber);
        self
    }

    fn build(self) -> Result<Dlob, &'static str> {
        if self.account_subscriber.is_none() {
            panic!("drift_client_account_subscriber must be set");
        }

        Ok(Dlob {
            account_subscriber: self.account_subscriber.unwrap(),
            dlob_init: false,
            perp_order_lists: HashMap::new(),
            spot_order_lists: HashMap::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use drift::math::constants::PRICE_PRECISION_U64;

    use crate::types::DriftClientAccountSubscriberCommon;

    use super::*;

    #[tokio::test]
    async fn test_insert_inactive_trigger_order() {
        let mut dlob = DlobBuilder::default()
            .account_subscriber(Box::new(DriftClientAccountSubscriberCommon::default()))
            .build()
            .unwrap();
        let user = Pubkey::new_unique();

        let market_index = 0_u16;

        struct TestData {
            trigger_condition: OrderTriggerCondition,
            trigger_price: u64,
            direction: PositionDirection,
            order_id: u32,
        }

        for market_type in vec![MarketType::Perp, MarketType::Spot] {
            dlob.ensure_market_index_in_list(market_type, market_index);

            for test_data in vec![
                TestData {
                    trigger_condition: OrderTriggerCondition::Above,
                    trigger_price: (12.5 * PRICE_PRECISION_U64 as f64) as u64,
                    direction: PositionDirection::Long,
                    order_id: 1,
                },
                TestData {
                    trigger_condition: OrderTriggerCondition::Above,
                    trigger_price: (12.7 * PRICE_PRECISION_U64 as f64) as u64,
                    direction: PositionDirection::Short,
                    order_id: 2,
                },
                TestData {
                    trigger_condition: OrderTriggerCondition::Above,
                    trigger_price: (11.32222 * PRICE_PRECISION_U64 as f64) as u64,
                    direction: PositionDirection::Long,
                    order_id: 3,
                },
                TestData {
                    trigger_condition: OrderTriggerCondition::Below,
                    trigger_price: (12.5 * PRICE_PRECISION_U64 as f64) as u64,
                    direction: PositionDirection::Short,
                    order_id: 4,
                },
                TestData {
                    trigger_condition: OrderTriggerCondition::Below,
                    trigger_price: (12.7 * PRICE_PRECISION_U64 as f64) as u64,
                    direction: PositionDirection::Long,
                    order_id: 5,
                },
                TestData {
                    trigger_condition: OrderTriggerCondition::Below,
                    trigger_price: (11.34 * PRICE_PRECISION_U64 as f64) as u64,
                    direction: PositionDirection::Long,
                    order_id: 6,
                },
            ] {
                let mut order = Order::default();
                order.market_type = market_type;
                order.trigger_condition = test_data.trigger_condition;
                order.trigger_price = test_data.trigger_price;
                order.order_id = test_data.order_id;
                order.market_index = market_index;
                order.direction = test_data.direction;
                dlob.insert_inactive_trigger_order(user, order).unwrap();
            }

            match market_type {
                MarketType::Perp => {
                    for (market_index, perp_order_list) in dlob.perp_order_lists.iter() {
                        assert_eq!(market_index, &0_u16);
                        assert_eq!(perp_order_list.trigger.above.len(), 3);
                        assert_eq!(perp_order_list.trigger.below.len(), 3);
                        assert_eq!(perp_order_list.trigger.above[0].order().order_id, 3_u32);
                        assert_eq!(perp_order_list.trigger.above[1].order().order_id, 1_u32);
                        assert_eq!(perp_order_list.trigger.above[2].order().order_id, 2_u32);
                        assert_eq!(perp_order_list.trigger.below[0].order().order_id, 5_u32);
                        assert_eq!(perp_order_list.trigger.below[1].order().order_id, 4_u32);
                        assert_eq!(perp_order_list.trigger.below[2].order().order_id, 6_u32);
                    }
                }
                MarketType::Spot => {
                    for (market_index, spot_order_list) in dlob.spot_order_lists.iter() {
                        assert_eq!(market_index, &0_u16);
                        assert_eq!(spot_order_list.trigger.above.len(), 3);
                        assert_eq!(spot_order_list.trigger.below.len(), 3);
                        assert_eq!(spot_order_list.trigger.above[0].order().order_id, 3_u32);
                        assert_eq!(spot_order_list.trigger.above[1].order().order_id, 1_u32);
                        assert_eq!(spot_order_list.trigger.above[2].order().order_id, 2_u32);
                        assert_eq!(spot_order_list.trigger.below[0].order().order_id, 5_u32);
                        assert_eq!(spot_order_list.trigger.below[1].order().order_id, 4_u32);
                        assert_eq!(spot_order_list.trigger.below[2].order().order_id, 6_u32);
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn test_insert_market_order() {
        let mut dlob = DlobBuilder::default()
            .account_subscriber(Box::new(DriftClientAccountSubscriberCommon::default()))
            .build()
            .unwrap();
        let user = Pubkey::new_unique();

        let market_index = 0_u16;

        struct TestData {
            order_id: u32,
            direction: PositionDirection,
            slot: u64,
        }

        for market_type in vec![MarketType::Perp, MarketType::Spot] {
            dlob.ensure_market_index_in_list(market_type, market_index);

            for test_data in vec![
                TestData {
                    order_id: 1,
                    direction: PositionDirection::Long,
                    slot: 6,
                },
                TestData {
                    order_id: 2,
                    direction: PositionDirection::Short,
                    slot: 5,
                },
                TestData {
                    order_id: 3,
                    direction: PositionDirection::Long,
                    slot: 4,
                },
                TestData {
                    order_id: 4,
                    direction: PositionDirection::Short,
                    slot: 3,
                },
                TestData {
                    order_id: 5,
                    direction: PositionDirection::Long,
                    slot: 2,
                },
                TestData {
                    order_id: 6,
                    direction: PositionDirection::Short,
                    slot: 1,
                },
            ] {
                let mut order = Order::default();
                order.market_type = market_type;
                order.direction = test_data.direction;
                order.order_type = OrderType::Market;
                order.order_id = test_data.order_id;
                order.market_index = market_index;
                order.slot = test_data.slot;
                dlob.insert_market_order(user, order).unwrap();
            }

            match market_type {
                MarketType::Perp => {
                    for (i, order_id) in vec![5, 3, 1].iter().enumerate() {
                        let want = dlob.perp_order_lists.get(&market_index).unwrap().market.bid[i]
                            .order()
                            .order_id;
                        assert!(want == *order_id, "want: {}, got: {}", want, order_id);
                    }

                    for (i, order_id) in vec![6, 4, 2].iter().enumerate() {
                        let want = dlob.perp_order_lists.get(&market_index).unwrap().market.ask[i]
                            .order()
                            .order_id;
                        assert!(want == *order_id, "want: {}, got: {}", want, order_id);
                    }
                }
                MarketType::Spot => {
                    for (i, order_id) in vec![5, 3, 1].iter().enumerate() {
                        let want = dlob.spot_order_lists.get(&market_index).unwrap().market.bid[i]
                            .order()
                            .order_id;
                        assert!(want == *order_id, "want: {}, got: {}", want, order_id);
                    }

                    for (i, order_id) in vec![6, 4, 2].iter().enumerate() {
                        let want = dlob.spot_order_lists.get(&market_index).unwrap().market.ask[i]
                            .order()
                            .order_id;
                        assert!(want == *order_id, "want: {}, got: {}", want, order_id);
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn test_insert_floating_limit_order() {
        let mut dlob = DlobBuilder::default()
            .account_subscriber(Box::new(DriftClientAccountSubscriberCommon::default()))
            .build()
            .unwrap();
        let user = Pubkey::new_unique();

        let market_index = 0_u16;

        struct TestData {
            order_id: u32,
            direction: PositionDirection,
            oracle_price_offset: i32,
        }

        for market_type in vec![MarketType::Perp, MarketType::Spot] {
            dlob.ensure_market_index_in_list(market_type, market_index);

            for data in vec![
                TestData {
                    order_id: 1,
                    direction: PositionDirection::Long,
                    oracle_price_offset: (1.11 * PRICE_PRECISION_U64 as f64) as i32,
                },
                TestData {
                    order_id: 2,
                    direction: PositionDirection::Long,
                    oracle_price_offset: (0.91 * PRICE_PRECISION_U64 as f64) as i32,
                },
                TestData {
                    order_id: 3,
                    direction: PositionDirection::Long,
                    oracle_price_offset: (-1.23 * PRICE_PRECISION_U64 as f64) as i32,
                },
                TestData {
                    order_id: 4,
                    direction: PositionDirection::Short,
                    oracle_price_offset: (1.01 * PRICE_PRECISION_U64 as f64) as i32,
                },
                TestData {
                    order_id: 5,
                    direction: PositionDirection::Short,
                    oracle_price_offset: (1.22 * PRICE_PRECISION_U64 as f64) as i32,
                },
                TestData {
                    order_id: 6,
                    direction: PositionDirection::Short,
                    oracle_price_offset: (1.35 * PRICE_PRECISION_U64 as f64) as i32,
                },
            ] {
                let mut order = Order::default();
                order.market_index = market_index;
                order.market_type = market_type;
                order.order_id = data.order_id;
                order.direction = data.direction;
                order.order_type = OrderType::Limit;
                order.oracle_price_offset = data.oracle_price_offset;
                dlob.insert_floating_limit_order(user, order).unwrap();
            }

            match market_type {
                MarketType::Perp => {
                    for (i, order_id) in vec![1, 2, 3].iter().enumerate() {
                        let got = dlob
                            .perp_order_lists
                            .get(&market_index)
                            .unwrap()
                            .floating_limit
                            .bid[i]
                            .order()
                            .order_id;
                        let want = *order_id as u32;
                        assert!(got == want, "got: {}, want: {}", got, want);
                    }
                    for (i, order_id) in vec![4, 5, 6].iter().enumerate() {
                        let got = dlob
                            .perp_order_lists
                            .get(&market_index)
                            .unwrap()
                            .floating_limit
                            .ask[i]
                            .order()
                            .order_id;
                        let want = *order_id as u32;
                        assert!(got == want, "got: {}, want: {}", got, want);
                    }
                }
                MarketType::Spot => {
                    for (i, order_id) in vec![1, 2, 3].iter().enumerate() {
                        assert!(
                            dlob.spot_order_lists
                                .get(&market_index)
                                .unwrap()
                                .floating_limit
                                .bid[i]
                                .order()
                                .order_id
                                == (*order_id as u32)
                        );
                    }
                    for (i, order_id) in vec![4, 5, 6].iter().enumerate() {
                        assert!(
                            dlob.spot_order_lists
                                .get(&market_index)
                                .unwrap()
                                .floating_limit
                                .ask[i]
                                .order()
                                .order_id
                                == (*order_id as u32)
                        );
                    }
                }
            }
        }
    }
}
