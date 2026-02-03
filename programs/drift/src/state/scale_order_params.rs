use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::constants::MAX_OPEN_ORDERS;
use crate::math::safe_math::SafeMath;
use crate::state::order_params::{OrderParams, PostOnlyParam};
use crate::state::user::{MarketType, OrderStatus, OrderTriggerCondition, OrderType, User};
use crate::validate;
use anchor_lang::prelude::*;
use solana_program::msg;

#[cfg(test)]
mod tests;

/// Minimum number of orders required for a scale order
pub const MIN_SCALE_ORDER_COUNT: u8 = 2;
/// Maximum number of orders allowed in a single scale order instruction
pub const MAX_SCALE_ORDER_COUNT: u8 = MAX_OPEN_ORDERS;

/// How to distribute order sizes across scale orders
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Eq, PartialEq, Debug)]
pub enum SizeDistribution {
    /// Equal size for all orders
    #[default]
    Flat,
    /// Smallest orders at start price, largest at end price
    Ascending,
    /// Largest orders at start price, smallest at end price
    Descending,
}

/// Parameters for placing scale orders - multiple limit orders distributed across a price range
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, Eq, PartialEq, Debug)]
pub struct ScaleOrderParams {
    pub market_type: MarketType,
    pub direction: PositionDirection,
    pub market_index: u16,
    /// Total base asset amount to distribute across all orders
    pub total_base_asset_amount: u64,
    /// Starting price for the scale (in PRICE_PRECISION)
    pub start_price: u64,
    /// Ending price for the scale (in PRICE_PRECISION)
    pub end_price: u64,
    /// Number of orders to place (min 2, max 32)
    pub order_count: u8,
    /// How to distribute sizes across orders
    pub size_distribution: SizeDistribution,
    /// Whether orders should be reduce-only
    pub reduce_only: bool,
    /// Post-only setting for all orders
    pub post_only: PostOnlyParam,
    /// Bit flags (e.g., for high leverage mode)
    pub bit_flags: u8,
    /// Maximum timestamp for orders to be valid
    pub max_ts: Option<i64>,
}

impl ScaleOrderParams {
    /// Validates that placing scale orders won't exceed user's max open orders
    pub fn validate_user_order_count(user: &User, order_count: u8) -> DriftResult<()> {
        let current_open_orders = user
            .orders
            .iter()
            .filter(|o| o.status == OrderStatus::Open)
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
    pub fn validate(&self, order_step_size: u64) -> DriftResult<()> {
        validate!(
            self.order_count >= MIN_SCALE_ORDER_COUNT,
            ErrorCode::InvalidOrderScaleOrderCount,
            "order_count must be at least {}",
            MIN_SCALE_ORDER_COUNT
        )?;

        validate!(
            self.order_count <= MAX_SCALE_ORDER_COUNT,
            ErrorCode::InvalidOrderScaleOrderCount,
            "order_count must be at most {}",
            MAX_SCALE_ORDER_COUNT
        )?;

        validate!(
            self.start_price != self.end_price,
            ErrorCode::InvalidOrderScalePriceRange,
            "start_price and end_price cannot be equal"
        )?;

        // For long orders, start price is higher (first buy) and end price is lower (DCA down)
        // For short orders, start price is lower (first sell) and end price is higher (scale out up)
        match self.direction {
            PositionDirection::Long => {
                validate!(
                    self.start_price > self.end_price,
                    ErrorCode::InvalidOrderScalePriceRange,
                    "for long scale orders, start_price must be greater than end_price (scaling down)"
                )?;
            }
            PositionDirection::Short => {
                validate!(
                    self.start_price < self.end_price,
                    ErrorCode::InvalidOrderScalePriceRange,
                    "for short scale orders, start_price must be less than end_price (scaling up)"
                )?;
            }
        }

        // Validate that total size can be distributed among all orders meeting minimum step size
        let min_total_size = order_step_size.safe_mul(self.order_count as u64)?;
        validate!(
            self.total_base_asset_amount >= min_total_size,
            ErrorCode::OrderAmountTooSmall,
            "total_base_asset_amount must be at least {} (order_step_size * order_count)",
            min_total_size
        )?;

        Ok(())
    }

    /// Calculate evenly distributed prices between start and end price
    pub fn calculate_price_distribution(&self) -> DriftResult<Vec<u64>> {
        let order_count = self.order_count as usize;

        if order_count == 1 {
            return Ok(vec![self.start_price]);
        }

        if order_count == 2 {
            return Ok(vec![self.start_price, self.end_price]);
        }

        let (min_price, max_price) = if self.start_price < self.end_price {
            (self.start_price, self.end_price)
        } else {
            (self.end_price, self.start_price)
        };

        let price_range = max_price.safe_sub(min_price)?;
        let num_steps = (order_count - 1) as u64;
        let price_step = price_range.safe_div(num_steps)?;

        let mut prices = Vec::with_capacity(order_count);
        for i in 0..order_count {
            // Use exact end_price for the last order to avoid rounding errors
            let price = if i == order_count - 1 {
                self.end_price
            } else if self.start_price < self.end_price {
                self.start_price.safe_add(price_step.safe_mul(i as u64)?)?
            } else {
                self.start_price.safe_sub(price_step.safe_mul(i as u64)?)?
            };
            prices.push(price);
        }

        Ok(prices)
    }

    /// Calculate order sizes based on size distribution strategy
    pub fn calculate_size_distribution(&self, order_step_size: u64) -> DriftResult<Vec<u64>> {
        match self.size_distribution {
            SizeDistribution::Flat => self.calculate_flat_sizes(order_step_size),
            SizeDistribution::Ascending => self.calculate_scaled_sizes(order_step_size, false),
            SizeDistribution::Descending => self.calculate_scaled_sizes(order_step_size, true),
        }
    }

    /// Calculate flat (equal) distribution of sizes
    fn calculate_flat_sizes(&self, order_step_size: u64) -> DriftResult<Vec<u64>> {
        let order_count = self.order_count as u64;
        let base_size = self.total_base_asset_amount.safe_div(order_count)?;
        // Round down to step size
        let rounded_size = base_size
            .safe_div(order_step_size)?
            .safe_mul(order_step_size)?;

        let mut sizes = vec![rounded_size; self.order_count as usize];

        // Add remainder to the last order
        let total_distributed: u64 = sizes.iter().sum();
        let remainder = self.total_base_asset_amount.safe_sub(total_distributed)?;
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
        &self,
        order_step_size: u64,
        descending: bool,
    ) -> DriftResult<Vec<u64>> {
        let order_count = self.order_count as usize;

        // Calculate multipliers: 1.0, 1.5, 2.0, 2.5, ... (using 0.5 step)
        // Sum of multipliers = n/2 * (first + last) = n/2 * (1 + (1 + 0.5*(n-1)))
        // For precision, multiply everything by 2: multipliers become 2, 3, 4, 5, ...
        // Sum = n/2 * (2 + (2 + (n-1))) = n/2 * (3 + n) = n*(n+3)/2
        let multiplier_sum = (order_count * (order_count + 3)) / 2;

        // Base unit size (multiplied by 2 for precision)
        let base_unit = self
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
        if total != self.total_base_asset_amount {
            if let Some(last) = sizes.last_mut() {
                if total > self.total_base_asset_amount {
                    let diff = total.safe_sub(self.total_base_asset_amount)?;
                    *last = last.saturating_sub(diff).max(order_step_size);
                } else {
                    let diff = self.total_base_asset_amount.safe_sub(total)?;
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
    pub fn expand_to_order_params(&self, order_step_size: u64) -> DriftResult<Vec<OrderParams>> {
        self.validate(order_step_size)?;

        let prices = self.calculate_price_distribution()?;
        let sizes = self.calculate_size_distribution(order_step_size)?;

        let mut order_params = Vec::with_capacity(self.order_count as usize);

        for (i, (price, size)) in prices.iter().zip(sizes.iter()).enumerate() {
            order_params.push(OrderParams {
                order_type: OrderType::Limit,
                market_type: self.market_type,
                direction: self.direction,
                user_order_id: 0,
                base_asset_amount: *size,
                price: *price,
                market_index: self.market_index,
                reduce_only: self.reduce_only,
                post_only: self.post_only,
                bit_flags: if i == 0 { self.bit_flags } else { 0 },
                max_ts: self.max_ts,
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
}
