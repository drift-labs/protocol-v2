use crate::state::state::FeeStructure;
use crate::validation::fee_structure::validate_fee_structure;

#[test]
fn default_fee_structures() {
    let mut default_perp_fees = FeeStructure::perps_default();
    default_perp_fees.flat_filler_fee = 3333;
    validate_fee_structure(&default_perp_fees).unwrap();

    let mut default_spot_fees = FeeStructure::spot_default();
    default_spot_fees.flat_filler_fee = 3333;
    validate_fee_structure(&default_spot_fees).unwrap();
}
