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
    #[msg("Invalid Order")]
    InvalidOrder,
    #[msg("User has no order")]
    UserHasNoOrder,
    #[msg("Order Amount Too Small")]
    OrderAmountTooSmall,
    #[msg("Max number of orders taken")]
    MaxNumberOfOrders,
    #[msg("Order does not exist")]
    OrderDoesNotExist,
    #[msg("Order not open")]
    OrderNotOpen,
    #[msg("CouldNotFillOrder")]
    CouldNotFillOrder,
    #[msg("Reduce only order increased risk")]
    ReduceOnlyOrderIncreasedRisk,
    #[msg("Order state already initialized")]
    OrderStateAlreadyInitialized,
    #[msg("Unable to load AccountLoader")]
    UnableToLoadAccountLoader,
    #[msg("Trade Size Too Large")]
    TradeSizeTooLarge,
    #[msg("Unable to write to remaining account")]
    UnableToWriteToRemainingAccount,
    #[msg("User cant refer themselves")]
    UserCantReferThemselves,
    #[msg("Did not receive expected referrer")]
    DidNotReceiveExpectedReferrer,
    #[msg("Could not deserialize referrer")]
    CouldNotDeserializeReferrer,
    #[msg("Market order must be in place and fill")]
    MarketOrderMustBeInPlaceAndFill,
    #[msg("User Order Id Already In Use")]
    UserOrderIdAlreadyInUse,
    #[msg("No positions liquidatable")]
    NoPositionsLiquidatable,
    #[msg("Invalid Margin Ratio")]
    InvalidMarginRatio,
    #[msg("Cant Cancel Post Only Order")]
    CantCancelPostOnlyOrder,
    #[msg("InvalidOracleOffset")]
    InvalidOracleOffset,
    #[msg("CantExpireOrders")]
    CantExpireOrders,
    #[msg("AMM repeg mark price impact vs oracle too large")]
    InvalidRepegPriceImpact,
}

#[macro_export]
macro_rules! print_error {
    ($err:expr) => {{
        || {
            let error_code: ErrorCode = $err;
            msg!("{:?} thrown at {}:{}", error_code, file!(), line!());
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
