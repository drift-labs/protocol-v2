use crate::msg;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum PerpOperation {
    UpdateFunding = 0b00000001,
    AmmFill = 0b00000010,
    Fill = 0b00000100,
    SettlePnl = 0b00001000,
    SettlePnlWithPosition = 0b00010000,
    Liquidation = 0b00100000,
    AmmImmediateFill = 0b01000000,
}

const ALL_PERP_OPERATIONS: [PerpOperation; 7] = [
    PerpOperation::UpdateFunding,
    PerpOperation::AmmFill,
    PerpOperation::Fill,
    PerpOperation::SettlePnl,
    PerpOperation::SettlePnlWithPosition,
    PerpOperation::Liquidation,
    PerpOperation::AmmImmediateFill,
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
    Deposit = 0b00000100,
    Withdraw = 0b00001000,
    Liquidation = 0b00010000,
}

const ALL_SPOT_OPERATIONS: [SpotOperation; 5] = [
    SpotOperation::UpdateCumulativeInterest,
    SpotOperation::Fill,
    SpotOperation::Deposit,
    SpotOperation::Withdraw,
    SpotOperation::Liquidation,
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

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum InsuranceFundOperation {
    Init = 0b00000001,
    Add = 0b00000010,
    RequestRemove = 0b00000100,
    Remove = 0b00001000,
}

const ALL_IF_OPERATIONS: [InsuranceFundOperation; 4] = [
    InsuranceFundOperation::Init,
    InsuranceFundOperation::Add,
    InsuranceFundOperation::RequestRemove,
    InsuranceFundOperation::Remove,
];

impl InsuranceFundOperation {
    pub fn is_operation_paused(current: u8, operation: InsuranceFundOperation) -> bool {
        current & operation as u8 != 0
    }

    pub fn log_all_operations_paused(current: u8) {
        for operation in ALL_IF_OPERATIONS.iter() {
            if Self::is_operation_paused(current, *operation) {
                msg!("{:?} is paused", operation);
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum PerpLpOperation {
    TrackAmmRevenue = 0b00000001,
    SettleQuoteOwed = 0b00000010,
}

const ALL_PERP_LP_OPERATIONS: [PerpLpOperation; 2] = [
    PerpLpOperation::TrackAmmRevenue,
    PerpLpOperation::SettleQuoteOwed,
];

impl PerpLpOperation {
    pub fn is_operation_paused(current: u8, operation: PerpLpOperation) -> bool {
        current & operation as u8 != 0
    }

    pub fn log_all_operations_paused(current: u8) {
        for operation in ALL_PERP_LP_OPERATIONS.iter() {
            if Self::is_operation_paused(current, *operation) {
                msg!("{:?} is paused", operation);
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum ConstituentLpOperation {
    Swap = 0b00000001,
    Deposit = 0b00000010,
    Withdraw = 0b00000100,
}

const ALL_CONSTITUENT_LP_OPERATIONS: [ConstituentLpOperation; 3] = [
    ConstituentLpOperation::Swap,
    ConstituentLpOperation::Deposit,
    ConstituentLpOperation::Withdraw,
];

impl ConstituentLpOperation {
    pub fn is_operation_paused(current: u8, operation: ConstituentLpOperation) -> bool {
        current & operation as u8 != 0
    }

    pub fn log_all_operations_paused(current: u8) {
        for operation in ALL_CONSTITUENT_LP_OPERATIONS.iter() {
            if Self::is_operation_paused(current, *operation) {
                msg!("{:?} is paused", operation);
            }
        }
    }
}
