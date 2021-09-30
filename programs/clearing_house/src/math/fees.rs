pub fn calculate(quote_asset_amount: u128, fee_numerator: u128, fee_denominator: u128) -> u128 {
    return quote_asset_amount
        .checked_mul(fee_numerator)
        .unwrap()
        .checked_div(fee_denominator)
        .unwrap();
}