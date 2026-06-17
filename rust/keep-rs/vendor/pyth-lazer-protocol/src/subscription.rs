//! Types descibing general WebSocket subscription/unsubscription JSON messages
//! used across publishers, agents and routers.

use {
    crate::router::{JsonUpdate, PriceFeedId, SubscriptionParams},
    derive_more::From,
    serde::{Deserialize, Serialize},
};

/// A request sent from the client to the server.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type")]
#[serde(rename_all = "camelCase")]
pub enum Request {
    Subscribe(SubscribeRequest),
    Unsubscribe(UnsubscribeRequest),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct SubscriptionId(pub u64);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeRequest {
    pub subscription_id: SubscriptionId,
    #[serde(flatten)]
    pub params: SubscriptionParams,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribeRequest {
    pub subscription_id: SubscriptionId,
}

/// A JSON response sent from the server to the client.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, From)]
#[serde(tag = "type")]
#[serde(rename_all = "camelCase")]
pub enum Response {
    Error(ErrorResponse),
    Subscribed(SubscribedResponse),
    SubscribedWithInvalidFeedIdsIgnored(SubscribedWithInvalidFeedIdsIgnoredResponse),
    Unsubscribed(UnsubscribedResponse),
    SubscriptionError(SubscriptionErrorResponse),
    StreamUpdated(StreamUpdatedResponse),
}

/// Sent from the server after a successul subscription.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedResponse {
    pub subscription_id: SubscriptionId,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidFeedSubscriptionDetails {
    pub unknown_ids: Vec<PriceFeedId>,
    pub unsupported_channels: Vec<PriceFeedId>,
    pub unstable: Vec<PriceFeedId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedWithInvalidFeedIdsIgnoredResponse {
    pub subscription_id: SubscriptionId,
    pub subscribed_feed_ids: Vec<PriceFeedId>,
    pub ignored_invalid_feed_ids: InvalidFeedSubscriptionDetails,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribedResponse {
    pub subscription_id: SubscriptionId,
}

/// Sent from the server if the requested subscription or unsubscription request
/// could not be fulfilled.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionErrorResponse {
    pub subscription_id: SubscriptionId,
    pub error: String,
}

/// Sent from the server if an internal error occured while serving data for an existing subscription,
/// or a client request sent a bad request.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    pub error: String,
}

/// Sent from the server when new data is available for an existing subscription
/// (only if `delivery_format == Json`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamUpdatedResponse {
    pub subscription_id: SubscriptionId,
    #[serde(flatten)]
    pub payload: JsonUpdate,
}
