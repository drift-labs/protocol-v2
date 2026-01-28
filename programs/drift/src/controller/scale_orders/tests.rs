use crate::controller::scale_orders::*;
use crate::state::order_params::{PostOnlyParam, ScaleOrderParams, SizeDistribution};
use crate::{PositionDirection, BASE_PRECISION_U64, PRICE_PRECISION_U64};

#[test]
fn test_validate_order_count_bounds() {
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    // Test minimum order count
    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
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
    assert!(validate_scale_order_params(&params, step_size).is_err());

    // Test maximum order count
    let params = ScaleOrderParams {
        order_count: 33, // Above maximum (MAX_OPEN_ORDERS = 32)
        ..params
    };
    assert!(validate_scale_order_params(&params, step_size).is_err());

    // Test valid order count
    let params = ScaleOrderParams {
        order_count: 5,
        ..params
    };
    assert!(validate_scale_order_params(&params, step_size).is_ok());
}

#[test]
fn test_validate_price_range() {
    let step_size = BASE_PRECISION_U64 / 1000;

    // Long orders: start_price must be > end_price (scaling down)
    let params = ScaleOrderParams {
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
    assert!(validate_scale_order_params(&params, step_size).is_err());

    // Short orders: start_price must be < end_price (scaling up)
    let params = ScaleOrderParams {
        direction: PositionDirection::Short,
        start_price: 110 * PRICE_PRECISION_U64, // Wrong: higher than end
        end_price: 100 * PRICE_PRECISION_U64,
        ..params
    };
    assert!(validate_scale_order_params(&params, step_size).is_err());

    // Valid long order (start high, end low - DCA down)
    let params = ScaleOrderParams {
        direction: PositionDirection::Long,
        start_price: 110 * PRICE_PRECISION_U64,
        end_price: 100 * PRICE_PRECISION_U64,
        ..params
    };
    assert!(validate_scale_order_params(&params, step_size).is_ok());

    // Valid short order (start low, end high - scale out up)
    let params = ScaleOrderParams {
        direction: PositionDirection::Short,
        start_price: 100 * PRICE_PRECISION_U64,
        end_price: 110 * PRICE_PRECISION_U64,
        ..params
    };
    assert!(validate_scale_order_params(&params, step_size).is_ok());
}

#[test]
fn test_price_distribution_long() {
    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
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

    let prices = calculate_price_distribution(&params).unwrap();
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

    let prices = calculate_price_distribution(&params).unwrap();
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

    let sizes = calculate_size_distribution(&params, step_size).unwrap();
    assert_eq!(sizes.len(), 5);

    // All sizes should be roughly equal
    let total: u64 = sizes.iter().sum();
    assert_eq!(total, BASE_PRECISION_U64);

    // Check that all sizes are roughly 0.2 (200_000_000)
    for (i, size) in sizes.iter().enumerate() {
        if i < 4 {
            assert_eq!(*size, 200000000); // 0.2
        }
    }
}

#[test]
fn test_ascending_size_distribution() {
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
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

    let sizes = calculate_size_distribution(&params, step_size).unwrap();
    assert_eq!(sizes.len(), 5);

    // Ascending: first should be smallest, last should be largest
    assert!(sizes[0] < sizes[4]);
    assert!(sizes[0] <= sizes[1]);
    assert!(sizes[1] <= sizes[2]);
    assert!(sizes[2] <= sizes[3]);
    assert!(sizes[3] <= sizes[4]);

    let total: u64 = sizes.iter().sum();
    assert_eq!(total, BASE_PRECISION_U64);
}

#[test]
fn test_descending_size_distribution() {
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
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

    let sizes = calculate_size_distribution(&params, step_size).unwrap();
    assert_eq!(sizes.len(), 5);

    // Descending: first should be largest, last should be smallest
    assert!(sizes[0] > sizes[4]);
    assert!(sizes[0] >= sizes[1]);
    assert!(sizes[1] >= sizes[2]);
    assert!(sizes[2] >= sizes[3]);
    assert!(sizes[3] >= sizes[4]);

    let total: u64 = sizes.iter().sum();
    assert_eq!(total, BASE_PRECISION_U64);
}

#[test]
fn test_expand_to_order_params() {
    let step_size = BASE_PRECISION_U64 / 1000; // 0.001

    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
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

    let order_params = expand_scale_order_params(&params, step_size).unwrap();
    assert_eq!(order_params.len(), 3);

    // Check first order has bit flags
    assert_eq!(order_params[0].bit_flags, 2);
    // Other orders should have 0 bit flags
    assert_eq!(order_params[1].bit_flags, 0);
    assert_eq!(order_params[2].bit_flags, 0);

    // Check common properties
    for op in &order_params {
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
fn test_two_orders_price_distribution() {
    // Long: start high, end low (DCA down)
    let params = ScaleOrderParams {
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

    let prices = calculate_price_distribution(&params).unwrap();
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

    assert!(validate_scale_order_params(&params, step_size).is_err());
}
