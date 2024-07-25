use crate::controller::position::PositionDirection;
use crate::error::DriftResult;
use crate::math::auction::is_amm_available_liquidity_source;
use crate::math::casting::Cast;
use crate::math::matching::do_orders_cross;
use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::fill_mode::FillMode;
use crate::state::fulfillment::{PerpFulfillmentMethod, SpotFulfillmentMethod};
use crate::state::perp_market::AMM;
use crate::state::user::Order;
use solana_program::pubkey::Pubkey;

#[cfg(test)]
mod tests;

pub fn determine_perp_fulfillment_methods(
    order: &Order,
    maker_orders_info: &[(Pubkey, usize, u64)],
    amm: &AMM,
    amm_reserve_price: u64,
    valid_oracle_price: Option<i64>,
    limit_price: Option<u64>,
    amm_is_available: bool,
    slot: u64,
    min_auction_duration: u8,
    fill_mode: FillMode,
) -> DriftResult<Vec<PerpFulfillmentMethod>> {
    if order.post_only {
        return determine_perp_fulfillment_methods_for_maker(
            order,
            amm,
            amm_reserve_price,
            valid_oracle_price,
            limit_price,
            amm_is_available,
            slot,
            min_auction_duration,
            fill_mode,
        );
    }

    let mut fulfillment_methods = Vec::with_capacity(8);

    let can_fill_with_amm = amm_is_available
        && valid_oracle_price.is_some()
        && is_amm_available_liquidity_source(order, min_auction_duration, slot, fill_mode)?;

    let maker_direction = order.direction.opposite();

    let mut amm_price = match maker_direction {
        PositionDirection::Long => amm.bid_price(amm_reserve_price)?,
        PositionDirection::Short => amm.ask_price(amm_reserve_price)?,
    };

    for (maker_key, maker_order_index, maker_price) in maker_orders_info.iter() {
        let taker_crosses_maker = match limit_price {
            Some(taker_price) => do_orders_cross(maker_direction, *maker_price, taker_price),
            None => true,
        };

        if !taker_crosses_maker {
            break;
        }

        if can_fill_with_amm {
            let maker_better_than_amm = match order.direction {
                PositionDirection::Long => *maker_price <= amm_price,
                PositionDirection::Short => *maker_price >= amm_price,
            };

            if !maker_better_than_amm {
                fulfillment_methods.push(PerpFulfillmentMethod::AMM(Some(*maker_price)));
                amm_price = *maker_price;
            }
        }

        fulfillment_methods.push(PerpFulfillmentMethod::Match(
            *maker_key,
            maker_order_index.cast()?,
        ));

        if fulfillment_methods.len() > 6 {
            break;
        }
    }

    if can_fill_with_amm {
        let taker_crosses_amm = match limit_price {
            Some(taker_price) => do_orders_cross(maker_direction, amm_price, taker_price),
            None => true,
        };

        if taker_crosses_amm {
            fulfillment_methods.push(PerpFulfillmentMethod::AMM(None));
        }
    }

    Ok(fulfillment_methods)
}

fn determine_perp_fulfillment_methods_for_maker(
    order: &Order,
    amm: &AMM,
    amm_reserve_price: u64,
    valid_oracle_price: Option<i64>,
    limit_price: Option<u64>,
    amm_is_available: bool,
    slot: u64,
    min_auction_duration: u8,
    fill_mode: FillMode,
) -> DriftResult<Vec<PerpFulfillmentMethod>> {
    let maker_direction = order.direction;

    let can_fill_with_amm = amm_is_available
        && valid_oracle_price.is_some()
        && is_amm_available_liquidity_source(order, min_auction_duration, slot, fill_mode)?;

    if !can_fill_with_amm {
        return Ok(vec![]);
    }

    let amm_price = match maker_direction {
        PositionDirection::Long => amm.ask_price(amm_reserve_price)?,
        PositionDirection::Short => amm.bid_price(amm_reserve_price)?,
    };

    let maker_price = limit_price.safe_unwrap()?;

    let amm_crosses_maker = do_orders_cross(maker_direction, maker_price, amm_price);

    if amm_crosses_maker {
        Ok(vec![PerpFulfillmentMethod::AMM(None)])
    } else {
        Ok(vec![])
    }
}

pub fn determine_spot_fulfillment_methods(
    order: &Order,
    maker_orders_info: &[(Pubkey, usize, u64)],
    limit_price: Option<u64>,
    external_fulfillment_params_available: bool,
) -> DriftResult<Vec<SpotFulfillmentMethod>> {
    let mut fulfillment_methods = Vec::with_capacity(8);

    if !order.post_only && external_fulfillment_params_available {
        fulfillment_methods.push(SpotFulfillmentMethod::ExternalMarket);
        return Ok(fulfillment_methods);
    }

    let maker_direction = order.direction.opposite();

    for (maker_key, maker_order_index, maker_price) in maker_orders_info.iter() {
        let taker_crosses_maker = match limit_price {
            Some(taker_price) => do_orders_cross(maker_direction, *maker_price, taker_price),
            // todo come up with fallback price
            None => false,
        };

        if !taker_crosses_maker {
            break;
        }

        fulfillment_methods.push(SpotFulfillmentMethod::Match(
            *maker_key,
            *maker_order_index as u16,
        ));

        if fulfillment_methods.len() > 6 {
            break;
        }
    }

    Ok(fulfillment_methods)
}
