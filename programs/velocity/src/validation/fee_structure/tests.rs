use crate::state::state::FeeStructure;
use crate::validation::fee_structure::validate_fee_structure;

#[test]
fn default_fee_structures() {
    // the shipped defaults must round-trip through their own validation —
    // fetch-modify-update admin flows revalidate the whole structure
    validate_fee_structure(&FeeStructure::perps_default()).unwrap();
    validate_fee_structure(&FeeStructure::spot_default()).unwrap();
}
