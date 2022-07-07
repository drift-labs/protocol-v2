use crate::error::ClearingHouseResult;
use crate::math::auction::is_auction_complete;
use crate::state::fulfillment::FulfillmentMethod;
use crate::state::user::Order;

pub fn determine_fulfillment_method(
    taker_order: &Order,
    maker_available: bool,
    now: i64,
) -> ClearingHouseResult<FulfillmentMethod> {
    if is_auction_complete(taker_order.ts, taker_order.auction_duration, now)? {
        return Ok(FulfillmentMethod::AMM);
    }

    match maker_available {
        true => Ok(FulfillmentMethod::Match),
        false => Ok(FulfillmentMethod::None),
    }
}
