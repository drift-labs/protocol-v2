// Client-specific extensions for OracleAccountData
use super::super::lut_owner::LutOwner;
use crate::on_demand::accounts::OracleAccountData;

// Client-specific trait implementation
impl LutOwner for OracleAccountData {
    fn lut_slot(&self) -> u64 {
        self.lut_slot
    }
}
