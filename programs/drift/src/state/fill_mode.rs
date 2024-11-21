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
    PlaceAndTake(bool, u8),
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
            FillMode::PlaceAndTake(_, auction_duration_percentage) => {
                let auction_duration = order
                    .auction_duration
                    .cast::<u64>()?
                    .safe_mul(auction_duration_percentage.min(&100).cast()?)?
                    .safe_div(100)?
                    .cast::<u64>()?;

                if order.has_auction() {
                    calculate_auction_price(
                        order,
                        order.slot.safe_add(auction_duration)?,
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
        matches!(self, FillMode::PlaceAndTake(true, _))
    }
}
