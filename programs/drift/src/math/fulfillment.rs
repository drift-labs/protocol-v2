use crate::controller::position::PositionDirection;
use crate::error::DriftResult;
use crate::math::auction::is_amm_available_liquidity_source;
use crate::math::matching::do_orders_cross;
use crate::state::fulfillment::{PerpFulfillmentMethod, SpotFulfillmentMethod};
use crate::state::perp_market::AMM;
use crate::state::user::Order;
use solana_program::pubkey::Pubkey;

#[cfg(test)]
mod tests;

pub fn determine_perp_fulfillment_methods(
    taker_order: &Order,
    maker_orders_info: &[(Pubkey, usize, u64)],
    amm: &AMM,
    amm_reserve_price: u64,
    valid_oracle_price: Option<i64>,
    amm_is_available: bool,
    slot: u64,
    min_auction_duration: u8,
) -> DriftResult<Vec<PerpFulfillmentMethod>> {
    let mut fulfillment_methods = Vec::with_capacity(8);

    let can_fill_with_amm = amm_is_available
        && valid_oracle_price.is_some()
        && is_amm_available_liquidity_source(taker_order, min_auction_duration, slot)?;

    let taker_price =
        taker_order.get_limit_price(valid_oracle_price, None, slot, amm.order_tick_size)?;

    let maker_direction = taker_order.direction.opposite();

    let (mut amm_bid_price, mut amm_ask_price) = amm.bid_ask_price(amm_reserve_price)?;

    for (maker_key, maker_order_index, maker_price) in maker_orders_info.iter() {
        let taker_crosses_maker = match taker_price {
            Some(taker_price) => do_orders_cross(maker_direction, *maker_price, taker_price),
            None => true,
        };

        if !taker_crosses_maker {
            break;
        }

        if can_fill_with_amm {
            let maker_better_than_amm = match taker_order.direction {
                PositionDirection::Long => *maker_price <= amm_ask_price,
                PositionDirection::Short => *maker_price >= amm_bid_price,
            };

            if !maker_better_than_amm {
                fulfillment_methods.push(PerpFulfillmentMethod::AMM(Some(*maker_price)));

                match taker_order.direction {
                    PositionDirection::Long => amm_ask_price = *maker_price,
                    PositionDirection::Short => amm_bid_price = *maker_price,
                };
            }
        }

        fulfillment_methods.push(PerpFulfillmentMethod::Match(
            *maker_key,
            *maker_order_index as u16,
        ));

        if fulfillment_methods.len() > 6 {
            break;
        }
    }

    if can_fill_with_amm {
        let amm_price = match maker_direction {
            PositionDirection::Long => amm_bid_price,
            PositionDirection::Short => amm_ask_price,
        };

        let taker_crosses_maker = match taker_price {
            Some(taker_price) => do_orders_cross(maker_direction, amm_price, taker_price),
            None => true,
        };

        if taker_crosses_maker {
            fulfillment_methods.push(PerpFulfillmentMethod::AMM(None));
        }
    }

    Ok(fulfillment_methods)
}

pub fn determine_spot_fulfillment_methods(
    taker_order: &Order,
    maker_available: bool,
    external_fulfillment_params_available: bool,
) -> DriftResult<Vec<SpotFulfillmentMethod>> {
    let mut fulfillment_methods = vec![];

    if maker_available {
        fulfillment_methods.push(SpotFulfillmentMethod::Match)
    }

    if !taker_order.post_only && external_fulfillment_params_available {
        fulfillment_methods.push(SpotFulfillmentMethod::ExternalMarket)
    }

    Ok(fulfillment_methods)
}
