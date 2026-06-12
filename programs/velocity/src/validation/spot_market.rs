use crate::error::{ErrorCode, VelocityResult};
use crate::math::casting::Cast;
use crate::math::constants::{
    MAX_WITHDRAW_GUARD_THRESHOLD_NOTIONAL, SPOT_UTILIZATION_PRECISION_U32,
};
use crate::math::spot_balance::get_token_value;
use crate::msg;
use crate::validate;

pub fn validate_borrow_rate(
    optimal_utilization: u32,
    optimal_borrow_rate: u32,
    max_borrow_rate: u32,
    min_borrow_rate: u32,
) -> VelocityResult {
    validate!(
        optimal_utilization <= SPOT_UTILIZATION_PRECISION_U32,
        ErrorCode::InvalidSpotMarketInitialization,
        "For spot market, optimal_utilization must be < {}",
        SPOT_UTILIZATION_PRECISION_U32
    )?;

    validate!(
        optimal_borrow_rate <= max_borrow_rate,
        ErrorCode::InvalidSpotMarketInitialization,
        "For spot market, optimal borrow rate ({}) must be <=  max borrow rate ({})",
        optimal_borrow_rate,
        max_borrow_rate
    )?;

    validate!(
        optimal_borrow_rate >= min_borrow_rate,
        ErrorCode::InvalidSpotMarketInitialization,
        "For spot market, optimal borrow rate ({}) must be >= min borrow rate ({})",
        optimal_borrow_rate,
        min_borrow_rate
    )?;

    Ok(())
}

/// The withdraw guard threshold is capped at a hardcoded $10k notional
/// (at the current oracle price) so a compromised or malicious admin can't
/// disable the withdraw circuit breaker by setting it near-infinite.
pub fn validate_withdraw_guard_threshold(
    withdraw_guard_threshold: u64,
    decimals: u32,
    oracle_price: i64,
) -> VelocityResult {
    // a zeroed/broken oracle would price any threshold at 0 notional
    validate!(
        withdraw_guard_threshold == 0 || oracle_price > 0,
        ErrorCode::InvalidOracle,
        "invalid oracle price ({}) for withdraw guard threshold",
        oracle_price
    )?;

    let notional = get_token_value(
        withdraw_guard_threshold.cast::<i128>()?,
        decimals,
        oracle_price,
    )?;

    validate!(
        notional <= MAX_WITHDRAW_GUARD_THRESHOLD_NOTIONAL.cast::<i128>()?,
        ErrorCode::WithdrawGuardThresholdNotionalTooLarge,
        "withdraw_guard_threshold notional ({}) exceeds max ({})",
        notional,
        MAX_WITHDRAW_GUARD_THRESHOLD_NOTIONAL
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::constants::PRICE_PRECISION_I64;

    #[test]
    fn withdraw_guard_threshold_notional_cap() {
        // $10k of USDC (6 decimals, $1) is allowed
        assert!(
            validate_withdraw_guard_threshold(10_000 * 10_u64.pow(6), 6, PRICE_PRECISION_I64)
                .is_ok()
        );

        // one base unit above $10k of USDC is rejected
        assert!(validate_withdraw_guard_threshold(
            10_000 * 10_u64.pow(6) + 1,
            6,
            PRICE_PRECISION_I64
        )
        .is_err());

        // 100 SOL (9 decimals) at $100 = $10k is allowed
        assert!(validate_withdraw_guard_threshold(
            100 * 10_u64.pow(9),
            9,
            100 * PRICE_PRECISION_I64
        )
        .is_ok());

        // 101 SOL at $100 is rejected
        assert!(validate_withdraw_guard_threshold(
            101 * 10_u64.pow(9),
            9,
            100 * PRICE_PRECISION_I64
        )
        .is_err());

        // the near-infinite exploit value is rejected
        assert!(validate_withdraw_guard_threshold(u64::MAX, 6, PRICE_PRECISION_I64).is_err());

        // zero disables the exemption entirely and is always allowed
        assert!(validate_withdraw_guard_threshold(0, 6, PRICE_PRECISION_I64).is_ok());

        // a zeroed or negative oracle price can't sneak a threshold through
        assert!(validate_withdraw_guard_threshold(1, 6, 0).is_err());
        assert!(validate_withdraw_guard_threshold(1, 6, -1).is_err());
        assert!(validate_withdraw_guard_threshold(0, 6, 0).is_ok());
    }
}
