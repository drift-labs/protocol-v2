#[cfg(not(feature = "anchor"))]
use std::fmt;

#[cfg(feature = "anchor")]
use anchor_lang::prelude::*;
use serde::ser::StdError;

/// Error types for Switchboard On-Demand Oracle operations
#[cfg_attr(feature = "anchor", error_code)]
#[cfg_attr(not(feature = "anchor"), derive(Clone, Debug))]
#[cfg_attr(not(feature = "anchor"), repr(u32))]
pub enum OnDemandError {
    /// Generic error without specific context
    Generic,
    /// Failed to borrow account data from RefCell
    AccountBorrowError,
    /// Oracle account not found or invalid
    AccountNotFound,
    /// Anchor framework parsing error
    AnchorParse,
    /// Anchor parsing error with additional context
    AnchorParseError,
    /// Account size validation failed
    CheckSizeError,
    /// Failed to convert numeric value to decimal
    DecimalConversionError,
    /// Decryption operation failed
    DecryptError,
    /// Event listener background process failed
    EventListenerRoutineFailure,
    /// Ethereum Virtual Machine error
    EvmError,
    /// Function result instruction targets wrong blockchain
    FunctionResultIxIncorrectTargetChain,
    /// Oracle heartbeat process failed
    HeartbeatRoutineFailure,
    /// Integer arithmetic overflow occurred
    IntegerOverflowError,
    /// Invalid blockchain or network specified
    InvalidChain,
    /// Data format is invalid or corrupted
    InvalidData,
    /// Account discriminator doesn't match expected value
    InvalidDiscriminator,
    /// Solana instruction format is invalid
    InvalidInstructionError,
    /// Keypair file format is invalid or corrupted
    InvalidKeypairFile,
    /// Native SOL mint account is invalid
    InvalidNativeMint,
    /// Oracle quote data is invalid or corrupted
    InvalidQuote,
    /// Oracle quote validation failed with additional context
    InvalidQuoteError,
    /// Oracle signature verification failed
    InvalidSignature,
    /// Storage network communication error
    StorageNetworkError,
    /// Failed to parse storage data or response
    StorageParseError,
    /// Cryptographic key parsing failed
    KeyParseError,
    /// TEE enclave measurement doesn't match expected value
    MrEnclaveMismatch,
    /// Network or RPC communication error
    NetworkError,
    /// General parsing error
    ParseError,
    /// Program Derived Address derivation failed
    PdaDerivationError,
    /// Failed to parse oracle quote data
    QuoteParseError,
    /// Quote Verification Network transaction send failed
    QvnTxSendFailure,
    /// Intel SGX trusted execution environment error
    SgxError,
    /// Failed to write to SGX enclave
    SgxWriteError,
    /// Solana blockhash related error
    SolanaBlockhashError,
    /// Required Solana transaction signer is missing
    SolanaMissingSigner,
    /// Transaction payer signer is missing
    SolanaPayerSignerMissing,
    /// Transaction payer doesn't match expected account
    SolanaPayerMismatch,
    /// Too many instructions in Solana transaction
    SolanaInstructionOverflow,
    /// Solana transaction has no instructions
    SolanaInstructionsEmpty,
    /// Transaction compilation failed
    TxCompileErr,
    /// Transaction deserialization failed
    TxDeserializationError,
    /// Transaction execution failed on-chain
    TxFailure,
    /// Unexpected error condition
    Unexpected,
    /// Solana transaction signing failed
    SolanaSignError,
    /// Input/output operation failed
    IoError,
    /// Cryptographic key derivation failed
    KeyDerivationFailed,
    /// Secret key format is invalid
    InvalidSecretKey,
    /// Required environment variable is missing
    EnvVariableMissing,
    /// Account data deserialization failed
    AccountDeserializeError,
    /// Insufficient oracle samples for reliable data
    NotEnoughSamples,
    /// Oracle feed value is outside acceptable bounds
    IllegalFeedValue,
    /// Switchboard randomness value is too old to use
    SwitchboardRandomnessTooOld,
    /// Failed to fetch address lookup table
    AddressLookupTableFetchError,
    /// Failed to deserialize address lookup table
    AddressLookupTableDeserializeError,
    /// Data size is invalid for the operation
    InvalidSize,
    /// Oracle data is older than maximum allowed age
    StaleResult,
}

impl StdError for OnDemandError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        None
    }
}
#[cfg(not(feature = "anchor"))]
impl fmt::Display for OnDemandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OnDemandError::AccountNotFound => {
                write!(f, "Oracle account not found. Ensure the account exists and is properly initialized.")
            }
            OnDemandError::InvalidDiscriminator => {
                write!(
                    f,
                    "Invalid account discriminator. This may not be a Switchboard oracle account."
                )
            }
            OnDemandError::InvalidQuote => {
                write!(f, "Invalid oracle quote. The quote may be expired, tampered with, or from an unauthorized oracle.")
            }
            OnDemandError::NotEnoughSamples => {
                write!(f, "Insufficient oracle samples for reliable data. Consider lowering min_samples or waiting for more oracles to respond.")
            }
            OnDemandError::StaleResult => {
                write!(f, "Oracle data is stale. The data is older than the maximum allowed age. Try increasing max_stale_slots or wait for fresh data.")
            }
            OnDemandError::InvalidSignature => {
                write!(f, "Invalid oracle signature. The oracle may not be authorized or the data may be corrupted.")
            }
            OnDemandError::NetworkError => {
                write!(f, "Network error occurred while fetching oracle data. Check your RPC connection and try again.")
            }
            OnDemandError::AccountDeserializeError => {
                write!(f, "Failed to deserialize oracle account data. The account format may be invalid or corrupted.")
            }
            OnDemandError::DecimalConversionError => {
                write!(f, "Failed to convert oracle value to decimal. The numeric value may be out of range or invalid.")
            }
            OnDemandError::InvalidData => {
                write!(f, "Invalid oracle data detected. The data format or content is malformed or corrupted.")
            }
            OnDemandError::IllegalFeedValue => {
                write!(f, "Illegal feed value encountered. The oracle reported a value that is outside acceptable bounds.")
            }
            OnDemandError::SwitchboardRandomnessTooOld => {
                write!(f, "Switchboard randomness is too old. Request fresh randomness for current operations.")
            }
            _ => write!(f, "Switchboard oracle error: {:#?}", self),
        }
    }
}
