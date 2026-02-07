use crate::state::order_params::PostOnlyParam;
use crate::state::scale_order_params::{ScaleOrderParams, SizeDistribution};
use crate::state::user::MarketType;
use crate::{PositionDirection, BASE_PRECISION_U64, PRICE_PRECISION_U64};

#[test]
fn test_validate_order_count_bounds() {
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    // Test minimum order count
    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
        market_type: MarketType::Perp,
        direction: PositionDirection::Long,
        market_index: 0,
        total_base_asset_amount: BASE_PRECISION_U64,
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        order_count: 1, // Below minimum
        size_distribution: SizeDistribution::Flat,
        reduce_only: false,
        post_only: PostOnlyParam::None,
        bit_flags: 0,
        max_ts: None,
    };
    assert!(params.validate(step_size).is_err());

    // Test maximum order count
    let params = ScaleOrderParams {
        order_count: 33, // Above maximum (MAX_OPEN_ORDERS = 32)
        ..params
    };
    assert!(params.validate(step_size).is_err());

    // Test valid order count
    let params = ScaleOrderParams {
        order_count: 5,
        ..params
    };
    assert!(params.validate(step_size).is_ok());
}

#[test]
fn test_validate_price_range() {
    let step_size = BASE_PRECISION_U64 / 1000;

    // Long orders: start_price must be > end_price (scaling down)
    let params = ScaleOrderParams {
        market_type: MarketType::Perp,
        direction: PositionDirection::Long,
        market_index: 0,
        total_base_asset_amount: BASE_PRECISION_U64,
        start_price: 100 * PRICE_PRECISION_U64, // Wrong: lower than end
        end_price: 110 * PRICE_PRECISION_U64,
        order_count: 5,
        size_distribution: SizeDistribution::Flat,
        reduce_only: false,
        post_only: PostOnlyParam::None,
        bit_flags: 0,
        max_ts: None,
    };
    assert!(params.validate(step_size).is_err());

    // Short orders: start_price must be < end_price (scaling up)
    let params = ScaleOrderParams {
        direction: PositionDirection::Short,
        start_price: 110 * PRICE_PRECISION_U64, // Wrong: higher than end
        end_price: 100 * PRICE_PRECISION_U64,
        ..params
    };
    assert!(params.validate(step_size).is_err());

    // Valid long order (start high, end low - DCA down)
    let params = ScaleOrderParams {
        direction: PositionDirection::Long,
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        ..params
    };
    assert!(params.validate(step_size).is_ok());

    // Valid short order (start low, end high - scale out up)
    let params = ScaleOrderParams {
        direction: PositionDirection::Short,
        start_price: 100 * PRICE_PRECISION_U64,
        end_price: 110 * PRICE_PRECISION_U64,
        ..params
    };
    assert!(params.validate(step_size).is_ok());
}

#[test]
fn test_price_distribution_long() {
    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
        market_type: MarketType::Perp,
        direction: PositionDirection::Long,
        market_index: 0,
        total_base_asset_amount: BASE_PRECISION_U64,
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        order_count: 5,
        size_distribution: SizeDistribution::Flat,
        reduce_only: false,
        post_only: PostOnlyParam::None,
        bit_flags: 0,
        max_ts: None,
    };

    let prices = params.calculate_price_distribution().unwrap();
    assert_eq!(prices.len(), 5);
    assert_eq!(prices[0], 110 * PRICE_PRECISION_U64);
    assert_eq!(prices[1], 107500000); // 107.5
    assert_eq!(prices[2], 105 * PRICE_PRECISION_U64);
    assert_eq!(prices[3], 102500000); // 102.5
    assert_eq!(prices[4], 100 * PRICE_PRECISION_U64);
}

#[test]
fn test_price_distribution_short() {
    // Short: start low, end high (scale out up)
    let params = ScaleOrderParams {
        market_type: MarketType::Perp,
        direction: PositionDirection::Short,
        market_index: 0,
        total_base_asset_amount: BASE_PRECISION_U64,
        start_price: 100 * PRICE_PRECISION_U64,
        end_price: 110 * PRICE_PRECISION_U64,
        order_count: 5,
        size_distribution: SizeDistribution::Flat,
        reduce_only: false,
        post_only: PostOnlyParam::None,
        bit_flags: 0,
        max_ts: None,
    };

    let prices = params.calculate_price_distribution().unwrap();
    assert_eq!(prices.len(), 5);
    assert_eq!(prices[0], 100 * PRICE_PRECISION_U64);
    assert_eq!(prices[1], 102500000); // 102.5
    assert_eq!(prices[2], 105 * PRICE_PRECISION_U64);
    assert_eq!(prices[3], 107500000); // 107.5
    assert_eq!(prices[4], 110 * PRICE_PRECISION_U64);
}

#[test]
fn test_flat_size_distribution() {
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
        market_type: MarketType::Perp,
        direction: PositionDirection::Long,
        market_index: 0,
        total_base_asset_amount: BASE_PRECISION_U64, // 1.0
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        order_count: 5,
        size_distribution: SizeDistribution::Flat,
        reduce_only: false,
        post_only: PostOnlyParam::None,
        bit_flags: 0,
        max_ts: None,
    };

    let sizes = params.calculate_size_distribution(step_size).unwrap();
    assert_eq!(sizes.len(), 5);

    // Total must equal the requested amount
    let total: u64 = sizes.iter().sum();
    assert_eq!(total, BASE_PRECISION_U64);

    // Flat distribution: each order should be 1/5 = 20% of total
    // Expected: 200_000_000 each (0.2 BASE)
    // First 4 orders are exactly 0.2, last order gets any remainder
    assert_eq!(sizes[0], 200_000_000); // 20%
    assert_eq!(sizes[1], 200_000_000); // 20%
    assert_eq!(sizes[2], 200_000_000); // 20%
    assert_eq!(sizes[3], 200_000_000); // 20%
    assert_eq!(sizes[4], 200_000_000); // 20% (remainder goes here if any)

    // Verify each order is exactly 20% of total
    for size in &sizes {
        let pct = (*size as f64) / (BASE_PRECISION_U64 as f64) * 100.0;
        assert!((pct - 20.0).abs() < 0.1, "Expected ~20%, got {}%", pct);
    }
}

#[test]
fn test_ascending_size_distribution() {
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
        market_type: MarketType::Perp,
        direction: PositionDirection::Long,
        market_index: 0,
        total_base_asset_amount: BASE_PRECISION_U64, // 1.0
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        order_count: 5,
        size_distribution: SizeDistribution::Ascending,
        reduce_only: false,
        post_only: PostOnlyParam::None,
        bit_flags: 0,
        max_ts: None,
    };

    let sizes = params.calculate_size_distribution(step_size).unwrap();
    assert_eq!(sizes.len(), 5);

    // Total must equal the requested amount
    let total: u64 = sizes.iter().sum();
    assert_eq!(total, BASE_PRECISION_U64);

    // Ascending distribution uses multipliers: 1x, 1.5x, 2x, 2.5x, 3x
    // Scaled by 2 for precision: 2, 3, 4, 5, 6 (sum = 20)
    // Expected proportions: 10%, 15%, 20%, 25%, 30%
    // For 1_000_000_000 total: 100M, 150M, 200M, 250M, 300M
    assert_eq!(sizes[0], 100_000_000); // 10% - smallest
    assert_eq!(sizes[1], 150_000_000); // 15%
    assert_eq!(sizes[2], 200_000_000); // 20%
    assert_eq!(sizes[3], 250_000_000); // 25%
    assert_eq!(sizes[4], 300_000_000); // 30% - largest

    // Verify ascending order: each subsequent order is larger
    assert!(sizes[0] < sizes[1]);
    assert!(sizes[1] < sizes[2]);
    assert!(sizes[2] < sizes[3]);
    assert!(sizes[3] < sizes[4]);

    // Verify the proportions are correct (within 1% tolerance for rounding)
    let expected_pcts = [10.0, 15.0, 20.0, 25.0, 30.0];
    for (i, (size, expected_pct)) in sizes.iter().zip(expected_pcts.iter()).enumerate() {
        let actual_pct = (*size as f64) / (BASE_PRECISION_U64 as f64) * 100.0;
        assert!(
            (actual_pct - expected_pct).abs() < 1.0,
            "Order {}: expected ~{}%, got {}%",
            i,
            expected_pct,
            actual_pct
        );
    }
}

#[test]
fn test_descending_size_distribution() {
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
        market_type: MarketType::Perp,
        direction: PositionDirection::Long,
        market_index: 0,
        total_base_asset_amount: BASE_PRECISION_U64, // 1.0
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        order_count: 5,
        size_distribution: SizeDistribution::Descending,
        reduce_only: false,
        post_only: PostOnlyParam::None,
        bit_flags: 0,
        max_ts: None,
    };

    let sizes = params.calculate_size_distribution(step_size).unwrap();
    assert_eq!(sizes.len(), 5);

    // Total must equal the requested amount
    let total: u64 = sizes.iter().sum();
    assert_eq!(total, BASE_PRECISION_U64);

    // Descending distribution is reverse of ascending
    // Multipliers (reversed): 3x, 2.5x, 2x, 1.5x, 1x
    // Expected proportions: 30%, 25%, 20%, 15%, 10%
    // For 1_000_000_000 total: 300M, 250M, 200M, 150M, 100M
    assert_eq!(sizes[0], 300_000_000); // 30% - largest
    assert_eq!(sizes[1], 250_000_000); // 25%
    assert_eq!(sizes[2], 200_000_000); // 20%
    assert_eq!(sizes[3], 150_000_000); // 15%
    assert_eq!(sizes[4], 100_000_000); // 10% - smallest

    // Verify descending order: each subsequent order is smaller
    assert!(sizes[0] > sizes[1]);
    assert!(sizes[1] > sizes[2]);
    assert!(sizes[2] > sizes[3]);
    assert!(sizes[3] > sizes[4]);

    // Verify the proportions are correct (within 1% tolerance for rounding)
    let expected_pcts = [30.0, 25.0, 20.0, 15.0, 10.0];
    for (i, (size, expected_pct)) in sizes.iter().zip(expected_pcts.iter()).enumerate() {
        let actual_pct = (*size as f64) / (BASE_PRECISION_U64 as f64) * 100.0;
        assert!(
            (actual_pct - expected_pct).abs() < 1.0,
            "Order {}: expected ~{}%, got {}%",
            i,
            expected_pct,
            actual_pct
        );
    }
}

#[test]
fn test_ascending_size_distribution_3_orders() {
    // Test with different order count to verify formula works correctly
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    let params = ScaleOrderParams {
        market_type: MarketType::Perp,
        direction: PositionDirection::Long,
        market_index: 0,
        total_base_asset_amount: BASE_PRECISION_U64, // 1.0
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        order_count: 3,
        size_distribution: SizeDistribution::Ascending,
        reduce_only: false,
        post_only: PostOnlyParam::None,
        bit_flags: 0,
        max_ts: None,
    };

    let sizes = params.calculate_size_distribution(step_size).unwrap();
    assert_eq!(sizes.len(), 3);

    // Total must equal the requested amount
    let total: u64 = sizes.iter().sum();
    assert_eq!(total, BASE_PRECISION_U64);

    // For 3 orders: multiplier_sum = n*(n+3)/2 = 3*6/2 = 9
    // Multipliers (scaled by 2): 2, 3, 4
    // Expected proportions: 2/9 ≈ 22.2%, 3/9 ≈ 33.3%, 4/9 ≈ 44.4%
    let expected_pcts = [22.22, 33.33, 44.44];
    for (i, (size, expected_pct)) in sizes.iter().zip(expected_pcts.iter()).enumerate() {
        let actual_pct = (*size as f64) / (BASE_PRECISION_U64 as f64) * 100.0;
        assert!(
            (actual_pct - expected_pct).abs() < 1.0,
            "Order {}: expected ~{}%, got {}%",
            i,
            expected_pct,
            actual_pct
        );
    }

    // Verify ascending order
    assert!(sizes[0] < sizes[1]);
    assert!(sizes[1] < sizes[2]);
}

#[test]
fn test_flat_distribution_with_remainder() {
    // Test flat distribution where total doesn't divide evenly
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    let params = ScaleOrderParams {
        market_type: MarketType::Perp,
        direction: PositionDirection::Long,
        market_index: 0,
        total_base_asset_amount: BASE_PRECISION_U64, // 1.0
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        order_count: 3, // 1.0 / 3 doesn't divide evenly
        size_distribution: SizeDistribution::Flat,
        reduce_only: false,
        post_only: PostOnlyParam::None,
        bit_flags: 0,
        max_ts: None,
    };

    let sizes = params.calculate_size_distribution(step_size).unwrap();
    assert_eq!(sizes.len(), 3);

    // Total must still equal exactly the requested amount
    let total: u64 = sizes.iter().sum();
    assert_eq!(total, BASE_PRECISION_U64);

    // Each order should be ~33.3%, with remainder going to last order
    // step_size = 1_000_000 (0.001)
    // base_size = 1_000_000_000 / 3 = 333_333_333
    // rounded_size = (333_333_333 / 1_000_000) * 1_000_000 = 333_000_000
    // First two orders: 333_000_000 each
    // Last order: 1_000_000_000 - 2*333_000_000 = 334_000_000
    assert_eq!(sizes[0], 333_000_000);
    assert_eq!(sizes[1], 333_000_000);
    assert_eq!(sizes[2], 334_000_000); // Gets the remainder
}

#[test]
fn test_expand_to_order_params_perp() {
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
        market_type: MarketType::Perp,
        direction: PositionDirection::Long,
        market_index: 1,
        total_base_asset_amount: BASE_PRECISION_U64, // 1.0
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        order_count: 3,
        size_distribution: SizeDistribution::Flat,
        reduce_only: true,
        post_only: PostOnlyParam::MustPostOnly,
        bit_flags: 2, // High leverage mode
        max_ts: Some(12345),
    };

    let order_params = params.expand_to_order_params(step_size).unwrap();
    assert_eq!(order_params.len(), 3);

    // Check first order has bit flags
    assert_eq!(order_params[0].bit_flags, 2);
    // Other orders should have 0 bit flags
    assert_eq!(order_params[1].bit_flags, 0);
    assert_eq!(order_params[2].bit_flags, 0);

    // Check common properties
    for op in &order_params {
        assert_eq!(op.market_type, MarketType::Perp);
        assert_eq!(op.market_index, 1);
        assert_eq!(op.reduce_only, true);
        assert_eq!(op.post_only, PostOnlyParam::MustPostOnly);
        assert_eq!(op.max_ts, Some(12345));
        assert!(matches!(op.direction, PositionDirection::Long));
    }

    // Check prices are distributed (high to low for long)
    assert_eq!(order_params[0].price, 110 * PRICE_PRECISION_U64);
    assert_eq!(order_params[1].price, 105 * PRICE_PRECISION_U64);
    assert_eq!(order_params[2].price, 100 * PRICE_PRECISION_U64);

    // Check total size
    let total: u64 = order_params.iter().map(|op| op.base_asset_amount).sum();
    assert_eq!(total, BASE_PRECISION_U64);
}

#[test]
fn test_expand_to_order_params_spot() {
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    // Spot Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
        market_type: MarketType::Spot,
        direction: PositionDirection::Long,
        market_index: 1, // SOL spot market
        total_base_asset_amount: BASE_PRECISION_U64, // 1.0
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        order_count: 3,
        size_distribution: SizeDistribution::Flat,
        reduce_only: false,
        post_only: PostOnlyParam::None,
        bit_flags: 0,
        max_ts: None,
    };

    let order_params = params.expand_to_order_params(step_size).unwrap();
    assert_eq!(order_params.len(), 3);

    // Check all orders are Spot market type
    for op in &order_params {
        assert_eq!(op.market_type, MarketType::Spot);
        assert_eq!(op.market_index, 1);
        assert!(matches!(op.direction, PositionDirection::Long));
    }

    // Check prices are distributed (high to low for long)
    assert_eq!(order_params[0].price, 110 * PRICE_PRECISION_U64);
    assert_eq!(order_params[1].price, 105 * PRICE_PRECISION_U64);
    assert_eq!(order_params[2].price, 100 * PRICE_PRECISION_U64);

    // Check total size
    let total: u64 = order_params.iter().map(|op| op.base_asset_amount).sum();
    assert_eq!(total, BASE_PRECISION_U64);
}

#[test]
fn test_spot_short_scale_orders() {
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    // Spot Short: start low, end high (scale out up)
    let params = ScaleOrderParams {
        market_type: MarketType::Spot,
        direction: PositionDirection::Short,
        market_index: 1, // SOL spot market
        total_base_asset_amount: BASE_PRECISION_U64, // 1.0
        start_price: 100 * PRICE_PRECISION_U64,
        end_price: 110 * PRICE_PRECISION_U64,
        order_count: 4,
        size_distribution: SizeDistribution::Ascending,
        reduce_only: false,
        post_only: PostOnlyParam::MustPostOnly,
        bit_flags: 0,
        max_ts: Some(99999),
    };

    let order_params = params.expand_to_order_params(step_size).unwrap();
    assert_eq!(order_params.len(), 4);

    // Check all orders are Spot market type and Short direction
    for op in &order_params {
        assert_eq!(op.market_type, MarketType::Spot);
        assert_eq!(op.market_index, 1);
        assert!(matches!(op.direction, PositionDirection::Short));
        assert_eq!(op.post_only, PostOnlyParam::MustPostOnly);
        assert_eq!(op.max_ts, Some(99999));
    }

    // Check prices are distributed (low to high for short)
    assert_eq!(order_params[0].price, 100 * PRICE_PRECISION_U64);
    // Middle prices
    assert_eq!(order_params[3].price, 110 * PRICE_PRECISION_U64);

    // Ascending: sizes should increase
    assert!(order_params[0].base_asset_amount < order_params[3].base_asset_amount);

    // Check total size
    let total: u64 = order_params.iter().map(|op| op.base_asset_amount).sum();
    assert_eq!(total, BASE_PRECISION_U64);
}

#[test]
fn test_two_orders_price_distribution() {
    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
        market_type: MarketType::Perp,
        direction: PositionDirection::Long,
        market_index: 0,
        total_base_asset_amount: BASE_PRECISION_U64,
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        order_count: 2,
        size_distribution: SizeDistribution::Flat,
        reduce_only: false,
        post_only: PostOnlyParam::None,
        bit_flags: 0,
        max_ts: None,
    };

    let prices = params.calculate_price_distribution().unwrap();
    assert_eq!(prices.len(), 2);
    assert_eq!(prices[0], 110 * PRICE_PRECISION_U64);
    assert_eq!(prices[1], 100 * PRICE_PRECISION_U64);
}

#[test]
fn test_validate_min_total_size() {
    let step_size = BASE_PRECISION_U64 / 10; // 0.1

    // Total size is too small for 5 orders with this step size
    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
        market_type: MarketType::Perp,
        direction: PositionDirection::Long,
        market_index: 0,
        total_base_asset_amount: BASE_PRECISION_U64 / 20, // 0.05 - not enough
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        order_count: 5,
        size_distribution: SizeDistribution::Flat,
        reduce_only: false,
        post_only: PostOnlyParam::None,
        bit_flags: 0,
        max_ts: None,
    };

    assert!(params.validate(step_size).is_err());
}
