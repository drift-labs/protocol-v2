use std::cmp::Ordering;

use drift_program::error::ErrorCode;
// re-export types in public API
pub use drift_program::{
    controller::position::PositionDirection,
    state::{
        order_params::{OrderParams, PostOnlyParam},
        spot_market::SpotMarket,
        user::{MarketType, Order, OrderType, PerpPosition, SpotPosition},
    },
};
use solana_sdk::{
    instruction::{AccountMeta, InstructionError},
    pubkey::Pubkey,
    transaction::TransactionError,
};
use thiserror::Error;

use crate::constants::{perp_market_configs, spot_market_configs};

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

/// Id of a Drift market
#[derive(Copy, Clone, Debug, Default, PartialEq)]
pub struct MarketId {
    pub(crate) index: u16,
    pub(crate) kind: MarketType,
}

impl MarketId {
    /// Lookup a market id by context and symbol
    ///
    /// This operation is not free so lookups should be reused/cached by the caller
    ///
    /// Returns an error if symbol and context do not map to a known market
    pub fn lookup(context: Context, symbol: &str) -> Result<Self, ()> {
        let mut parts = symbol.split('-');
        match (parts.next(), parts.next()) {
            (Some(base), None) => {
                let markets = spot_market_configs(context);
                if let Some(market) = markets.iter().find(|m| m.symbol.eq_ignore_ascii_case(base)) {
                    return Ok(MarketId::spot(market.market_index));
                }
            }
            (Some(base), Some(perp)) => {
                if perp.eq_ignore_ascii_case("perp") {
                    let markets = perp_market_configs(context);
                    if let Some(market) = markets
                        .iter()
                        .find(|m| m.base_asset_symbol.eq_ignore_ascii_case(base))
                    {
                        return Ok(MarketId::perp(market.market_index));
                    }
                }
            }
            _ => (),
        }

        Err(())
    }
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
    post_only: bool,
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
    /// Set post-only (default: false)
    pub fn post_only(mut self, flag: bool) -> Self {
        self.post_only = flag; // TODO: map the other variants
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
            post_only: if self.post_only {
                PostOnlyParam::TryPostOnly
            } else {
                PostOnlyParam::None
            },
            ..Default::default()
        }
    }
}

#[derive(Debug, Error)]
pub enum SdkError {
    #[error("http fail")]
    Http(#[from] reqwest::Error),
    #[error("rpc fail")]
    Rpc(#[from] solana_client::client_error::ClientError),
    #[error("ws fail")]
    Ws(#[from] solana_client::nonblocking::pubsub_client::PubsubClientError),
    #[error("error while deserializing")]
    Deserializing,
    #[error("invalid drift account")]
    InvalidAccount,
    #[error("invalid keypair seed")]
    InvalidSeed,
    #[error("invalid base58 value")]
    InvalidBase58,
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

#[cfg(test)]
mod tests {
    use drift_program::error::ErrorCode;
    use solana_client::{
        client_error::{ClientError, ClientErrorKind},
        rpc_request::{RpcError, RpcRequest},
        rpc_response::RpcSimulateTransactionResult,
    };
    use solana_sdk::{
        instruction::InstructionError, pubkey::Pubkey, transaction::TransactionError,
    };

    use super::{Context, MarketId, RemainingAccount, SdkError};

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
    fn market_id_lookups() {
        for (context, symbol, expected) in &[
            (Context::DevNet, "wBTC", MarketId::spot(2)),
            (Context::DevNet, "SOL", MarketId::spot(1)),
            (Context::DevNet, "sol-perp", MarketId::perp(0)),
            (Context::MainNet, "wbtc", MarketId::spot(3)),
            (Context::MainNet, "SOL", MarketId::spot(1)),
            (Context::MainNet, "sol-perp", MarketId::perp(0)),
            (Context::MainNet, "eth-perp", MarketId::perp(2)),
        ] {
            dbg!(context, symbol);
            assert_eq!(MarketId::lookup(*context, symbol).unwrap(), *expected,);
        }

        for (context, symbol) in &[
            (Context::MainNet, "market404"),
            (Context::MainNet, "market404-perp"),
            (Context::MainNet, "market404-something"),
        ] {
            assert!(MarketId::lookup(*context, symbol).is_err())
        }
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
