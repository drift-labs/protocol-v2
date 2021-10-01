use crate::math::bn;
use crate::math::constants::{FUNDING_PAYMENT_MANTISSA, MARK_PRICE_MANTISSA};
use crate::state::market::AMM;
use crate::state::user::MarketPosition;

pub fn calculate_funding_payment(amm: &AMM, market_position: &MarketPosition) -> i128 {
    let funding_rate_delta = amm
        .cumulative_funding_rate
        .checked_sub(market_position.last_cumulative_funding_rate)
        .unwrap();
    let funding_rate_delta_sign: i128 = if funding_rate_delta > 0 { 1 } else { -1 } as i128;

    let funding_rate_payment_mag = bn::U256::from(funding_rate_delta.unsigned_abs())
        .checked_mul(bn::U256::from(
            market_position.base_asset_amount.unsigned_abs(),
        ))
        .unwrap()
        .checked_div(bn::U256::from(MARK_PRICE_MANTISSA))
        .unwrap()
        .checked_div(bn::U256::from(FUNDING_PAYMENT_MANTISSA))
        .unwrap()
        .try_to_u128()
        .unwrap() as i128;

    // funding_rate is: longs pay shorts
    let funding_rate_payment_sign: i128 = if market_position.base_asset_amount > 0 {
        -1
    } else {
        1
    } as i128;

    let funding_rate_payment = (funding_rate_payment_mag)
        .checked_mul(funding_rate_payment_sign)
        .unwrap()
        .checked_mul(funding_rate_delta_sign)
        .unwrap();

    return funding_rate_payment;
}
