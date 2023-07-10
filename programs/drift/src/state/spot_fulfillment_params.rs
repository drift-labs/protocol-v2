use crate::error::DriftResult;
use crate::state::events::OrderActionExplanation;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::PositionDirection;
use std::cell::Ref;

pub trait SpotFulfillmentParams {
    /// Where or not the taker order is filled externally using another solana program
    fn is_external(&self) -> bool;

    /// Returns the markets best bid and ask price, in PRICE_PRECISION
    fn get_best_bid_and_ask(&self) -> DriftResult<(Option<u64>, Option<u64>)>;

    /// Fulfills the taker order
    ///
    /// # Arguments
    ///
    /// *`taker_direction` - The direction of the taker order
    /// *`taker_price` - The price of the taker order, in PRICE_PRECISION
    /// *`taker_base_asset_amount` - The base amount for taker order, precision is 10^base_mint_decimals
    /// *`taker_max_quote_asset_amount` - The max quote amount for taker order, precision is QUOTE_PRECISION (1e6)
    /// *`now` - The current unix timestamp
    fn fulfill_order(
        &mut self,
        taker_direction: PositionDirection,
        taker_price: u64,
        taker_base_asset_amount: u64,
        taker_max_quote_asset_amount: u64,
    ) -> DriftResult<ExternalSpotFill>;

    /// Gets the order action explanation to be logged in the OrderActionRecord
    fn get_order_action_explanation(&self) -> DriftResult<OrderActionExplanation>;

    /// Called at the end of instructions calling fill_spot_order, validates that the token amount in each market's vault
    /// equals the markets deposits - borrows
    fn validate_vault_amounts(
        &self,
        base_market: &Ref<SpotMarket>,
        quote_market: &Ref<SpotMarket>,
    ) -> DriftResult<()>;
}

pub struct ExternalSpotFill {
    pub base_asset_amount_filled: u64,
    pub base_update_direction: SpotBalanceType,
    pub quote_asset_amount_filled: u64,
    pub quote_update_direction: SpotBalanceType,
    pub settled_referrer_rebate: u64,
    pub unsettled_referrer_rebate: u64,
    pub fee: u64,
}

impl ExternalSpotFill {
    pub fn empty() -> ExternalSpotFill {
        ExternalSpotFill {
            base_asset_amount_filled: 0,
            base_update_direction: SpotBalanceType::Deposit,
            quote_asset_amount_filled: 0,
            quote_update_direction: SpotBalanceType::Borrow,
            settled_referrer_rebate: 0,
            unsettled_referrer_rebate: 0,
            fee: 0,
        }
    }
}

#[cfg(test)]
use crate::error::ErrorCode;
#[cfg(test)]
pub struct TestFulfillmentParams {}

#[cfg(test)]
impl SpotFulfillmentParams for TestFulfillmentParams {
    fn is_external(&self) -> bool {
        false
    }

    fn get_best_bid_and_ask(&self) -> DriftResult<(Option<u64>, Option<u64>)> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }

    fn fulfill_order(
        &mut self,
        _taker_direction: PositionDirection,
        _taker_price: u64,
        _taker_base_asset_amount: u64,
        _taker_max_quote_asset_amount: u64,
    ) -> DriftResult<ExternalSpotFill> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }

    fn get_order_action_explanation(&self) -> DriftResult<OrderActionExplanation> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }

    fn validate_vault_amounts(
        &self,
        _base_market: &Ref<SpotMarket>,
        _quote_market: &Ref<SpotMarket>,
    ) -> DriftResult<()> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }
}
