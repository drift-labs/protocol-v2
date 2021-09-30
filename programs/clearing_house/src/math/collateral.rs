pub fn calculate_updated_collateral(collateral: u128, pnl: i128) -> u128 {
    return if pnl.is_negative() && pnl.unsigned_abs() > collateral {
        0
    } else if pnl > 0 {
        collateral.checked_add(pnl.unsigned_abs()).unwrap()
    } else {
        collateral.checked_sub(pnl.unsigned_abs()).unwrap()
    };
}
