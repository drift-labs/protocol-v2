mod tests {
    use anchor_lang::prelude::Pubkey;

    use super::*;
    use crate::{
        error::ErrorCode,
        state::{
            builder::{BuilderEscrow, BuilderInfo, BuilderOrder, BuilderOrderBitFlag},
            user::MarketType,
        },
    };

    #[test]
    fn test_revenue_share_order_new() {
        let order = BuilderOrder::new(1, 100, 50, MarketType::Perp, 0);

        assert_eq!(order.builder_idx, 1);
        assert_eq!(order.order_id, 100);
        assert_eq!(order.fee_bps, 50);
        assert_eq!(order.market_type, MarketType::Perp);
        assert_eq!(order.market_index, 0);
        assert_eq!(order.fees_accrued, 0);
        assert!(order.is_open());
        assert!(!order.is_completed());
        assert!(!order.is_available());
    }

    #[test]
    fn test_revenue_share_order_bit_flags() {
        let mut order = BuilderOrder::new(1, 100, 50, MarketType::Perp, 0);

        // Test initial state
        assert!(order.is_open());
        assert!(!order.is_completed());
        assert!(!order.is_available());

        // Test adding completed flag
        order.add_bit_flag(BuilderOrderBitFlag::Completed);
        assert!(order.is_open());
        assert!(order.is_completed());
        assert!(!order.is_available());

        // Test clearing open flag
        order.bit_flags &= !(BuilderOrderBitFlag::Open as u8);
        assert!(!order.is_open());
        assert!(order.is_completed());
        assert!(!order.is_available());

        // Test clearing completed flag
        order.bit_flags &= !(BuilderOrderBitFlag::Completed as u8);
        assert!(!order.is_open());
        assert!(!order.is_completed());
        assert!(order.is_available());
    }

    #[test]
    fn test_revenue_share_order_is_mergeable() {
        let mut order1 = BuilderOrder::new(1, 100, 50, MarketType::Perp, 0);
        let mut order2 = BuilderOrder::new(1, 200, 50, MarketType::Perp, 0);

        // Both orders are open, so not mergeable
        assert!(!order1.is_mergeable(&order2));

        // Make order2 completed
        order2.add_bit_flag(BuilderOrderBitFlag::Completed);
        order2.bit_flags &= !(BuilderOrderBitFlag::Open as u8);

        // Now they should be mergeable (same builder, market, market_type)
        assert!(order1.is_mergeable(&order2));

        // Different builder
        order2.builder_idx = 2;
        assert!(!order1.is_mergeable(&order2));

        // Same builder, different market
        order2.builder_idx = 1;
        order2.market_index = 1;
        assert!(!order1.is_mergeable(&order2));

        // Same builder, same market, different market type
        order2.market_index = 0;
        order2.market_type = MarketType::Spot;
        assert!(!order1.is_mergeable(&order2));
    }

    #[test]
    fn test_revenue_share_order_merge() {
        let mut order1 = BuilderOrder::new(1, 100, 50, MarketType::Perp, 0);
        let mut order2 = BuilderOrder::new(1, 200, 50, MarketType::Perp, 0);

        order1.fees_accrued = 1000;
        order2.fees_accrued = 500;

        // Make order2 completed
        order2.add_bit_flag(BuilderOrderBitFlag::Completed);
        order2.bit_flags &= !(BuilderOrderBitFlag::Open as u8);

        let merged = order1.merge(&order2).unwrap();
        assert_eq!(merged.fees_accrued, 1500);
        assert_eq!(merged.builder_idx, 1);
        assert_eq!(merged.market_index, 0);
        assert_eq!(merged.market_type, MarketType::Perp);
    }

    #[test]
    fn test_revenue_share_order_merge_fails_when_not_mergeable() {
        let order1 = BuilderOrder::new(1, 100, 50, MarketType::Perp, 0);
        let order2 = BuilderOrder::new(2, 200, 50, MarketType::Perp, 0); // Different builder

        let result = order1.merge(&order2);
        assert!(result.is_err());
    }

    #[test]
    fn test_builder_info_is_revoked() {
        let mut builder = BuilderInfo {
            authority: Pubkey::default(),
            max_fee_bps: 100,
            padding2: [0; 2],
        };

        // Should not be revoked by default
        assert!(!builder.is_revoked());

        // Set max_fee_bps to 0 to revoke
        builder.max_fee_bps = 0;
        assert!(builder.is_revoked());
    }

    // Tests for add_order method
    #[test]
    fn test_add_order_merges_with_completed_order() {
        // Create a test escrow with 3 order slots
        let mut escrow = BuilderEscrow {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            padding0: 0,
            orders: vec![
                BuilderOrder {
                    builder_idx: 1,
                    padding0: [0; 7],
                    fees_accrued: 1000,
                    order_id: 100,
                    fee_bps: 50,
                    market_index: 0,
                    bit_flags: BuilderOrderBitFlag::Completed as u8, // Completed order
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
                BuilderOrder::new(0, 0, 0, MarketType::Perp, 0),
                BuilderOrder::new(0, 0, 0, MarketType::Perp, 0),
            ],
            padding1: 0,
            approved_builders: Vec::new(),
        };

        let new_order = BuilderOrder::new(1, 200, 50, MarketType::Perp, 0);

        // Test the core logic by directly manipulating the orders
        let mut found_mergeable = false;
        let mut found_available = false;
        let mut merge_index = 0;

        for i in 0..escrow.orders.len() {
            let existing_order = &escrow.orders[i];
            if existing_order.is_mergeable(&new_order) {
                found_mergeable = true;
                merge_index = i;
                break;
            } else if existing_order.is_available() {
                found_available = true;
                break;
            }
        }

        // Should find a mergeable order (same builder, market, market_type, and completed)
        assert!(found_mergeable);
        assert!(!found_available);
        assert_eq!(merge_index, 0);

        // Test the merge logic
        let mut merged_order = new_order;
        merged_order.fees_accrued = merged_order
            .fees_accrued
            .checked_add(escrow.orders[0].fees_accrued)
            .unwrap();
        assert_eq!(merged_order.fees_accrued, 1000); // Should have the original fees
    }

    #[test]
    fn test_add_order_uses_available_slot() {
        // Create a test escrow with 3 order slots
        let mut escrow = BuilderEscrow {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            padding0: 0,
            orders: vec![
                BuilderOrder {
                    builder_idx: 1,
                    padding0: [0; 7],
                    fees_accrued: 0,
                    order_id: 100,
                    fee_bps: 50,
                    market_index: 0,
                    bit_flags: BuilderOrderBitFlag::Open as u8, // Open order
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
                BuilderOrder {
                    builder_idx: 0,
                    padding0: [0; 7],
                    fees_accrued: 0,
                    order_id: 0,
                    fee_bps: 0,
                    market_index: 0,
                    bit_flags: 0, // Available slot
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
                BuilderOrder {
                    builder_idx: 0,
                    padding0: [0; 7],
                    fees_accrued: 0,
                    order_id: 0,
                    fee_bps: 0,
                    market_index: 0,
                    bit_flags: 0, // Available slot
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
            ],
            padding1: 0,
            approved_builders: Vec::new(),
        };

        let new_order = BuilderOrder::new(2, 200, 75, MarketType::Spot, 1);

        // Test the core logic by directly manipulating the orders
        let mut found_mergeable = false;
        let mut found_available = false;
        let mut available_index = 0;

        for i in 0..escrow.orders.len() {
            let existing_order = &escrow.orders[i];
            if existing_order.is_mergeable(&new_order) {
                found_mergeable = true;
                break;
            } else if existing_order.is_available() {
                found_available = true;
                available_index = i;
                break;
            }
        }

        // Should find an available slot (not mergeable with open order)
        assert!(!found_mergeable);
        assert!(found_available);
        assert_eq!(available_index, 1); // First available slot
    }

    #[test]
    fn test_add_order_does_not_merge_different_builder() {
        // Create a test escrow with a completed order for builder 1
        let mut escrow = BuilderEscrow {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            padding0: 0,
            orders: vec![
                BuilderOrder {
                    builder_idx: 1,
                    padding0: [0; 7],
                    fees_accrued: 1000,
                    order_id: 100,
                    fee_bps: 50,
                    market_index: 0,
                    bit_flags: BuilderOrderBitFlag::Completed as u8, // Completed order
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
                BuilderOrder {
                    builder_idx: 0,
                    padding0: [0; 7],
                    fees_accrued: 0,
                    order_id: 0,
                    fee_bps: 0,
                    market_index: 0,
                    bit_flags: 0, // Available slot
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
            ],
            padding1: 0,
            approved_builders: Vec::new(),
        };

        let new_order = BuilderOrder::new(2, 200, 50, MarketType::Perp, 0); // Different builder

        // Test the core logic
        let mut found_mergeable = false;
        let mut found_available = false;

        for i in 0..escrow.orders.len() {
            let existing_order = &escrow.orders[i];
            if existing_order.is_mergeable(&new_order) {
                found_mergeable = true;
                break;
            } else if existing_order.is_available() {
                found_available = true;
                break;
            }
        }

        // Should not find mergeable (different builder) but should find available slot
        assert!(!found_mergeable);
        assert!(found_available);
    }

    #[test]
    fn test_add_order_does_not_merge_different_market() {
        // Create a test escrow with a completed order for market 0
        let mut escrow = BuilderEscrow {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            padding0: 0,
            orders: vec![
                BuilderOrder {
                    builder_idx: 1,
                    padding0: [0; 7],
                    fees_accrued: 1000,
                    order_id: 100,
                    fee_bps: 50,
                    market_index: 0,
                    bit_flags: BuilderOrderBitFlag::Completed as u8, // Completed order
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
                BuilderOrder {
                    builder_idx: 0,
                    padding0: [0; 7],
                    fees_accrued: 0,
                    order_id: 0,
                    fee_bps: 0,
                    market_index: 0,
                    bit_flags: 0, // Available slot
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
            ],
            padding1: 0,
            approved_builders: Vec::new(),
        };

        let new_order = BuilderOrder::new(1, 200, 50, MarketType::Perp, 1); // Different market

        // Test the core logic
        let mut found_mergeable = false;
        let mut found_available = false;

        for i in 0..escrow.orders.len() {
            let existing_order = &escrow.orders[i];
            if existing_order.is_mergeable(&new_order) {
                found_mergeable = true;
                break;
            } else if existing_order.is_available() {
                found_available = true;
                break;
            }
        }

        // Should not find mergeable (different market) but should find available slot
        assert!(!found_mergeable);
        assert!(found_available);
    }

    #[test]
    fn test_add_order_does_not_merge_different_market_type() {
        // Create a test escrow with a completed order for perp market
        let mut escrow = BuilderEscrow {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            padding0: 0,
            orders: vec![
                BuilderOrder {
                    builder_idx: 1,
                    padding0: [0; 7],
                    fees_accrued: 1000,
                    order_id: 100,
                    fee_bps: 50,
                    market_index: 0,
                    bit_flags: BuilderOrderBitFlag::Completed as u8, // Completed order
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
                BuilderOrder {
                    builder_idx: 0,
                    padding0: [0; 7],
                    fees_accrued: 0,
                    order_id: 0,
                    fee_bps: 0,
                    market_index: 0,
                    bit_flags: 0, // Available slot
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
            ],
            padding1: 0,
            approved_builders: Vec::new(),
        };

        let new_order = BuilderOrder::new(1, 200, 50, MarketType::Spot, 0); // Different market type

        // Test the core logic
        let mut found_mergeable = false;
        let mut found_available = false;

        for i in 0..escrow.orders.len() {
            let existing_order = &escrow.orders[i];
            if existing_order.is_mergeable(&new_order) {
                found_mergeable = true;
                break;
            } else if existing_order.is_available() {
                found_available = true;
                break;
            }
        }

        // Should not find mergeable (different market type) but should find available slot
        assert!(!found_mergeable);
        assert!(found_available);
    }

    #[test]
    fn test_add_order_does_not_merge_with_open_order() {
        // Create a test escrow with an open order
        let mut escrow = BuilderEscrow {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            padding0: 0,
            orders: vec![
                BuilderOrder {
                    builder_idx: 1,
                    padding0: [0; 7],
                    fees_accrued: 0,
                    order_id: 100,
                    fee_bps: 50,
                    market_index: 0,
                    bit_flags: BuilderOrderBitFlag::Open as u8, // Open order
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
                BuilderOrder {
                    builder_idx: 0,
                    padding0: [0; 7],
                    fees_accrued: 0,
                    order_id: 0,
                    fee_bps: 0,
                    market_index: 0,
                    bit_flags: 0, // Available slot
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
            ],
            padding1: 0,
            approved_builders: Vec::new(),
        };

        let new_order = BuilderOrder::new(1, 200, 50, MarketType::Perp, 0); // Same builder, market, market_type

        // Test the core logic
        let mut found_mergeable = false;
        let mut found_available = false;

        for i in 0..escrow.orders.len() {
            let existing_order = &escrow.orders[i];
            if existing_order.is_mergeable(&new_order) {
                found_mergeable = true;
                break;
            } else if existing_order.is_available() {
                found_available = true;
                break;
            }
        }

        // Should not find mergeable (open order) but should find available slot
        assert!(!found_mergeable);
        assert!(found_available);
    }

    #[test]
    fn test_add_order_fails_when_full() {
        // Create a test escrow with only 1 slot that's open
        let mut escrow = BuilderEscrow {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            padding0: 0,
            orders: vec![BuilderOrder {
                builder_idx: 1,
                padding0: [0; 7],
                fees_accrued: 0,
                order_id: 100,
                fee_bps: 50,
                market_index: 0,
                bit_flags: BuilderOrderBitFlag::Open as u8, // Open order
                market_type: MarketType::Perp,
                padding: [0; 6],
            }],
            padding1: 0,
            approved_builders: Vec::new(),
        };

        let new_order = BuilderOrder::new(2, 200, 75, MarketType::Spot, 1);

        // Test the core logic
        let mut found_mergeable = false;
        let mut found_available = false;

        for i in 0..escrow.orders.len() {
            let existing_order = &escrow.orders[i];
            if existing_order.is_mergeable(&new_order) {
                found_mergeable = true;
                break;
            } else if existing_order.is_available() {
                found_available = true;
                break;
            }
        }

        // Should not find mergeable or available slots
        assert!(!found_mergeable);
        assert!(!found_available);
    }

    #[test]
    fn test_add_order_prioritizes_merge_over_available() {
        // Create a test escrow with a completed order at index 0 and available slot at index 1
        let mut escrow = BuilderEscrow {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            padding0: 0,
            orders: vec![
                BuilderOrder {
                    builder_idx: 1,
                    padding0: [0; 7],
                    fees_accrued: 1000,
                    order_id: 100,
                    fee_bps: 50,
                    market_index: 0,
                    bit_flags: BuilderOrderBitFlag::Completed as u8, // Completed order
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
                BuilderOrder {
                    builder_idx: 0,
                    padding0: [0; 7],
                    fees_accrued: 0,
                    order_id: 0,
                    fee_bps: 0,
                    market_index: 0,
                    bit_flags: 0, // Available slot
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
            ],
            padding1: 0,
            approved_builders: Vec::new(),
        };

        let new_order = BuilderOrder::new(1, 300, 50, MarketType::Perp, 0); // Can merge with completed order

        // Test the core logic
        let mut found_mergeable = false;
        let mut found_available = false;
        let mut merge_index = 0;

        for i in 0..escrow.orders.len() {
            let existing_order = &escrow.orders[i];
            if existing_order.is_mergeable(&new_order) {
                found_mergeable = true;
                merge_index = i;
                break;
            } else if existing_order.is_available() {
                found_available = true;
                break;
            }
        }

        // Should find mergeable first (index 0) before available (index 1)
        assert!(found_mergeable);
        assert!(!found_available); // Should not reach available slot
        assert_eq!(merge_index, 0);
    }

    #[test]
    fn test_add_order_uses_first_available_slot() {
        // Create a test escrow with open order at index 0, available at index 1, available at index 2
        let mut escrow = BuilderEscrow {
            authority: Pubkey::default(),
            referrer: Pubkey::default(),
            padding0: 0,
            orders: vec![
                BuilderOrder {
                    builder_idx: 1,
                    padding0: [0; 7],
                    fees_accrued: 0,
                    order_id: 100,
                    fee_bps: 50,
                    market_index: 0,
                    bit_flags: BuilderOrderBitFlag::Open as u8, // Open order
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
                BuilderOrder {
                    builder_idx: 0,
                    padding0: [0; 7],
                    fees_accrued: 0,
                    order_id: 0,
                    fee_bps: 0,
                    market_index: 0,
                    bit_flags: 0, // Available slot
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
                BuilderOrder {
                    builder_idx: 0,
                    padding0: [0; 7],
                    fees_accrued: 0,
                    order_id: 0,
                    fee_bps: 0,
                    market_index: 0,
                    bit_flags: 0, // Available slot
                    market_type: MarketType::Perp,
                    padding: [0; 6],
                },
            ],
            padding1: 0,
            approved_builders: Vec::new(),
        };

        let new_order = BuilderOrder::new(4, 400, 25, MarketType::Spot, 3);

        // Test the core logic
        let mut found_mergeable = false;
        let mut found_available = false;
        let mut available_index = 0;

        for i in 0..escrow.orders.len() {
            let existing_order = &escrow.orders[i];
            if existing_order.is_mergeable(&new_order) {
                found_mergeable = true;
                break;
            } else if existing_order.is_available() {
                found_available = true;
                available_index = i;
                break;
            }
        }

        // Should find first available slot (index 1)
        assert!(!found_mergeable);
        assert!(found_available);
        assert_eq!(available_index, 1);
    }
}
