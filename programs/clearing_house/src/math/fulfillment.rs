use crate::error::ClearingHouseResult;
use crate::math::auction::is_auction_complete;
use crate::state::fulfillment::FulfillmentMethod;
use crate::state::user::Order;

pub fn determine_fulfillment_methods(
    taker_order: &Order,
    maker_available: bool,
    slot: u64,
) -> ClearingHouseResult<Vec<FulfillmentMethod>> {
    let mut fulfillment_methods = vec![];

    if maker_available {
        fulfillment_methods.push(FulfillmentMethod::Match)
    }

    if is_auction_complete(taker_order.slot, taker_order.auction_duration, slot)? {
        fulfillment_methods.push(FulfillmentMethod::AMM)
    }

    Ok(fulfillment_methods)
}
