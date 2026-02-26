use crate::api::{MarketSession, TradingStatus};
use crate::rate::Rate;
use crate::symbol_state::SymbolState;
use crate::time::TimestampUs;
use crate::PriceFeedId;
use crate::{api::Channel, price::Price};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug, Default, Eq, PartialEq)]
#[serde(untagged)]
pub enum JrpcId {
    String(String),
    Int(i64),
    #[default]
    Null,
}

#[derive(Serialize, Deserialize, Debug, Eq, PartialEq)]
pub struct PythLazerAgentJrpcV1 {
    pub jsonrpc: JsonRpcVersion,
    #[serde(flatten)]
    pub params: JrpcCall,
    #[serde(default)]
    pub id: JrpcId,
}

#[derive(Serialize, Deserialize, Debug, Eq, PartialEq)]
#[serde(tag = "method", content = "params")]
#[serde(rename_all = "snake_case")]
pub enum JrpcCall {
    PushUpdate(FeedUpdateParams),
    PushUpdates(Vec<FeedUpdateParams>),
    GetMetadata(GetMetadataParams),
}

#[derive(Serialize, Deserialize, Debug, Eq, PartialEq, Clone)]
pub struct FeedUpdateParams {
    pub feed_id: PriceFeedId,
    pub source_timestamp: TimestampUs,
    pub update: UpdateParams,
}

#[derive(Serialize, Deserialize, Debug, Eq, PartialEq, Clone)]
#[serde(tag = "type")]
pub enum UpdateParams {
    #[serde(rename = "price")]
    PriceUpdate {
        price: Option<Price>,
        best_bid_price: Option<Price>,
        best_ask_price: Option<Price>,
        trading_status: Option<TradingStatus>,
        market_session: Option<MarketSession>,
    },
    #[serde(rename = "funding_rate")]
    FundingRateUpdate {
        price: Option<Price>,
        rate: Rate,
        #[serde(default = "default_funding_rate_interval", with = "humantime_serde")]
        funding_rate_interval: Option<Duration>,
    },
}

fn default_funding_rate_interval() -> Option<Duration> {
    None
}

#[derive(Serialize, Deserialize, Debug, Eq, PartialEq)]
pub struct Filter {
    pub name: Option<String>,
    pub asset_type: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Eq, PartialEq)]
pub struct GetMetadataParams {
    pub names: Option<Vec<String>>,
    pub asset_types: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug, Eq, PartialEq)]
pub enum JsonRpcVersion {
    #[serde(rename = "2.0")]
    V2,
}

#[derive(Serialize, Deserialize, Debug, Eq, PartialEq)]
#[serde(untagged)]
pub enum JrpcResponse<T> {
    Success(JrpcSuccessResponse<T>),
    Error(JrpcErrorResponse),
}

#[derive(Serialize, Deserialize, Debug, Eq, PartialEq)]
pub struct JrpcSuccessResponse<T> {
    pub jsonrpc: JsonRpcVersion,
    pub result: T,
    pub id: JrpcId,
}

#[derive(Serialize, Deserialize, Debug, Eq, PartialEq)]
pub struct JrpcErrorResponse {
    pub jsonrpc: JsonRpcVersion,
    pub error: JrpcErrorObject,
    pub id: JrpcId,
}

#[derive(Serialize, Deserialize, Debug, Eq, PartialEq)]
pub struct JrpcErrorObject {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum JrpcError {
    ParseError(String),
    InternalError(String),
    SendUpdateError(FeedUpdateParams),
}

// note: error codes can be found in the rfc https://www.jsonrpc.org/specification#error_object
impl From<JrpcError> for JrpcErrorObject {
    fn from(error: JrpcError) -> Self {
        match error {
            JrpcError::ParseError(error_message) => JrpcErrorObject {
                code: -32700,
                message: "Parse error".to_string(),
                data: Some(error_message.into()),
            },
            JrpcError::InternalError(error_message) => JrpcErrorObject {
                code: -32603,
                message: "Internal error".to_string(),
                data: Some(error_message.into()),
            },
            JrpcError::SendUpdateError(feed_update_params) => JrpcErrorObject {
                code: -32000,
                message: "Internal error".to_string(),
                data: Some(serde_json::to_value(feed_update_params).unwrap()),
            },
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
pub struct SymbolMetadata {
    pub pyth_lazer_id: PriceFeedId,
    pub name: String,
    pub symbol: String,
    pub description: String,
    pub asset_type: String,
    pub exponent: i16,
    pub cmc_id: Option<u32>,
    #[serde(default, with = "humantime_serde", alias = "interval")]
    pub funding_rate_interval: Option<Duration>,
    pub min_publishers: u16,
    pub min_channel: Channel,
    pub state: SymbolState,
    pub hermes_id: Option<String>,
    pub quote_currency: Option<String>,
    pub nasdaq_symbol: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jrpc::JrpcCall::{GetMetadata, PushUpdate};

    #[test]
    fn test_push_update_price() {
        let json = r#"
        {
          "jsonrpc": "2.0",
          "method": "push_update",
          "params": {
            "feed_id": 1,
            "source_timestamp": 124214124124,

            "update": {
              "type": "price",
              "price": 1234567890,
              "best_bid_price": 1234567891,
              "best_ask_price": 1234567892,
              "trading_status": "halted",
              "market_session": "postMarket"
            }
          },
          "id": 1
        }
        "#;

        let expected = PythLazerAgentJrpcV1 {
            jsonrpc: JsonRpcVersion::V2,
            params: PushUpdate(FeedUpdateParams {
                feed_id: PriceFeedId(1),
                source_timestamp: TimestampUs::from_micros(124214124124),
                update: UpdateParams::PriceUpdate {
                    price: Some(Price::from_integer(1234567890, 0).unwrap()),
                    best_bid_price: Some(Price::from_integer(1234567891, 0).unwrap()),
                    best_ask_price: Some(Price::from_integer(1234567892, 0).unwrap()),
                    trading_status: Some(TradingStatus::Halted),
                    market_session: Some(MarketSession::PostMarket),
                },
            }),
            id: JrpcId::Int(1),
        };

        assert_eq!(
            serde_json::from_str::<PythLazerAgentJrpcV1>(json).unwrap(),
            expected
        );
    }

    #[test]
    fn test_push_update_price_string_id() {
        let json = r#"
        {
          "jsonrpc": "2.0",
          "method": "push_update",
          "params": {
            "feed_id": 1,
            "source_timestamp": 124214124124,

            "update": {
              "type": "price",
              "price": 1234567890,
              "best_bid_price": 1234567891,
              "best_ask_price": 1234567892
            }
          },
          "id": "b6bb54a0-ea8d-439d-97a7-3b06befa0e76"
        }
        "#;

        let expected = PythLazerAgentJrpcV1 {
            jsonrpc: JsonRpcVersion::V2,
            params: PushUpdate(FeedUpdateParams {
                feed_id: PriceFeedId(1),
                source_timestamp: TimestampUs::from_micros(124214124124),
                update: UpdateParams::PriceUpdate {
                    price: Some(Price::from_integer(1234567890, 0).unwrap()),
                    best_bid_price: Some(Price::from_integer(1234567891, 0).unwrap()),
                    best_ask_price: Some(Price::from_integer(1234567892, 0).unwrap()),
                    trading_status: None,
                    market_session: None,
                },
            }),
            id: JrpcId::String("b6bb54a0-ea8d-439d-97a7-3b06befa0e76".to_string()),
        };

        assert_eq!(
            serde_json::from_str::<PythLazerAgentJrpcV1>(json).unwrap(),
            expected
        );
    }

    #[test]
    fn test_push_update_price_null_id() {
        let json = r#"
        {
          "jsonrpc": "2.0",
          "method": "push_update",
          "params": {
            "feed_id": 1,
            "source_timestamp": 124214124124,

            "update": {
              "type": "price",
              "price": 1234567890,
              "best_bid_price": 1234567891,
              "best_ask_price": 1234567892
            }
          },
          "id": null
        }
        "#;

        let expected = PythLazerAgentJrpcV1 {
            jsonrpc: JsonRpcVersion::V2,
            params: PushUpdate(FeedUpdateParams {
                feed_id: PriceFeedId(1),
                source_timestamp: TimestampUs::from_micros(124214124124),
                update: UpdateParams::PriceUpdate {
                    price: Some(Price::from_integer(1234567890, 0).unwrap()),
                    best_bid_price: Some(Price::from_integer(1234567891, 0).unwrap()),
                    best_ask_price: Some(Price::from_integer(1234567892, 0).unwrap()),
                    trading_status: None,
                    market_session: None,
                },
            }),
            id: JrpcId::Null,
        };

        assert_eq!(
            serde_json::from_str::<PythLazerAgentJrpcV1>(json).unwrap(),
            expected
        );
    }

    #[test]
    fn test_push_update_price_without_id() {
        let json = r#"
        {
          "jsonrpc": "2.0",
          "method": "push_update",
          "params": {
            "feed_id": 1,
            "source_timestamp": 745214124124,

            "update": {
              "type": "price",
              "price": 5432,
              "best_bid_price": 5432,
              "best_ask_price": 5432
            }
          }
        }
        "#;

        let expected = PythLazerAgentJrpcV1 {
            jsonrpc: JsonRpcVersion::V2,
            params: PushUpdate(FeedUpdateParams {
                feed_id: PriceFeedId(1),
                source_timestamp: TimestampUs::from_micros(745214124124),
                update: UpdateParams::PriceUpdate {
                    price: Some(Price::from_integer(5432, 0).unwrap()),
                    best_bid_price: Some(Price::from_integer(5432, 0).unwrap()),
                    best_ask_price: Some(Price::from_integer(5432, 0).unwrap()),
                    trading_status: None,
                    market_session: None,
                },
            }),
            id: JrpcId::Null,
        };

        assert_eq!(
            serde_json::from_str::<PythLazerAgentJrpcV1>(json).unwrap(),
            expected
        );
    }

    #[test]
    fn test_push_update_price_without_bid_ask() {
        let json = r#"
        {
          "jsonrpc": "2.0",
          "method": "push_update",
          "params": {
            "feed_id": 1,
            "source_timestamp": 124214124124,

            "update": {
              "type": "price",
              "price": 1234567890
            }
          },
          "id": 1
        }
        "#;

        let expected = PythLazerAgentJrpcV1 {
            jsonrpc: JsonRpcVersion::V2,
            params: PushUpdate(FeedUpdateParams {
                feed_id: PriceFeedId(1),
                source_timestamp: TimestampUs::from_micros(124214124124),
                update: UpdateParams::PriceUpdate {
                    price: Some(Price::from_integer(1234567890, 0).unwrap()),
                    best_bid_price: None,
                    best_ask_price: None,
                    trading_status: None,
                    market_session: None,
                },
            }),
            id: JrpcId::Int(1),
        };

        assert_eq!(
            serde_json::from_str::<PythLazerAgentJrpcV1>(json).unwrap(),
            expected
        );
    }

    #[test]
    fn test_push_update_funding_rate() {
        let json = r#"
        {
          "jsonrpc": "2.0",
          "method": "push_update",
          "params": {
            "feed_id": 1,
            "source_timestamp": 124214124124,

            "update": {
              "type": "funding_rate",
              "price": 1234567890,
              "rate": 1234567891,
              "funding_rate_interval": "8h"
            }
          },
          "id": 1
        }
        "#;

        let expected = PythLazerAgentJrpcV1 {
            jsonrpc: JsonRpcVersion::V2,
            params: PushUpdate(FeedUpdateParams {
                feed_id: PriceFeedId(1),
                source_timestamp: TimestampUs::from_micros(124214124124),
                update: UpdateParams::FundingRateUpdate {
                    price: Some(Price::from_integer(1234567890, 0).unwrap()),
                    rate: Rate::from_integer(1234567891, 0).unwrap(),
                    funding_rate_interval: Duration::from_secs(28800).into(),
                },
            }),
            id: JrpcId::Int(1),
        };

        assert_eq!(
            serde_json::from_str::<PythLazerAgentJrpcV1>(json).unwrap(),
            expected
        );
    }
    #[test]
    fn test_push_update_funding_rate_without_price() {
        let json = r#"
        {
          "jsonrpc": "2.0",
          "method": "push_update",
          "params": {
            "feed_id": 1,
            "source_timestamp": 124214124124,

            "update": {
              "type": "funding_rate",
              "rate": 1234567891
            }
          },
          "id": 1
        }
        "#;

        let expected = PythLazerAgentJrpcV1 {
            jsonrpc: JsonRpcVersion::V2,
            params: PushUpdate(FeedUpdateParams {
                feed_id: PriceFeedId(1),
                source_timestamp: TimestampUs::from_micros(124214124124),
                update: UpdateParams::FundingRateUpdate {
                    price: None,
                    rate: Rate::from_integer(1234567891, 0).unwrap(),
                    funding_rate_interval: None,
                },
            }),
            id: JrpcId::Int(1),
        };

        assert_eq!(
            serde_json::from_str::<PythLazerAgentJrpcV1>(json).unwrap(),
            expected
        );
    }

    #[test]
    fn test_send_get_metadata() {
        let json = r#"
        {
          "jsonrpc": "2.0",
          "method": "get_metadata",
          "params": {
            "names": ["BTC/USD"],
            "asset_types": ["crypto"]
          },
          "id": 1
        }
        "#;

        let expected = PythLazerAgentJrpcV1 {
            jsonrpc: JsonRpcVersion::V2,
            params: GetMetadata(GetMetadataParams {
                names: Some(vec!["BTC/USD".to_string()]),
                asset_types: Some(vec!["crypto".to_string()]),
            }),
            id: JrpcId::Int(1),
        };

        assert_eq!(
            serde_json::from_str::<PythLazerAgentJrpcV1>(json).unwrap(),
            expected
        );
    }

    #[test]
    fn test_get_metadata_without_filters() {
        let json = r#"
        {
          "jsonrpc": "2.0",
          "method": "get_metadata",
          "params": {},
          "id": 1
        }
        "#;

        let expected = PythLazerAgentJrpcV1 {
            jsonrpc: JsonRpcVersion::V2,
            params: GetMetadata(GetMetadataParams {
                names: None,
                asset_types: None,
            }),
            id: JrpcId::Int(1),
        };

        assert_eq!(
            serde_json::from_str::<PythLazerAgentJrpcV1>(json).unwrap(),
            expected
        );
    }

    #[test]
    fn test_response_format_error() {
        let response = serde_json::from_str::<JrpcErrorResponse>(
            r#"
            {
              "jsonrpc": "2.0",
              "id": 2,
              "error": {
                "message": "Internal error",
                "code": -32603
              }
            }
            "#,
        )
        .unwrap();

        assert_eq!(
            response,
            JrpcErrorResponse {
                jsonrpc: JsonRpcVersion::V2,
                error: JrpcErrorObject {
                    code: -32603,
                    message: "Internal error".to_string(),
                    data: None,
                },
                id: JrpcId::Int(2),
            }
        );
    }

    #[test]
    fn test_response_format_error_string_id() {
        let response = serde_json::from_str::<JrpcErrorResponse>(
            r#"
            {
              "jsonrpc": "2.0",
              "id": "62b627dc-5599-43dd-b2c2-9c4d30f4fdb4",
              "error": {
                "message": "Internal error",
                "code": -32603
              }
            }
            "#,
        )
        .unwrap();

        assert_eq!(
            response,
            JrpcErrorResponse {
                jsonrpc: JsonRpcVersion::V2,
                error: JrpcErrorObject {
                    code: -32603,
                    message: "Internal error".to_string(),
                    data: None,
                },
                id: JrpcId::String("62b627dc-5599-43dd-b2c2-9c4d30f4fdb4".to_string())
            }
        );
    }

    #[test]
    pub fn test_response_format_success() {
        let response = serde_json::from_str::<JrpcSuccessResponse<String>>(
            r#"
            {
              "jsonrpc": "2.0",
              "id": 2,
              "result": "success"
            }
            "#,
        )
        .unwrap();

        assert_eq!(
            response,
            JrpcSuccessResponse::<String> {
                jsonrpc: JsonRpcVersion::V2,
                result: "success".to_string(),
                id: JrpcId::Int(2),
            }
        );
    }

    #[test]
    pub fn test_response_format_success_string_id() {
        let response = serde_json::from_str::<JrpcSuccessResponse<String>>(
            r#"
            {
              "jsonrpc": "2.0",
              "id": "62b627dc-5599-43dd-b2c2-9c4d30f4fdb4",
              "result": "success"
            }
            "#,
        )
        .unwrap();

        assert_eq!(
            response,
            JrpcSuccessResponse::<String> {
                jsonrpc: JsonRpcVersion::V2,
                result: "success".to_string(),
                id: JrpcId::String("62b627dc-5599-43dd-b2c2-9c4d30f4fdb4".to_string()),
            }
        );
    }

    #[test]
    pub fn test_parse_response() {
        let success_response = serde_json::from_str::<JrpcResponse<String>>(
            r#"
            {
              "jsonrpc": "2.0",
              "id": 2,
              "result": "success"
            }"#,
        )
        .unwrap();

        assert_eq!(
            success_response,
            JrpcResponse::Success(JrpcSuccessResponse::<String> {
                jsonrpc: JsonRpcVersion::V2,
                result: "success".to_string(),
                id: JrpcId::Int(2),
            })
        );

        let error_response = serde_json::from_str::<JrpcResponse<String>>(
            r#"
            {
              "jsonrpc": "2.0",
              "id": 3,
              "error": {
                "code": -32603,
                "message": "Internal error"
              }
            }"#,
        )
        .unwrap();

        assert_eq!(
            error_response,
            JrpcResponse::Error(JrpcErrorResponse {
                jsonrpc: JsonRpcVersion::V2,
                error: JrpcErrorObject {
                    code: -32603,
                    message: "Internal error".to_string(),
                    data: None,
                },
                id: JrpcId::Int(3),
            })
        );
    }

    #[test]
    pub fn test_parse_response_string_id() {
        let success_response = serde_json::from_str::<JrpcResponse<String>>(
            r#"
            {
              "jsonrpc": "2.0",
              "id": "id-2",
              "result": "success"
            }"#,
        )
        .unwrap();

        assert_eq!(
            success_response,
            JrpcResponse::Success(JrpcSuccessResponse::<String> {
                jsonrpc: JsonRpcVersion::V2,
                result: "success".to_string(),
                id: JrpcId::String("id-2".to_string()),
            })
        );

        let error_response = serde_json::from_str::<JrpcResponse<String>>(
            r#"
            {
              "jsonrpc": "2.0",
              "id": "id-3",
              "error": {
                "code": -32603,
                "message": "Internal error"
              }
            }"#,
        )
        .unwrap();

        assert_eq!(
            error_response,
            JrpcResponse::Error(JrpcErrorResponse {
                jsonrpc: JsonRpcVersion::V2,
                error: JrpcErrorObject {
                    code: -32603,
                    message: "Internal error".to_string(),
                    data: None,
                },
                id: JrpcId::String("id-3".to_string()),
            })
        );
    }
}
