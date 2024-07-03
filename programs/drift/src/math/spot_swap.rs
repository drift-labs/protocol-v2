use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::margin::MarginRequirementType;
use crate::math::orders::{calculate_fill_price, validate_fill_price_within_price_bands};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::{get_strict_token_value, get_token_value};
use crate::state::oracle::StrictOraclePrice;
use crate::state::perp_market::ContractType;
use crate::state::spot_market::SpotMarket;
use crate::{PositionDirection, PRICE_PRECISION, SPOT_WEIGHT_PRECISION_U128};

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
    in_strict_price: &StrictOraclePrice,
    out_strict_price: &StrictOraclePrice,
    in_token_amount_before: i128,
    out_token_amount_before: i128,
    in_token_amount_after: i128,
    out_token_amount_after: i128,
    strict_margin_type: MarginRequirementType,
) -> DriftResult<MarginRequirementType> {
    let calculate_free_collateral_contribution =
        |market: &SpotMarket, strict_oracle_price: &StrictOraclePrice, token_amount: i128| {
            let token_value =
                get_strict_token_value(token_amount, market.decimals, strict_oracle_price)?;

            let weight = if token_amount >= 0 {
                market.get_asset_weight(
                    token_amount.unsigned_abs(),
                    strict_oracle_price.current,
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
        calculate_free_collateral_contribution(in_market, in_strict_price, in_token_amount_before)?;

    let out_free_collateral_contribution_before = calculate_free_collateral_contribution(
        out_market,
        out_strict_price,
        out_token_amount_before,
    )?;

    let free_collateral_contribution_before =
        in_free_collateral_contribution_before.safe_add(out_free_collateral_contribution_before)?;

    let in_free_collateral_contribution_after =
        calculate_free_collateral_contribution(in_market, in_strict_price, in_token_amount_after)?;

    let out_free_collateral_contribution_after = calculate_free_collateral_contribution(
        out_market,
        out_strict_price,
        out_token_amount_after,
    )?;

    let free_collateral_contribution_after =
        in_free_collateral_contribution_after.safe_add(out_free_collateral_contribution_after)?;

    let margin_type = if free_collateral_contribution_after > free_collateral_contribution_before {
        MarginRequirementType::Maintenance
    } else {
        strict_margin_type
    };

    Ok(margin_type)
}

pub fn validate_price_bands_for_swap(
    in_market: &SpotMarket,
    out_market: &SpotMarket,
    amount_in: u64,
    amount_out: u64,
    in_price: i64,
    out_price: i64,
    oracle_twap_5min_percent_divergence: u64,
) -> DriftResult {
    let (fill_price, direction, oracle_price, oracle_twap_5min, margin_ratio) = {
        let in_market_margin_ratio = in_market.get_margin_ratio(&MarginRequirementType::Initial)?;

        if in_market_margin_ratio != 0 {
            // quote value for out amount
            let out_value = get_token_value(amount_out.cast()?, out_market.decimals, out_price)?
                .cast::<u64>()?;

            // calculate fill price in quote
            let fill_price = calculate_fill_price(out_value, amount_in, in_market.get_precision())?;

            (
                fill_price,
                PositionDirection::Short,
                in_price,
                in_market.historical_oracle_data.last_oracle_price_twap_5min,
                in_market_margin_ratio,
            )
        } else {
            let fill_price =
                calculate_fill_price(amount_in, amount_out, out_market.get_precision())?;

            (
                fill_price,
                PositionDirection::Long,
                out_price,
                out_market
                    .historical_oracle_data
                    .last_oracle_price_twap_5min,
                out_market.get_margin_ratio(&MarginRequirementType::Initial)?,
            )
        }
    };

    validate_fill_price_within_price_bands(
        fill_price,
        direction,
        oracle_price,
        oracle_twap_5min,
        margin_ratio,
        oracle_twap_5min_percent_divergence,
        ContractType::Spot,
    )?;

    Ok(())
}
