use crate::error::*;
use crate::math_error;
use crate::state::state::{DriftTokenRebateTier, FeeStructure};
use solana_program::msg;
use spl_token::state::Account;

pub fn calculate(
    quote_asset_amount: u128,
    fee_structure: &FeeStructure,
    drift_token: Option<Account>,
) -> ClearingHouseResult<(u128, u128)> {
    let fee = quote_asset_amount
        .checked_mul(fee_structure.fee_numerator)
        .ok_or_else(math_error!())?
        .checked_div(fee_structure.fee_denominator)
        .ok_or_else(math_error!())?;

    let drift_token_rebate = calculate_drift_token_rebate(fee, fee_structure, drift_token);

    let fee = fee - drift_token_rebate;

    return Ok((fee, drift_token_rebate));
}

fn calculate_drift_token_rebate(
    fee: u128,
    fee_structure: &FeeStructure,
    drift_token: Option<Account>,
) -> u128 {
    if drift_token.is_none() {
        return 0;
    }

    let drift_token = drift_token.unwrap();

    if let Some(rebate) = calculate_drift_token_rebate_for_tier(
        fee,
        &fee_structure.drift_token_rebate.first_tier,
        drift_token,
    ) {
        return rebate;
    }

    if let Some(rebate) = calculate_drift_token_rebate_for_tier(
        fee,
        &fee_structure.drift_token_rebate.second_tier,
        drift_token,
    ) {
        return rebate;
    }

    if let Some(rebate) = calculate_drift_token_rebate_for_tier(
        fee,
        &fee_structure.drift_token_rebate.third_tier,
        drift_token,
    ) {
        return rebate;
    }

    if let Some(rebate) = calculate_drift_token_rebate_for_tier(
        fee,
        &fee_structure.drift_token_rebate.fourth_tier,
        drift_token,
    ) {
        return rebate;
    }

    return 0;
}

fn calculate_drift_token_rebate_for_tier(
    fee: u128,
    tier: &DriftTokenRebateTier,
    drift_token: Account,
) -> Option<u128> {
    if drift_token.amount >= tier.minimum_balance {
        return Some(
            fee.checked_mul(tier.rebate_numerator)?
                .checked_div(tier.rebate_denominator)?,
        );
    }
    return None;
}
