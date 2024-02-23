use std::cmp::Ordering;

use anchor_lang::AccountDeserialize;
use drift::error::ErrorCode;
// re-export types in public API
pub use drift::{
    controller::position::PositionDirection,
    state::{
        order_params::{ModifyOrderParams, OrderParams, PostOnlyParam},
        perp_market::PerpMarket,
        spot_market::SpotMarket,
        user::{MarketType, Order, OrderType, PerpPosition, SpotPosition},
    },
};
use futures_util::sink::Sink;
pub use solana_client::rpc_config::RpcSendTransactionConfig;
pub use solana_sdk::{commitment_config::CommitmentConfig, message::VersionedMessage};
use solana_sdk::{
    instruction::{AccountMeta, InstructionError},
    pubkey::Pubkey,
    transaction::TransactionError,
};
use thiserror::Error;
use tokio::net::TcpStream;
use tokio_tungstenite::{tungstenite, MaybeTlsStream, WebSocketStream};

pub type SdkResult<T> = Result<T, SdkError>;

/// Drift program context
#[derive(Debug, Copy, Clone)]
#[repr(u8)]
pub enum Context {
    /// Target DevNet
    DevNet,
    /// Target MaiNnet
    MainNet,
}

#[derive(Debug, Clone)]
pub struct DataAndSlot<T>
where
    T: AccountDeserialize,
{
    pub slot: u64,
    pub data: T,
}

/// Id of a Drift market
#[derive(Copy, Clone, Debug, Default, PartialEq)]
pub struct MarketId {
    pub(crate) index: u16,
    pub(crate) kind: MarketType,
}

impl MarketId {
    /// Id of a perp market
    pub const fn perp(index: u16) -> Self {
        Self {
            index,
            kind: MarketType::Perp,
        }
    }
    /// Id of a spot market
    pub const fn spot(index: u16) -> Self {
        Self {
            index,
            kind: MarketType::Spot,
        }
    }

    /// `MarketId` for the USDC Spot Market
    pub const QUOTE_SPOT: Self = Self {
        index: 0,
        kind: MarketType::Spot,
    };
}

impl From<(u16, MarketType)> for MarketId {
    fn from(value: (u16, MarketType)) -> Self {
        Self {
            index: value.0,
            kind: value.1,
        }
    }
}

/// Provides builder API for Orders
#[derive(Default)]
pub struct NewOrder {
    order_type: OrderType,
    direction: PositionDirection,
    reduce_only: bool,
    market_id: MarketId,
    post_only: PostOnlyParam,
    ioc: bool,
    amount: u64,
    price: u64,
}

impl NewOrder {
    /// Create a market order
    pub fn market(market_id: MarketId) -> Self {
        Self {
            order_type: OrderType::Market,
            market_id,
            ..Default::default()
        }
    }
    /// Create a limit order
    pub fn limit(market_id: MarketId) -> Self {
        Self {
            order_type: OrderType::Limit,
            market_id,
            ..Default::default()
        }
    }
    /// Set order amount
    ///
    /// A sub-zero amount indicates a short
    pub fn amount(mut self, amount: i64) -> Self {
        self.direction = if amount >= 0 {
            PositionDirection::Long
        } else {
            PositionDirection::Short
        };
        self.amount = amount.unsigned_abs();

        self
    }
    /// Set order price
    pub fn price(mut self, price: u64) -> Self {
        self.price = price;
        self
    }
    /// Set reduce only (default: false)
    pub fn reduce_only(mut self, flag: bool) -> Self {
        self.reduce_only = flag;
        self
    }
    /// Set immediate or cancel (default: false)
    pub fn ioc(mut self, flag: bool) -> Self {
        self.ioc = flag;
        self
    }
    /// Set post-only (default: None)
    pub fn post_only(mut self, value: PostOnlyParam) -> Self {
        self.post_only = value;
        self
    }
    /// Call to complete building the Order
    pub fn build(self) -> OrderParams {
        OrderParams {
            order_type: self.order_type,
            market_index: self.market_id.index,
            market_type: self.market_id.kind,
            price: self.price,
            base_asset_amount: self.amount,
            reduce_only: self.reduce_only,
            direction: self.direction,
            immediate_or_cancel: self.ioc,
            post_only: self.post_only,
            ..Default::default()
        }
    }
}

#[derive(Debug)]
pub struct SinkError(
    pub <WebSocketStream<MaybeTlsStream<TcpStream>> as Sink<tungstenite::Message>>::Error,
);

impl std::fmt::Display for SinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "WebSocket Sink Error: {}", self.0)
    }
}

impl std::error::Error for SinkError {}

impl From<SinkError> for SdkError {
    fn from(err: SinkError) -> Self {
        SdkError::SubscriptionFailure(err)
    }
}

#[derive(Debug, Error)]
pub enum SdkError {
    #[error("{0}")]
    Http(#[from] reqwest::Error),
    #[error("{0}")]
    Rpc(#[from] solana_client::client_error::ClientError),
    #[error("{0}")]
    Ws(#[from] solana_client::nonblocking::pubsub_client::PubsubClientError),
    #[error("{0}")]
    Anchor(#[from] Box<anchor_lang::error::Error>),
    #[error("error while deserializing")]
    Deserializing,
    #[error("invalid drift account")]
    InvalidAccount,
    #[error("invalid oracle account")]
    InvalidOracle,
    #[error("invalid keypair seed")]
    InvalidSeed,
    #[error("invalid base58 value")]
    InvalidBase58,
    #[error("user does not have position: {0}")]
    NoPosiiton(u16),
    #[error("insufficient SOL balance for fees")]
    OutOfSOL,
    #[error("{0}")]
    Signing(#[from] solana_sdk::signer::SignerError),
    #[error("WebSocket connection failed {0}")]
    ConnectionError(#[from] tungstenite::Error),
    #[error("Subscription failure: {0}")]
    SubscriptionFailure(SinkError),
    #[error("Received Error from websocket")]
    WebsocketError,
    #[error("Missed DLOB heartbeat")]
    MissedHeartbeat,
    #[error("Unsupported account data format")]
    UnsupportedAccountData,
    #[error("Could not decode data: {0}")]
    CouldntDecode(#[from] base64::DecodeError),
    #[error("Couldn't join task: {0}")]
    CouldntJoin(#[from] tokio::task::JoinError),
    #[error("Couldn't send unsubscribe message: {0}")]
    CouldntUnsubscribe(#[from] tokio::sync::mpsc::error::SendError<()>),
}

impl SdkError {
    /// extract anchor error code from the SdkError if it exists
    pub fn to_anchor_error_code(&self) -> Option<ErrorCode> {
        if let SdkError::Rpc(inner) = self {
            if let Some(TransactionError::InstructionError(_, InstructionError::Custom(code))) =
                inner.get_transaction_error()
            {
                // inverse of anchor's 'From<ErrorCode> for u32'
                return Some(unsafe {
                    std::mem::transmute(code - anchor_lang::error::ERROR_CODE_OFFSET)
                });
            }
        }
        None
    }
    /// convert to 'out of sol' error is possible
    pub fn to_out_of_sol_error(&self) -> Option<SdkError> {
        if let SdkError::Rpc(inner) = self {
            if let Some(
                TransactionError::InsufficientFundsForFee
                | TransactionError::InsufficientFundsForRent { account_index: _ },
            ) = inner.get_transaction_error()
            {
                return Some(Self::OutOfSOL);
            }
        }
        None
    }
}

/// Helper type for Accounts included in drift instructions
///
/// Provides sorting implementation matching drift program
#[derive(Copy, Clone, Debug, PartialEq, Eq, Ord)]
#[repr(u8)]
pub(crate) enum RemainingAccount {
    Oracle { pubkey: Pubkey },
    Spot { pubkey: Pubkey, writable: bool },
    Perp { pubkey: Pubkey, writable: bool },
}

impl RemainingAccount {
    fn pubkey(&self) -> &Pubkey {
        match self {
            Self::Oracle { pubkey } => pubkey,
            Self::Spot { pubkey, .. } => pubkey,
            Self::Perp { pubkey, .. } => pubkey,
        }
    }
    fn parts(self) -> (Pubkey, bool) {
        match self {
            Self::Oracle { pubkey } => (pubkey, false),
            Self::Spot {
                pubkey, writable, ..
            } => (pubkey, writable),
            Self::Perp {
                pubkey, writable, ..
            } => (pubkey, writable),
        }
    }
    fn discriminant(&self) -> u8 {
        // SAFETY: Because `Self` is marked `repr(u8)`, its layout is a `repr(C)` `union`
        // between `repr(C)` structs, each of which has the `u8` discriminant as its first
        // field, so we can read the discriminant without offsetting the pointer.
        unsafe { *<*const _>::from(self).cast::<u8>() }
    }
}

impl PartialOrd for RemainingAccount {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        let type_order = self.discriminant().cmp(&other.discriminant());
        if let Ordering::Equal = type_order {
            self.pubkey().partial_cmp(other.pubkey())
        } else {
            Some(type_order)
        }
    }
}

impl From<RemainingAccount> for AccountMeta {
    fn from(value: RemainingAccount) -> Self {
        let (pubkey, is_writable) = value.parts();
        AccountMeta {
            pubkey,
            is_writable,
            is_signer: false,
        }
    }
}

/// Provide market precision information
pub trait MarketPrecision {
    // prices must be a multiple of this
    fn price_tick(&self) -> u64;
    // order sizes must be a multiple of this
    fn quantity_tick(&self) -> u64;
    /// smallest order size
    fn min_order_size(&self) -> u64;
}

impl MarketPrecision for SpotMarket {
    fn min_order_size(&self) -> u64 {
        self.min_order_size
    }
    fn price_tick(&self) -> u64 {
        self.order_tick_size
    }
    fn quantity_tick(&self) -> u64 {
        self.order_step_size
    }
}

impl MarketPrecision for PerpMarket {
    fn min_order_size(&self) -> u64 {
        self.amm.min_order_size
    }
    fn price_tick(&self) -> u64 {
        self.amm.order_tick_size
    }
    fn quantity_tick(&self) -> u64 {
        self.amm.order_step_size
    }
}

#[derive(Clone)]
pub struct ClientOpts {
    active_sub_account_id: u16,
    sub_account_ids: Vec<u16>,
}

impl Default for ClientOpts {
    fn default() -> Self {
        Self {
            active_sub_account_id: 0,
            sub_account_ids: vec![0],
        }
    }
}

impl ClientOpts {
    pub fn new(active_sub_account_id: u16, sub_account_ids: Option<Vec<u16>>) -> Self {
        let sub_account_ids = sub_account_ids.unwrap_or(vec![active_sub_account_id]);
        Self {
            active_sub_account_id,
            sub_account_ids,
        }
    }

    pub fn active_sub_account_id(&self) -> u16 {
        self.active_sub_account_id
    }

    pub fn sub_account_ids(self) -> Vec<u16> {
        self.sub_account_ids
    }
}

pub struct ReferrerInfo {
    referrer: Pubkey,
    referrer_stats: Pubkey,
}

impl ReferrerInfo {
    pub fn new(referrer: Pubkey, referrer_stats: Pubkey) -> Self {
        Self {
            referrer,
            referrer_stats,
        }
    }

    pub fn referrer(&self) -> Pubkey {
        self.referrer
    }

    pub fn referrer_stats(&self) -> Pubkey {
        self.referrer_stats
    }
}

#[cfg(test)]
mod tests {
    use drift::error::ErrorCode;
    use solana_client::{
        client_error::{ClientError, ClientErrorKind},
        rpc_request::{RpcError, RpcRequest},
        rpc_response::RpcSimulateTransactionResult,
    };
    use solana_sdk::{
        instruction::InstructionError, pubkey::Pubkey, transaction::TransactionError,
    };

    use super::{RemainingAccount, SdkError};

    #[test]
    fn extract_anchor_error() {
        let err = SdkError::Rpc(
            ClientError {
                request: Some(RpcRequest::SendTransaction),
                kind: ClientErrorKind::RpcError(
                    RpcError::RpcResponseError {
                        code: -32002,
                        message: "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x17b7".to_string(),
                        data: solana_client::rpc_request::RpcResponseErrorData::SendTransactionPreflightFailure(
                            RpcSimulateTransactionResult {
                                err: Some(TransactionError::InstructionError(0, InstructionError::Custom(6071))),
                                logs: None,
                                accounts: None,
                                units_consumed: None,
                                return_data: None,
                            }
                        )
                    }
                )
            }
        );

        assert_eq!(
            err.to_anchor_error_code().unwrap(),
            ErrorCode::UserOrderIdAlreadyInUse,
        );
    }

    #[test]
    fn account_type_sorting() {
        let mut accounts = vec![
            RemainingAccount::Perp {
                pubkey: Pubkey::new_from_array([4_u8; 32]),
                writable: false,
            },
            RemainingAccount::Oracle {
                pubkey: Pubkey::new_from_array([2_u8; 32]),
            },
            RemainingAccount::Oracle {
                pubkey: Pubkey::new_from_array([1_u8; 32]),
            },
            RemainingAccount::Spot {
                pubkey: Pubkey::new_from_array([3_u8; 32]),
                writable: true,
            },
        ];
        accounts.sort();

        assert_eq!(
            accounts,
            vec![
                RemainingAccount::Oracle {
                    pubkey: Pubkey::new_from_array([1_u8; 32])
                },
                RemainingAccount::Oracle {
                    pubkey: Pubkey::new_from_array([2_u8; 32])
                },
                RemainingAccount::Spot {
                    pubkey: Pubkey::new_from_array([3_u8; 32]),
                    writable: true
                },
                RemainingAccount::Perp {
                    pubkey: Pubkey::new_from_array([4_u8; 32]),
                    writable: false
                },
            ]
        )
    }
}
