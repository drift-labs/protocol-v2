use crate::controller::position::PositionDirection;
use crate::error::DriftResult;
use crate::math::auction::is_auction_complete;
use crate::math::matching::do_orders_cross;
use crate::state::fulfillment::{PerpFulfillmentMethod, SpotFulfillmentMethod};
use crate::state::perp_market::AMM;
use crate::state::user::Order;

#[cfg(test)]
mod tests;

pub fn determine_perp_fulfillment_methods(
    taker_order: &Order,
    maker_order: Option<&Order>,
    amm: &AMM,
    amm_reserve_price: u64,
    valid_oracle_price: Option<i64>,
    amm_is_available: bool,
    slot: u64,
) -> DriftResult<Vec<PerpFulfillmentMethod>> {
    let mut fulfillment_methods = vec![];

    let is_amm_available = amm_is_available
        && valid_oracle_price.is_some()
        && is_auction_complete(taker_order.slot, taker_order.auction_duration, slot)?;

    if let Some(maker_order) = maker_order {
        if is_amm_available {
            let taker_price =
                taker_order.get_limit_price(valid_oracle_price, None, slot, amm.order_tick_size)?;

            let maker_price = maker_order.force_get_limit_price(
                valid_oracle_price,
                None,
                slot,
                amm.order_tick_size,
            )?;

            let (amm_bid_price, amm_ask_price) = amm.bid_ask_price(amm_reserve_price)?;

            let taker_crosses_maker = match taker_price {
                Some(taker_price) => {
                    do_orders_cross(maker_order.direction, maker_price, taker_price)
                }
                None => true,
            };

            let maker_better_than_amm = match taker_order.direction {
                PositionDirection::Long => maker_price <= amm_ask_price,
                PositionDirection::Short => maker_price >= amm_bid_price,
            };

            if !taker_crosses_maker {
                fulfillment_methods.push(PerpFulfillmentMethod::AMM(None));
            } else if taker_crosses_maker && maker_better_than_amm {
                fulfillment_methods.push(PerpFulfillmentMethod::Match);
                fulfillment_methods.push(PerpFulfillmentMethod::AMM(None));
            } else {
                fulfillment_methods.push(PerpFulfillmentMethod::AMM(Some(maker_price)));
                fulfillment_methods.push(PerpFulfillmentMethod::Match);
                fulfillment_methods.push(PerpFulfillmentMethod::AMM(None));
            }
        } else {
            fulfillment_methods.push(PerpFulfillmentMethod::Match);
        }
    } else if is_amm_available {
        fulfillment_methods.push(PerpFulfillmentMethod::AMM(None));
    }

    Ok(fulfillment_methods)
}

pub fn determine_spot_fulfillment_methods(
    taker_order: &Order,
    maker_available: bool,
    serum_fulfillment_params_available: bool,
) -> DriftResult<Vec<SpotFulfillmentMethod>> {
    let mut fulfillment_methods = vec![];

    if maker_available {
        fulfillment_methods.push(SpotFulfillmentMethod::Match)
    }

    if !taker_order.post_only && serum_fulfillment_params_available {
        fulfillment_methods.push(SpotFulfillmentMethod::SerumV3)
    }

    Ok(fulfillment_methods)
}
