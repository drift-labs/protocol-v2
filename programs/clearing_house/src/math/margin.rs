use crate::market::Markets;
use crate::math::constants::MARGIN_MANTISSA;
use crate::user::{User, UserPositions};
use crate::{calculate_base_asset_value_and_pnl, calculate_updated_collateral};
use std::cell::{Ref, RefMut};

pub fn calculate_margin_ratio(
    user: &User,
    user_positions: &RefMut<UserPositions>,
    markets: &Ref<Markets>,
) -> (u128, u128, u128) {
    let mut base_asset_value: u128 = 0;
    let mut unrealized_pnl: i128 = 0;

    // loop 1 to calculate unrealized_pnl
    for market_position in user_positions.positions.iter() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let amm = &markets.markets[Markets::index_from_u64(market_position.market_index)].amm;
        let (position_base_asset_value, position_unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, amm);

        base_asset_value = base_asset_value
            .checked_add(position_base_asset_value)
            .unwrap();
        unrealized_pnl = unrealized_pnl.checked_add(position_unrealized_pnl).unwrap();
    }

    let estimated_margin: u128;
    let margin_ratio: u128;
    if base_asset_value == 0 {
        estimated_margin = u128::MAX;
        margin_ratio = u128::MAX;
    } else {
        estimated_margin = calculate_updated_collateral(user.collateral, unrealized_pnl);
        margin_ratio = estimated_margin
            .checked_mul(MARGIN_MANTISSA)
            .unwrap()
            .checked_div(base_asset_value)
            .unwrap();
    }
    return (estimated_margin, base_asset_value, margin_ratio);
}
