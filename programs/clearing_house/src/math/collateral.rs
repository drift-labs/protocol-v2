use crate::error::*;
use crate::math_error;
use solana_program::msg;

pub fn calculate_updated_collateral(collateral: u128, pnl: i128) -> ClearingHouseResult<u128> {
    Ok(if pnl.is_negative() && pnl.unsigned_abs() > collateral {
        0
    } else if pnl > 0 {
        collateral
            .checked_add(pnl.unsigned_abs())
            .ok_or_else(math_error!())?
    } else {
        collateral
            .checked_sub(pnl.unsigned_abs())
            .ok_or_else(math_error!())?
    })
}
