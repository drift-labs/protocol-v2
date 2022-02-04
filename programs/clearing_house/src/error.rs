use anchor_lang::prelude::*;

pub type ClearingHouseResult<T = ()> = std::result::Result<T, ErrorCode>;

#[error]
pub enum ErrorCode {
    /// 6000
    #[msg("Clearing house not collateral account owner")]
    InvalidCollateralAccountAuthority,
    /// 6001
    #[msg("Clearing house not insurance account owner")]
    InvalidInsuranceAccountAuthority,
    /// 6002
    #[msg("Insufficient deposit")]
    InsufficientDeposit,
    /// 6003
    #[msg("Insufficient collateral")]
    InsufficientCollateral,
    /// 6004
    #[msg("Sufficient collateral")]
    SufficientCollateral,
    /// 6005
    #[msg("Max number of positions taken")]
    MaxNumberOfPositions,
    /// 6006
    #[msg("Admin Controls Prices Disabled")]
    AdminControlsPricesDisabled,
    /// 6007
    #[msg("Market Index Not Initialized")]
    MarketIndexNotInitialized,
    /// 6008
    #[msg("Market Index Already Initialized")]
    MarketIndexAlreadyInitialized,
    /// 6009
    #[msg("User Account And User Positions Account Mismatch")]
    UserAccountAndUserPositionsAccountMismatch,
    /// 6010
    #[msg("User Has No Position In Market")]
    UserHasNoPositionInMarket,
    /// 6011
    #[msg("Invalid Initial Peg")]
    InvalidInitialPeg,
    /// 6012
    #[msg("AMM repeg already configured with amt given")]
    InvalidRepegRedundant,
    /// 6013
    #[msg("AMM repeg incorrect repeg direction")]
    InvalidRepegDirection,
    /// 6014
    #[msg("AMM repeg out of bounds pnl")]
    InvalidRepegProfitability,
    /// 6015
    #[msg("Slippage Outside Limit Price")]
    SlippageOutsideLimit,
    /// 6016
    #[msg("Trade Size Too Small")]
    TradeSizeTooSmall,
    /// 6017
    #[msg("Price change too large when updating K")]
    InvalidUpdateK,
    /// 6018
    #[msg("Admin tried to withdraw amount larger than fees collected")]
    AdminWithdrawTooLarge,
    /// 6019
    #[msg("Math Error")]
    MathError,
    /// 6020
    #[msg("Conversion to u128/u64 failed with an overflow or underflow")]
    BnConversionError,
    /// 6021
    #[msg("Clock unavailable")]
    ClockUnavailable,
    /// 6022
    #[msg("Unable To Load Oracles")]
    UnableToLoadOracle,
    /// 6023
    #[msg("Oracle/Mark Spread Too Large")]
    OracleMarkSpreadLimit,
    /// 6024
    #[msg("Clearing House history already initialized")]
    HistoryAlreadyInitialized,
    /// 6025
    #[msg("Exchange is paused")]
    ExchangePaused,
    /// 6026
    #[msg("Invalid whitelist token")]
    InvalidWhitelistToken,
    /// 6027
    #[msg("Whitelist token not found")]
    WhitelistTokenNotFound,
    /// 6028
    #[msg("Invalid discount token")]
    InvalidDiscountToken,
    /// 6029
    #[msg("Discount token not found")]
    DiscountTokenNotFound,
    /// 6030
    #[msg("Invalid referrer")]
    InvalidReferrer,
    /// 6031
    #[msg("Referrer not found")]
    ReferrerNotFound,
    /// 6032
    #[msg("InvalidOracle")]
    InvalidOracle,
    /// 6033
    #[msg("OracleNotFound")]
    OracleNotFound,
    /// 6034
    #[msg("Liquidations Blocked By Oracle")]
    LiquidationsBlockedByOracle,
    /// 6035
    #[msg("Can not deposit more than max deposit")]
    UserMaxDeposit,
    /// 6036
    #[msg("Can not delete user that still has collateral")]
    CantDeleteUserWithCollateral,
    /// 6037
    #[msg("AMM funding out of bounds pnl")]
    InvalidFundingProfitability,
    /// 6038
    #[msg("Casting Failure")]
    CastingFailure,
}

#[macro_export]
macro_rules! wrap_error {
    ($err:expr) => {{
        || {
            msg!("Error thrown at {}:{}", file!(), line!());
            $err
        }
    }};
}

#[macro_export]
macro_rules! math_error {
    () => {{
        || {
            let error_code = ErrorCode::MathError;
            msg!("Error {} thrown at {}:{}", error_code, file!(), line!());
            error_code
        }
    }};
}
