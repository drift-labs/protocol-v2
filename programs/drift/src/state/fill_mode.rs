use crate::error::DriftResult;
use crate::math::auction::calculate_auction_price;
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;
use crate::state::user::Order;

#[cfg(test)]
mod tests;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum FillMode {
    Fill,
    PlaceAndMake,
    PlaceAndTake(bool),
    Liquidation,
    RFQ,
}

impl FillMode {
    pub fn get_limit_price(
        &self,
        order: &Order,
        valid_oracle_price: Option<i64>,
        slot: u64,
        tick_size: u64,
        is_prediction_market: bool,
    ) -> DriftResult<Option<u64>> {
        match self {
            FillMode::Fill | FillMode::PlaceAndMake | FillMode::Liquidation | FillMode::RFQ => {
                order.get_limit_price(
                    valid_oracle_price,
                    None,
                    slot,
                    tick_size,
                    is_prediction_market,
                )
            }
            FillMode::PlaceAndTake(_) => {
                if order.has_auction() {
                    calculate_auction_price(
                        order,
                        order.slot.safe_add(order.auction_duration.cast()?)?,
                        tick_size,
                        valid_oracle_price,
                        is_prediction_market,
                    )
                    .map(Some)
                } else {
                    order.get_limit_price(
                        valid_oracle_price,
                        None,
                        slot,
                        tick_size,
                        is_prediction_market,
                    )
                }
            }
        }
    }

    pub fn is_liquidation(&self) -> bool {
        self == &FillMode::Liquidation
    }

    pub fn is_rfq(&self) -> bool {
        self == &FillMode::RFQ
    }

    pub fn is_ioc(&self) -> bool {
        self == &FillMode::PlaceAndTake(true)
    }
}
