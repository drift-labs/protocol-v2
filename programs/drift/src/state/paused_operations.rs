use solana_program::msg;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum PerpOperation {
    UpdateFunding = 0b00000001,
    AmmFill = 0b00000010,
    Fill = 0b00000100,
    SettlePnl = 0b00001000,
    SettlePnlWithPosition = 0b00010000,
}

const ALL_PERP_OPERATIONS: [PerpOperation; 5] = [
    PerpOperation::UpdateFunding,
    PerpOperation::AmmFill,
    PerpOperation::Fill,
    PerpOperation::SettlePnl,
    PerpOperation::SettlePnlWithPosition,
];

impl PerpOperation {
    pub fn is_operation_paused(current: u8, operation: PerpOperation) -> bool {
        current & operation as u8 != 0
    }

    pub fn log_all_operations_paused(current: u8) {
        for operation in ALL_PERP_OPERATIONS.iter() {
            if Self::is_operation_paused(current, *operation) {
                msg!("{:?} is paused", operation);
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum SpotOperation {
    UpdateCumulativeInterest = 0b00000001,
    Fill = 0b00000010,
    Withdraw = 0b00000100,
}

const ALL_SPOT_OPERATIONS: [SpotOperation; 3] = [
    SpotOperation::UpdateCumulativeInterest,
    SpotOperation::Fill,
    SpotOperation::Withdraw,
];

impl SpotOperation {
    pub fn is_operation_paused(current: u8, operation: SpotOperation) -> bool {
        current & operation as u8 != 0
    }

    pub fn log_all_operations_paused(current: u8) {
        for operation in ALL_SPOT_OPERATIONS.iter() {
            if Self::is_operation_paused(current, *operation) {
                msg!("{:?} is paused", operation);
            }
        }
    }
}
