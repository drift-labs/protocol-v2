use std::hash::{Hash, Hasher};

use crate::types::{accounts::User, Order, OrderStatus};
use ahash::AHasher;
use solana_pubkey::Pubkey;

/// change of order signal dlob
#[derive(Debug, PartialEq, Clone)]
pub enum OrderDelta {
    Create { order: Order },
    Remove { order: Order },
}

impl OrderDelta {
    pub fn order_id(&self) -> u32 {
        match self {
            Self::Create { order, .. } => order.order_id,
            Self::Remove { order, .. } => order.order_id,
        }
    }
}

/// Helper function to generate unique order Id hash for internal DLOB use
pub fn order_hash(user: &Pubkey, order_id: u32) -> u64 {
    let mut hasher = AHasher::default();
    user.hash(&mut hasher);
    order_id.hash(&mut hasher);
    hasher.finish()
}

pub fn compare_user_orders(pubkey: Pubkey, old: &User, new: &User) -> (Pubkey, Vec<OrderDelta>) {
    let mut deltas = Vec::<OrderDelta>::with_capacity(16);

    // an `order_id` may "point" to a different logical order between new/old states due to eventual consistency.
    // decide whether this transition represents an update to the same logical order OR
    // a reassignment to a logically different one
    //
    // the order of operations, remove old orders followed by insert new orders is required to ensure
    // correctness
    for existing_order in old.orders.iter().filter(|o| o.status == OrderStatus::Open) {
        match new
            .orders
            .iter()
            .find(|o| o.order_id == existing_order.order_id)
        {
            Some(new_order) => {
                if is_same_logical_order(existing_order, new_order) {
                    if new_order.status != OrderStatus::Open
                        || new_order.trigger_condition != existing_order.trigger_condition
                    {
                        // order has cancelled/filled/triggered
                        deltas.push(OrderDelta::Remove {
                            order: *existing_order,
                        });
                    } else {
                        // same logical order
                    }
                } else {
                    // this order_id points to a different order in `new` state
                    deltas.push(OrderDelta::Remove {
                        order: *existing_order,
                    });
                }
            }
            None => {
                // doesn't exist anymore remove
                deltas.push(OrderDelta::Remove {
                    order: *existing_order,
                });
            }
        }
    }

    // assume whatever is in `new` is the best view of current state, it may or may not be final
    for new_order in new.orders.iter().filter(|o| o.status == OrderStatus::Open) {
        deltas.push(OrderDelta::Create { order: *new_order });
    }

    (pubkey, deltas)
}

/// true if the order is logically the same order
fn is_same_logical_order(a: &Order, b: &Order) -> bool {
    // any field that can naturally or spuriously change should not be included here
    // e.g. `slot` is volatile, auction params, and bit_flags can change as a normal part of the order's lifecycle
    // so are not used here
    a.user_order_id == b.user_order_id
        && a.market_index == b.market_index
        && a.market_type == b.market_type
        && a.direction == b.direction
        && a.order_type == b.order_type
        && a.max_ts == b.max_ts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{MarketType, OrderTriggerCondition, OrderType, PositionDirection};

    fn create_test_order(id: u32, status: OrderStatus) -> Order {
        Order {
            slot: 0,
            price: 100,
            base_asset_amount: 1000,
            base_asset_amount_filled: 0,
            quote_asset_amount_filled: 0,
            order_id: id,
            market_index: 0,
            status,
            order_type: OrderType::Limit,
            market_type: MarketType::Perp,
            existing_position_direction: PositionDirection::Long,
            direction: PositionDirection::Long,
            reduce_only: false,
            post_only: false,
            immediate_or_cancel: false,
            trigger_condition: crate::types::OrderTriggerCondition::Above,
            ..Default::default()
        }
    }

    fn create_test_user(orders: Vec<Order>) -> User {
        let mut user = User::default();
        for (i, order) in orders.into_iter().enumerate() {
            if i < 32 {
                user.orders[i] = order;
            }
        }
        user
    }

    #[test]
    fn dlob_util_test_empty_orders() {
        let pubkey = Pubkey::new_unique();
        let old = create_test_user(vec![]);
        let new = create_test_user(vec![]);

        let (_, deltas) = compare_user_orders(pubkey, &old, &new);
        assert!(deltas.is_empty());
    }

    #[test]
    fn dlob_util_test_create_order() {
        let pubkey = Pubkey::new_unique();
        let old = create_test_user(vec![]);
        let new = create_test_user(vec![create_test_order(1, OrderStatus::Open)]);

        let (returned_pubkey, deltas) = compare_user_orders(pubkey, &old, &new);
        assert_eq!(returned_pubkey, pubkey);
        assert_eq!(deltas.len(), 1);

        match &deltas[0] {
            OrderDelta::Create { order } => {
                assert_eq!(order.order_id, 1);
            }
            _ => panic!("Expected Create delta"),
        }
    }

    #[test]
    fn dlob_util_test_remove_order() {
        let pubkey = Pubkey::new_unique();
        let old = create_test_user(vec![create_test_order(1, OrderStatus::Open)]);
        let new = create_test_user(vec![]);

        let (returned_pubkey, deltas) = compare_user_orders(pubkey, &old, &new);
        assert_eq!(returned_pubkey, pubkey);
        assert_eq!(deltas.len(), 1);

        match &deltas[0] {
            OrderDelta::Remove { order } => {
                assert_eq!(order.order_id, 1);
            }
            _ => panic!("Expected Remove delta"),
        }
    }

    #[test]
    fn dlob_util_test_remove_order_via_cancel() {
        let pubkey = Pubkey::new_unique();
        let mut order = create_test_order(1, OrderStatus::Open);
        let old = create_test_user(vec![order.clone()]);
        order.status = OrderStatus::Canceled;
        let new = create_test_user(vec![order]);

        let (returned_pubkey, deltas) = compare_user_orders(pubkey, &old, &new);
        assert_eq!(returned_pubkey, pubkey);
        assert_eq!(deltas.len(), 1);

        match &deltas[0] {
            OrderDelta::Remove { order } => {
                assert_eq!(order.order_id, 1);
            }
            _ => panic!("Expected Remove delta"),
        }
    }

    #[test]
    fn dlob_util_test_remove_order_when_trigger_condition_changes() {
        let pubkey = Pubkey::new_unique();
        let old_order = create_test_order(1, OrderStatus::Open);
        assert_eq!(old_order.trigger_condition, OrderTriggerCondition::Above);
        let old = create_test_user(vec![old_order]);

        let mut new_order = create_test_order(1, OrderStatus::Open);
        new_order.trigger_condition = OrderTriggerCondition::Below;
        let new = create_test_user(vec![new_order]);

        let (returned_pubkey, deltas) = compare_user_orders(pubkey, &old, &new);
        assert_eq!(returned_pubkey, pubkey);
        assert_eq!(
            deltas.len(),
            2,
            "expect Remove (old) + Create (new) when trigger_condition changes"
        );

        match &deltas[0] {
            OrderDelta::Remove { order } => {
                assert_eq!(order.order_id, 1);
                assert_eq!(order.trigger_condition, OrderTriggerCondition::Above);
            }
            _ => panic!("First delta should be Remove for old order"),
        }
        match &deltas[1] {
            OrderDelta::Create { order } => {
                assert_eq!(order.order_id, 1);
                assert_eq!(order.trigger_condition, OrderTriggerCondition::Below);
            }
            _ => panic!("Second delta should be Create for new order"),
        }
    }

    #[test]
    fn dlob_util_test_multiple_operations() {
        let pubkey = Pubkey::new_unique();
        let old = create_test_user(vec![
            create_test_order(1, OrderStatus::Open),
            create_test_order(2, OrderStatus::Open),
        ]);

        let mut new_order = create_test_order(1, OrderStatus::Open);
        new_order.price = 200;

        let new = create_test_user(vec![new_order, create_test_order(3, OrderStatus::Open)]);

        let (pubkey_out, deltas) = compare_user_orders(pubkey, &old, &new);
        assert_eq!(pubkey_out, pubkey);
        assert_eq!(deltas.len(), 3);
    }

    // Helper function to assert order replacement deltas
    fn assert_order_replacement_deltas(
        deltas: &[OrderDelta],
        expected_remove_id: u32,
        expected_create_id: u32,
    ) {
        assert_eq!(deltas.len(), 2);

        let mut has_remove = false;
        let mut has_create = false;

        for delta in deltas {
            match delta {
                OrderDelta::Remove { order, .. } => {
                    assert_eq!(order.order_id, expected_remove_id);
                    has_remove = true;
                }
                OrderDelta::Create { order, .. } => {
                    assert_eq!(order.order_id, expected_create_id);
                    has_create = true;
                }
            }
        }

        assert!(
            has_remove,
            "Should have Remove delta for order {}",
            expected_remove_id
        );
        assert!(
            has_create,
            "Should have Create delta for order {}",
            expected_create_id
        );
    }

    #[test]
    fn dlob_util_test_order_replacement() {
        let pubkey = Pubkey::new_unique();

        // Test basic order replacement: Order 1 (Open) → Order 2 (Open) at same index
        let old = create_test_user(vec![create_test_order(1, OrderStatus::Open)]);
        let new = create_test_user(vec![create_test_order(2, OrderStatus::Open)]);

        let (_, deltas) = compare_user_orders(pubkey, &old, &new);
        assert_order_replacement_deltas(&deltas, 1, 2);
    }

    #[test]
    fn dlob_util_test_atomic_create_and_fill() {
        let pubkey = Pubkey::new_unique();

        // Test case: Order doesn't exist in old (default/empty order), but exists in new
        // as a filled order (created and filled atomically). Should NOT emit Create+Remove.
        let old = create_test_user(vec![]); // Empty user, all slots have default Order (order_id=0, status=Init)
        let new = create_test_user(vec![create_test_order(1, OrderStatus::Filled)]); // Order created and filled atomically

        let (_, deltas) = compare_user_orders(pubkey, &old, &new);

        // Should emit NO deltas - the order was created and filled atomically, so it never
        // existed in an open state that we need to track
        assert_eq!(
            deltas.len(),
            0,
            "Should not emit deltas for atomically created and filled orders"
        );
    }

    #[test]
    fn dlob_util_test_atomic_create_and_cancel() {
        let pubkey = Pubkey::new_unique();

        // Similar test but with Canceled status
        let old = create_test_user(vec![]);
        let new = create_test_user(vec![create_test_order(1, OrderStatus::Canceled)]);

        let (_, deltas) = compare_user_orders(pubkey, &old, &new);

        assert_eq!(
            deltas.len(),
            0,
            "Should not emit deltas for atomically created and canceled orders"
        );
    }

    #[test]
    fn dlob_util_test_filled_order_replacement() {
        let pubkey = Pubkey::new_unique();

        // Test case: Old order is filled (not open), new order is also filled (different order_id)
        // This simulates: old filled order gets replaced by a new order that was created and filled atomically
        // Should NOT emit Remove+Create since neither order was ever open in the DLOB
        let old = create_test_user(vec![create_test_order(1, OrderStatus::Filled)]);
        let new = create_test_user(vec![create_test_order(2, OrderStatus::Filled)]);

        let (_, deltas) = compare_user_orders(pubkey, &old, &new);

        // Should emit NO deltas - both orders are filled, so neither was ever open in the DLOB
        assert_eq!(
            deltas.len(),
            0,
            "Should not emit Remove+Create for replacement of filled orders"
        );
    }

    #[test]
    fn dlob_util_test_canceled_order_replacement() {
        let pubkey = Pubkey::new_unique();

        // Similar test but with Canceled status
        let old = create_test_user(vec![create_test_order(1, OrderStatus::Canceled)]);
        let new = create_test_user(vec![create_test_order(2, OrderStatus::Filled)]);

        let (_, deltas) = compare_user_orders(pubkey, &old, &new);

        assert_eq!(
            deltas.len(),
            0,
            "Should not emit Remove+Create for replacement of canceled order with filled order"
        );
    }

    // Helper to create an order with specific logical properties
    fn create_logical_order(order_id: u32, user_order_id: u8, status: OrderStatus) -> Order {
        let mut order = create_test_order(order_id, status);
        order.user_order_id = user_order_id;
        order
    }

    #[test]
    fn test_scenario_1_order_id_shift() {
        // scenario 1: (old orderIds shift, not finalized)
        // old: 5 = A
        // new: 5 = B, 6 = A
        // Expected: Remove(5=A), Create(5=B), Create(6=A)
        let pubkey = Pubkey::new_unique();

        // Order A has user_order_id=1, Order B has user_order_id=2
        let order_a = create_logical_order(5, 1, OrderStatus::Open);
        let old = create_test_user(vec![order_a.clone()]);

        let order_b = create_logical_order(5, 2, OrderStatus::Open);
        let order_a_new = create_logical_order(6, 1, OrderStatus::Open);
        let new = create_test_user(vec![order_b.clone(), order_a_new.clone()]);

        let (_, deltas) = compare_user_orders(pubkey, &old, &new);

        // Should have: Remove(5=A), Create(5=B), Create(6=A)
        assert_eq!(
            deltas.len(),
            3,
            "Should have 3 deltas: Remove(5=A), Create(5=B), Create(6=A)"
        );

        let mut has_remove_5_a = false;
        let mut has_create_5_b = false;
        let mut has_create_6_a = false;

        for delta in &deltas {
            match delta {
                OrderDelta::Remove { order } => {
                    if order.order_id == 5 && order.user_order_id == 1 {
                        has_remove_5_a = true;
                    }
                }
                OrderDelta::Create { order } => {
                    if order.order_id == 5 && order.user_order_id == 2 {
                        has_create_5_b = true;
                    } else if order.order_id == 6 && order.user_order_id == 1 {
                        has_create_6_a = true;
                    }
                }
            }
        }

        assert!(
            has_remove_5_a,
            "Should have Remove for order 5 (logical order A)"
        );
        assert!(
            has_create_5_b,
            "Should have Create for order 5 (logical order B)"
        );
        assert!(
            has_create_6_a,
            "Should have Create for order 6 (logical order A)"
        );
    }

    #[test]
    fn test_scenario_2_status_change() {
        // scenario 2: (old orderId status change not finalized)
        // old: 4 = Filled
        // new: 4 = Open
        // Expected: Create(4=Open)
        let pubkey = Pubkey::new_unique();

        let order_filled = create_logical_order(4, 1, OrderStatus::Filled);
        let old = create_test_user(vec![order_filled]);

        let order_open = create_logical_order(4, 1, OrderStatus::Open);
        let new = create_test_user(vec![order_open.clone()]);

        let (_, deltas) = compare_user_orders(pubkey, &old, &new);

        // Should have: Create(4=Open)
        // Note: The old order is Filled (not Open), so it's filtered out in the second loop
        // The new order is Open, so it gets a Create delta
        assert_eq!(deltas.len(), 1, "Should have 1 delta: Create(4=Open)");

        match &deltas[0] {
            OrderDelta::Create { order } => {
                assert_eq!(order.order_id, 4);
                assert_eq!(order.user_order_id, 1);
                assert_eq!(order.status, OrderStatus::Open);
            }
            _ => panic!("Expected Create delta for order 4"),
        }
    }

    #[test]
    fn test_scenario_3_order_id_removed() {
        // scenario 3: (old orderId created not finalized)
        // old: 4 = A (Open)
        // new: *4 not assigned* (or default/Init order)
        // Expected: Remove(4=A)
        let pubkey = Pubkey::new_unique();

        let order_a = create_logical_order(4, 1, OrderStatus::Open);
        let old = create_test_user(vec![order_a.clone()]);

        // New user has no order at index 0 (or has default order with order_id=0)
        let new = create_test_user(vec![]);

        let (_, deltas) = compare_user_orders(pubkey, &old, &new);

        // Should have: Remove(4=A)
        assert_eq!(deltas.len(), 1, "Should have 1 delta: Remove(4=A)");

        match &deltas[0] {
            OrderDelta::Remove { order } => {
                assert_eq!(order.order_id, 4);
                assert_eq!(order.user_order_id, 1);
            }
            _ => panic!("Expected Remove delta for order 4"),
        }
    }
}
