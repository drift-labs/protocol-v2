use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::margin::MarginRequirementType;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_value;
use crate::state::spot_market::SpotMarket;
use crate::{PRICE_PRECISION, SPOT_WEIGHT_PRECISION_U128};

#[cfg(test)]
mod tests;

pub fn calculate_swap_price(
    asset_amount: u128,
    liability_amount: u128,
    asset_decimals: u32,
    liability_decimals: u32,
) -> DriftResult<u128> {
    asset_amount
        .safe_mul(PRICE_PRECISION)?
        .safe_div(10_u128.pow(asset_decimals))?
        .safe_mul(10_u128.pow(liability_decimals))?
        .safe_div(liability_amount)
}

pub fn select_margin_type_for_swap(
    in_market: &SpotMarket,
    out_market: &SpotMarket,
    in_price: i64,
    out_price: i64,
    in_token_amount_before: i128,
    out_token_amount_before: i128,
    in_token_amount_after: i128,
    out_token_amount_after: i128,
) -> DriftResult<MarginRequirementType> {
    let calculate_free_collateral_contribution =
        |market: &SpotMarket, price: i64, token_amount: i128| {
            let token_value = get_token_value(token_amount, market.decimals, price)?;

            let weight = if token_amount >= 0 {
                market.get_asset_weight(
                    token_amount.unsigned_abs(),
                    &MarginRequirementType::Initial,
                )?
            } else {
                market.get_liability_weight(
                    token_amount.unsigned_abs(),
                    &MarginRequirementType::Initial,
                )?
            };

            token_value
                .safe_mul(weight.cast::<i128>()?)?
                .safe_div(SPOT_WEIGHT_PRECISION_U128.cast()?)
        };

    let in_free_collateral_contribution_before =
        calculate_free_collateral_contribution(in_market, in_price, in_token_amount_before)?;

    let out_free_collateral_contribution_before =
        calculate_free_collateral_contribution(out_market, out_price, out_token_amount_before)?;

    let free_collateral_contribution_before =
        in_free_collateral_contribution_before.safe_add(out_free_collateral_contribution_before)?;

    let in_free_collateral_contribution_after =
        calculate_free_collateral_contribution(in_market, in_price, in_token_amount_after)?;

    let out_free_collateral_contribution_after =
        calculate_free_collateral_contribution(out_market, out_price, out_token_amount_after)?;

    let free_collateral_contribution_after =
        in_free_collateral_contribution_after.safe_add(out_free_collateral_contribution_after)?;

    let margin_type = if free_collateral_contribution_after > free_collateral_contribution_before {
        MarginRequirementType::Maintenance
    } else {
        MarginRequirementType::Initial
    };

    Ok(margin_type)
}
