#[cfg(test)]
mod tests;

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum PerpOperations {
    UpdateFunding = 0b00000001,
    AmmFill = 0b00000010,
    Fill = 0b00000100,
    SettlePnl = 0b00001000,
    SettlePnlWithPosition = 0b00010000,
}

impl PerpOperations {
    pub fn is_operation_paused(current: u8, operation: PerpOperations) -> bool {
        current & operation as u8 != 0
    }
}

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum SpotOperations {
    UpdateCumulativeInterest = 0b00000001,
    Fill = 0b00000010,
    Withdraw = 0b00000100,
}

impl SpotOperations {
    pub fn is_operation_paused(current: u8, operation: SpotOperations) -> bool {
        current & operation as u8 != 0
    }
}
