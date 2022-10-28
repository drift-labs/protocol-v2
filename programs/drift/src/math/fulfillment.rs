use crate::controller::position::PositionDirection;
use crate::error::DriftResult;
use crate::math::auction::is_auction_complete;
use crate::state::fulfillment::{PerpFulfillmentMethod, SpotFulfillmentMethod};
use crate::state::perp_market::AMM;
use crate::state::user::Order;

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
            let maker_price =
                maker_order.get_limit_price(valid_oracle_price, slot, amm.order_tick_size)?;

            let (amm_bid_price, amm_ask_price) = amm.bid_ask_price(amm_reserve_price)?;

            if (taker_order.direction == PositionDirection::Long && maker_price <= amm_ask_price)
                || (taker_order.direction == PositionDirection::Short
                    && maker_price >= amm_bid_price)
            {
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
