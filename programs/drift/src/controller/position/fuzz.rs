use crate::controller::position::PositionDelta;
use arbitrary::{Arbitrary, Result, Unstructured};

impl<'a> Arbitrary<'a> for PositionDelta {
    fn arbitrary(u: &mut Unstructured<'a>) -> Result<Self> {
        let base_asset_amount = i64::arbitrary(u)?;
        let quote_asset_amount = i64::arbitrary(u)?.abs() * -base_asset_amount.signum();

        Ok(PositionDelta {
            base_asset_amount,
            quote_asset_amount,
        })
    }
}
