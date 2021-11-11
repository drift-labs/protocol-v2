use anchor_lang::prelude::*;

pub type ClearingHouseResult<T = ()> = std::result::Result<T, ErrorCode>;

#[error]
pub enum ErrorCode {
    #[msg("Clearing house not collateral account owner")]
    InvalidCollateralAccountAuthority,
    #[msg("Clearing house not insurance account owner")]
    InvalidInsuranceAccountAuthority,
    #[msg("Insufficient deposit")]
    InsufficientDeposit,
    #[msg("Insufficient collateral")]
    InsufficientCollateral,
    #[msg("Sufficient collateral")]
    SufficientCollateral,
    #[msg("Max number of positions taken")]
    MaxNumberOfPositions,
    #[msg("Admin Controls Prices Disabled")]
    AdminControlsPricesDisabled,
    #[msg("Market Index Not Initialized")]
    MarketIndexNotInitialized,
    #[msg("Market Index Already Initialized")]
    MarketIndexAlreadyInitialized,
    #[msg("User Account And User Positions Account Mismatch")]
    UserAccountAndUserPositionsAccountMismatch,
    #[msg("User Has No Position In Market")]
    UserHasNoPositionInMarket,
    #[msg("Invalid Initial Peg")]
    InvalidInitialPeg,
    #[msg("AMM repeg already configured with amt given")]
    InvalidRepegRedundant,
    #[msg("AMM repeg incorrect repeg direction")]
    InvalidRepegDirection,
    #[msg("AMM repeg out of bounds pnl")]
    InvalidRepegProfitability,
    #[msg("Slippage Outside Limit Price")]
    SlippageOutsideLimit,
    #[msg("Trade Size Too Small")]
    TradeSizeTooSmall,
    #[msg("Price change too large when updating K")]
    InvalidUpdateK,
    #[msg("Admin tried to withdraw amount larger than fees collected")]
    AdminWithdrawTooLarge,
    #[msg("Math Error")]
    MathError,
    #[msg("Conversion to u128/u64 failed with an overflow or underflow")]
    BnConversionError,
    #[msg("Clock unavailable")]
    ClockUnavailable,
    #[msg("Unable To Load Oracles")]
    UnableToLoadOracle,
    #[msg("Oracle/Mark Spread Too Large")]
    OracleMarkSpreadLimit,
    #[msg("Clearing House history already initialized")]
    HistoryAlreadyInitialized,
    #[msg("Exchange is paused")]
    ExchangePaused,
    #[msg("Invalid whitelist token")]
    InvalidWhitelistToken,
    #[msg("Whitelist token not found")]
    WhitelistTokenNotFound,
    #[msg("Invalid discount token")]
    InvalidDiscountToken,
    #[msg("Discount token not found")]
    DiscountTokenNotFound,
    #[msg("Invalid referrer")]
    InvalidReferrer,
    #[msg("Referrer not found")]
    ReferrerNotFound,
    #[msg("InvalidOracle")]
    InvalidOracle,
    #[msg("OracleNotFound")]
    OracleNotFound,
    #[msg("Liquidations Blocked By Oracle")]
    LiquidationsBlockedByOracle,
    #[msg("Can not deposit more than max deposit")]
    UserMaxDeposit,
    #[msg("Can not delete user that still has collateral")]
    CantDeleteUserWithCollateral,
    #[msg("AMM funding out of bounds pnl")]
    InvalidFundingProfitability,
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
