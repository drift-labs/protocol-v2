// Client-specific extensions for PullFeedAccountData
use super::super::lut_owner::LutOwner;
use crate::on_demand::accounts::PullFeedAccountData;

// Client-specific trait implementation
impl LutOwner for PullFeedAccountData {
    fn lut_slot(&self) -> u64 {
        self.lut_slot
    }
}
