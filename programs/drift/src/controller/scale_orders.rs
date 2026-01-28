use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::constants::MAX_OPEN_ORDERS;
use crate::math::safe_math::SafeMath;
use crate::state::order_params::{OrderParams, ScaleOrderParams, SizeDistribution};
use crate::state::user::{MarketType, OrderTriggerCondition, OrderType, User};
use crate::validate;
use solana_program::msg;

#[cfg(test)]
mod tests;

/// Maximum number of orders allowed in a single scale order instruction
pub const MAX_SCALE_ORDER_COUNT: u8 = MAX_OPEN_ORDERS;
/// Minimum number of orders required for a scale order
pub const MIN_SCALE_ORDER_COUNT: u8 = 2;

/// Validates that placing scale orders won't exceed user's max open orders
pub fn validate_user_can_place_scale_orders(
    user: &User,
    order_count: u8,
) -> DriftResult<()> {
    let current_open_orders = user
        .orders
        .iter()
        .filter(|o| o.status == crate::state::user::OrderStatus::Open)
        .count() as u8;

    let total_after = current_open_orders.saturating_add(order_count);

    validate!(
        total_after <= MAX_OPEN_ORDERS,
        ErrorCode::MaxNumberOfOrders,
        "placing {} scale orders would exceed max open orders ({} current + {} new = {} > {} max)",
        order_count,
        current_open_orders,
        order_count,
        total_after,
        MAX_OPEN_ORDERS
    )?;

    Ok(())
}

/// Validates the scale order parameters
pub fn validate_scale_order_params(
    params: &ScaleOrderParams,
    order_step_size: u64,
) -> DriftResult<()> {
    validate!(
        params.order_count >= MIN_SCALE_ORDER_COUNT,
        ErrorCode::InvalidOrderScaleOrderCount,
        "order_count must be at least {}",
        MIN_SCALE_ORDER_COUNT
    )?;

    validate!(
        params.order_count <= MAX_SCALE_ORDER_COUNT,
        ErrorCode::InvalidOrderScaleOrderCount,
        "order_count must be at most {}",
        MAX_SCALE_ORDER_COUNT
    )?;

    validate!(
        params.start_price != params.end_price,
        ErrorCode::InvalidOrderScalePriceRange,
        "start_price and end_price cannot be equal"
    )?;

    // For long orders, start price is higher (first buy) and end price is lower (DCA down)
    // For short orders, start price is lower (first sell) and end price is higher (scale out up)
    match params.direction {
        PositionDirection::Long => {
            validate!(
                params.start_price > params.end_price,
                ErrorCode::InvalidOrderScalePriceRange,
                "for long scale orders, start_price must be greater than end_price (scaling down)"
            )?;
        }
        PositionDirection::Short => {
            validate!(
                params.start_price < params.end_price,
                ErrorCode::InvalidOrderScalePriceRange,
                "for short scale orders, start_price must be less than end_price (scaling up)"
            )?;
        }
    }

    // Validate that total size can be distributed among all orders meeting minimum step size
    let min_total_size = order_step_size.safe_mul(params.order_count as u64)?;
    validate!(
        params.total_base_asset_amount >= min_total_size,
        ErrorCode::OrderAmountTooSmall,
        "total_base_asset_amount must be at least {} (order_step_size * order_count)",
        min_total_size
    )?;

    Ok(())
}

/// Calculate evenly distributed prices between start and end price
pub fn calculate_price_distribution(params: &ScaleOrderParams) -> DriftResult<Vec<u64>> {
    let order_count = params.order_count as u64;

    if order_count == 1 {
        return Ok(vec![params.start_price]);
    }

    if order_count == 2 {
        return Ok(vec![params.start_price, params.end_price]);
    }

    let (min_price, max_price) = if params.start_price < params.end_price {
        (params.start_price, params.end_price)
    } else {
        (params.end_price, params.start_price)
    };

    let price_range = max_price.safe_sub(min_price)?;
    let price_step = price_range.safe_div(order_count.safe_sub(1)?)?;

    let mut prices = Vec::with_capacity(params.order_count as usize);
    for i in 0..params.order_count {
        let price = if params.start_price < params.end_price {
            params.start_price.safe_add(price_step.safe_mul(i as u64)?)?
        } else {
            params.start_price.safe_sub(price_step.safe_mul(i as u64)?)?
        };
        prices.push(price);
    }

    Ok(prices)
}

/// Calculate order sizes based on size distribution strategy
pub fn calculate_size_distribution(
    params: &ScaleOrderParams,
    order_step_size: u64,
) -> DriftResult<Vec<u64>> {
    match params.size_distribution {
        SizeDistribution::Flat => calculate_flat_sizes(params, order_step_size),
        SizeDistribution::Ascending => calculate_scaled_sizes(params, order_step_size, false),
        SizeDistribution::Descending => calculate_scaled_sizes(params, order_step_size, true),
    }
}

/// Calculate flat (equal) distribution of sizes
fn calculate_flat_sizes(params: &ScaleOrderParams, order_step_size: u64) -> DriftResult<Vec<u64>> {
    let order_count = params.order_count as u64;
    let base_size = params.total_base_asset_amount.safe_div(order_count)?;
    // Round down to step size
    let rounded_size = base_size
        .safe_div(order_step_size)?
        .safe_mul(order_step_size)?;

    let mut sizes = vec![rounded_size; params.order_count as usize];

    // Add remainder to the last order
    let total_distributed: u64 = sizes.iter().sum();
    let remainder = params.total_base_asset_amount.safe_sub(total_distributed)?;
    if remainder > 0 {
        if let Some(last) = sizes.last_mut() {
            *last = last.safe_add(remainder)?;
        }
    }

    Ok(sizes)
}

/// Calculate scaled (ascending/descending) distribution of sizes
/// Uses multipliers: 1x, 1.5x, 2x, 2.5x, ... for ascending
fn calculate_scaled_sizes(
    params: &ScaleOrderParams,
    order_step_size: u64,
    descending: bool,
) -> DriftResult<Vec<u64>> {
    let order_count = params.order_count as usize;

    // Calculate multipliers: 1.0, 1.5, 2.0, 2.5, ... (using 0.5 step)
    // Sum of multipliers = n/2 * (first + last) = n/2 * (1 + (1 + 0.5*(n-1)))
    // For precision, multiply everything by 2: multipliers become 2, 3, 4, 5, ...
    // Sum = n/2 * (2 + (2 + (n-1))) = n/2 * (3 + n) = n*(n+3)/2
    let multiplier_sum = (order_count * (order_count + 3)) / 2;

    // Base unit size (multiplied by 2 for precision)
    let base_unit = params
        .total_base_asset_amount
        .safe_mul(2)?
        .safe_div(multiplier_sum as u64)?;

    let mut sizes = Vec::with_capacity(order_count);
    let mut total = 0u64;

    for i in 0..order_count {
        // Multiplier for position i is (2 + i) when using 0.5 step scaled by 2
        let multiplier = (2 + i) as u64;
        let raw_size = base_unit.safe_mul(multiplier)?.safe_div(2)?;
        // Round to step size
        let rounded_size = raw_size
            .safe_div(order_step_size)?
            .safe_mul(order_step_size)?
            .max(order_step_size); // Ensure at least step size
        sizes.push(rounded_size);
        total = total.safe_add(rounded_size)?;
    }

    // Adjust last order to account for rounding
    if total != params.total_base_asset_amount {
        if let Some(last) = sizes.last_mut() {
            if total > params.total_base_asset_amount {
                let diff = total.safe_sub(params.total_base_asset_amount)?;
                *last = last.saturating_sub(diff).max(order_step_size);
            } else {
                let diff = params.total_base_asset_amount.safe_sub(total)?;
                *last = last.safe_add(diff)?;
            }
        }
    }

    if descending {
        sizes.reverse();
    }

    Ok(sizes)
}

/// Expand scale order params into individual OrderParams
pub fn expand_scale_order_params(
    params: &ScaleOrderParams,
    order_step_size: u64,
) -> DriftResult<Vec<OrderParams>> {
    validate_scale_order_params(params, order_step_size)?;

    let prices = calculate_price_distribution(params)?;
    let sizes = calculate_size_distribution(params, order_step_size)?;

    let mut order_params = Vec::with_capacity(params.order_count as usize);

    for (i, (price, size)) in prices.iter().zip(sizes.iter()).enumerate() {
        order_params.push(OrderParams {
            order_type: OrderType::Limit,
            market_type: MarketType::Perp,
            direction: params.direction,
            user_order_id: 0,
            base_asset_amount: *size,
            price: *price,
            market_index: params.market_index,
            reduce_only: params.reduce_only,
            post_only: params.post_only,
            bit_flags: if i == 0 { params.bit_flags } else { 0 },
            max_ts: params.max_ts,
            trigger_price: None,
            trigger_condition: OrderTriggerCondition::Above,
            oracle_price_offset: None,
            auction_duration: None,
            auction_start_price: None,
            auction_end_price: None,
        });
    }

    Ok(order_params)
}
