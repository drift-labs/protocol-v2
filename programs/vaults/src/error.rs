use anchor_lang::prelude::*;

use drift::error::ErrorCode as DriftErrorCode;

pub type VaultResult<T = ()> = std::result::Result<T, ErrorCode>;

#[error_code]
#[derive(PartialEq, Eq)]
pub enum ErrorCode {
    #[msg("Default")]
    Default,
    #[msg("InvalidVaultRebase")]
    InvalidVaultRebase,
    #[msg("InvalidVaultSharesDetected")]
    InvalidVaultSharesDetected,
    #[msg("CannotWithdrawBeforeRedeemPeriodEnd")]
    CannotWithdrawBeforeRedeemPeriodEnd,
    #[msg("InvalidVaultWithdraw")]
    InvalidVaultWithdraw,
    #[msg("InsufficientVaultShares")]
    InsufficientVaultShares,
    #[msg("InvalidVaultWithdrawSize")]
    InvalidVaultWithdrawSize,
    #[msg("InvalidVaultForNewDepositors")]
    InvalidVaultForNewDepositors,
    #[msg("VaultWithdrawRequestInProgress")]
    VaultWithdrawRequestInProgress,
    #[msg("VaultIsAtCapacity")]
    VaultIsAtCapacity,
    #[msg("InvalidVaultDepositorInitialization")]
    InvalidVaultDepositorInitialization,
    #[msg("DelegateNotAvailableForLiquidation")]
    DelegateNotAvailableForLiquidation,
    #[msg("InvalidEquityValue")]
    InvalidEquityValue,
    #[msg("VaultInLiquidation")]
    VaultInLiquidation,
    #[msg("DriftError")]
    DriftError,
    #[msg("InvalidVaultInitialization")]
    InvalidVaultInitialization,
    #[msg("InvalidVaultUpdate")]
    InvalidVaultUpdate,
    #[msg("PermissionedVault")]
    PermissionedVault,
    #[msg("WithdrawInProgress")]
    WithdrawInProgress,
    #[msg("SharesPercentTooLarge")]
    SharesPercentTooLarge,
    #[msg("InvalidVaultDeposit")]
    InvalidVaultDeposit,
    #[msg("OngoingLiquidation")]
    OngoingLiquidation,
    #[msg("VaultProtocolMissing")]
    VaultProtocolMissing,
    #[msg("InvalidTokenization")]
    InvalidTokenization,
    #[msg("FeeUpdateMissing")]
    FeeUpdateMissing,
    #[msg("InvalidFeeUpdateStatus")]
    InvalidFeeUpdateStatus,
    #[msg("InvalidVaultClass")]
    InvalidVaultClass,
    #[msg("InvalidBorrowAmount")]
    InvalidBorrowAmount,
    #[msg("InvalidRepayAmount")]
    InvalidRepayAmount,
}

impl From<DriftErrorCode> for ErrorCode {
    fn from(_: DriftErrorCode) -> Self {
        ErrorCode::DriftError
    }
}
