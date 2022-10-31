use crate::state::state::FeeStructure;
use crate::validation::fee_structure::validate_fee_structure;

#[test]
fn default_fee_structures() {
    validate_fee_structure(&FeeStructure::perps_default()).unwrap();

    validate_fee_structure(&FeeStructure::spot_default()).unwrap();
}
