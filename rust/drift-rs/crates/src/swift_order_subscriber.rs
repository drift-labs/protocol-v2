//! Swift order subscriber and serialization utilities
use std::time::{SystemTime, UNIX_EPOCH};

use crate::solana_sdk::{clock::Slot, pubkey::Pubkey, signature::Signature};
use anchor_lang::{AnchorDeserialize, AnchorSerialize};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::wrappers::ReceiverStream;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{error::Error as WsError, Message},
};

pub use crate::types::{
    SignedMsgOrderParamsDelegateMessage as SignedDelegateOrder,
    SignedMsgOrderParamsMessage as SignedOrder,
};
use crate::{
    constants::MarketExt,
    types::{Context, MarketId, OrderParams, SdkError, SdkResult},
    DriftClient, Wallet,
};

/// Swift message discriminator (Anchor)
///
/// sha256("global:SignedMsgOrderParamsMessage")[..8]
pub const SWIFT_MSG_PREFIX: [u8; 8] = [0xc8, 0xd5, 0xa6, 0x5e, 0x22, 0x34, 0xf5, 0x5d];
/// Swift delegate message discriminator (Anchor)
///
/// sha256("global:/// sha256("global:SignedMsgOrderParamsDelegatedMessage")[..8]
pub const SWIFT_DELEGATE_MSG_PREFIX: [u8; 8] = [0x42, 0x65, 0x66, 0x38, 0xc7, 0x25, 0x9e, 0x23];

pub const SWIFT_DEVNET_WS_URL: &str = "wss://master.swift.drift.trade";
pub const SWIFT_MAINNET_WS_URL: &str = "wss://swift.drift.trade";

const LOG_TARGET: &str = "swift";

/// Common fields of signed message types
pub struct SignedMessageInfo {
    pub taker_pubkey: Pubkey,
    pub order_params: OrderParams,
    pub uuid: [u8; 8],
    pub slot: Slot,
}

/// It can be either signed by the authority keypair or an authorized delegate
#[derive(Clone, Debug, PartialEq)]
pub enum SignedOrderType {
    /// Swift order signed by authority keypair
    Authority {
        inner: SignedOrder,
        /// hexified payload if received over Ws
        raw: Option<String>,
    },
    /// Swift order signed by a delegated keypair
    Delegated {
        inner: SignedDelegateOrder,
        /// hexified payload if received over Ws
        raw: Option<String>,
    },
}

impl SignedOrderType {
    /// Return the original, hexified message
    pub fn raw(&self) -> &Option<String> {
        match self {
            Self::Authority { inner: _, ref raw } => raw,
            Self::Delegated { inner: _, ref raw } => raw,
        }
    }
    pub fn delegated(order: SignedDelegateOrder) -> Self {
        Self::Delegated {
            inner: order,
            raw: None,
        }
    }
    pub fn authority(order: SignedOrder) -> Self {
        Self::Authority {
            inner: order,
            raw: None,
        }
    }
    /// Returns true if this is a delegated signed msg order
    pub fn is_delegated(&self) -> bool {
        matches!(self, Self::Delegated { .. })
    }
    /// Serialize as a borsh buffer
    ///
    /// DEV: Swift clients do not encode or decode the enum byte
    pub fn to_borsh(&self) -> Vec<u8> {
        // max variant size +8 (anchor discriminator len)
        let mut buf = Vec::with_capacity(std::mem::size_of::<SignedDelegateOrder>() + 8);
        match self {
            Self::Authority { ref raw, ref inner } => {
                if let Some(raw) = raw {
                    buf.extend_from_slice(raw.as_bytes());
                } else {
                    (SWIFT_MSG_PREFIX).serialize(&mut buf).unwrap();
                    inner.serialize(&mut buf).unwrap();
                }
            }
            Self::Delegated { ref raw, ref inner } => {
                if let Some(raw) = raw {
                    buf.extend_from_slice(raw.as_bytes());
                } else {
                    (SWIFT_DELEGATE_MSG_PREFIX).serialize(&mut buf).unwrap();
                    inner.serialize(&mut buf).unwrap();
                }
            }
        }

        buf
    }
    /// Returns order details
    pub fn info(&self, taker_authority: &Pubkey) -> SignedMessageInfo {
        match self {
            Self::Authority { inner, .. } => SignedMessageInfo {
                taker_pubkey: Wallet::derive_user_account(taker_authority, inner.sub_account_id),
                order_params: inner.signed_msg_order_params,
                uuid: inner.uuid,
                slot: inner.slot,
            },
            Self::Delegated { inner, .. } => SignedMessageInfo {
                taker_pubkey: inner.taker_pubkey,
                order_params: inner.signed_msg_order_params,
                uuid: inner.uuid,
                slot: inner.slot,
            },
        }
    }
}

/// Order notification from Websocket
#[derive(Clone, Deserialize)]
struct OrderNotification<'a> {
    #[allow(dead_code)]
    channel: &'a str,
    order: SignedOrderInfo,
    deposit: Option<&'a str>,
}

/// Error notification from Websocket
#[allow(unused)]
#[derive(Clone, Debug, Deserialize)]
struct ErrorNotification<'a> {
    channel: &'a str,
    error: &'a str,
}

#[derive(Deserialize)]
struct Heartbeat {
    #[serde(deserialize_with = "deser_int_str", rename = "message")]
    ts: u64,
}

/// Swift order and metadata fresh from the Websocket
///
/// This is an off-chain authorization for a taker order.
/// It may be placed and filled by any willing counter-party, ensuring the time-price bounds
/// are respected.
#[derive(Clone, Debug, Deserialize)]
pub struct SignedOrderInfo {
    /// Swift order uuid
    uuid: String,
    /// Order creation timestamp (unix ms)
    pub ts: u64,
    /// The taker authority pubkey
    #[serde(deserialize_with = "deser_pubkey")]
    pub taker_authority: Pubkey,
    /// The authority pubkey that verifies `signature`
    /// it is either the taker authority or a sub-account delegate
    #[serde(rename = "signing_authority", deserialize_with = "deser_pubkey")]
    pub signer: Pubkey,
    /// hex-ified, borsh encoded signed order message
    /// this is the signed/verified payload for onchain use
    #[serde(rename = "order_message", deserialize_with = "deser_signed_msg_type")]
    order: SignedOrderType,
    /// Signature over the serialized `order` payload
    #[serde(rename = "order_signature", deserialize_with = "deser_signature")]
    pub signature: Signature,
    /// true if the order params are highly likely to be sanitized (improved) by the program when placed
    ///
    /// MMs wishing to fill a sanitized order should understand the potential time/price bound changes
    #[serde(default)]
    pub will_sanitize: bool,
    /// Taker signed (pre)deposit tx
    ///
    /// taker requires posting collateral before placing the swift order
    pub pre_deposit: Option<String>,
}

impl SignedOrderInfo {
    /// Slot number when user signed the order
    pub fn slot(&self) -> Slot {
        match &self.order {
            SignedOrderType::Authority { inner, .. } => inner.slot,
            SignedOrderType::Delegated { inner, .. } => inner.slot,
        }
    }
    /// The order's UUID (stringified)
    pub fn order_uuid_str(&self) -> &str {
        self.uuid.as_ref()
    }
    /// The order's UUID (raw)
    pub fn order_uuid(&self) -> [u8; 8] {
        match &self.order {
            SignedOrderType::Authority { inner, .. } => inner.uuid,
            SignedOrderType::Delegated { inner, .. } => inner.uuid,
        }
    }
    /// The drift order params of the message
    pub fn order_params(&self) -> OrderParams {
        match &self.order {
            SignedOrderType::Authority { inner, .. } => inner.signed_msg_order_params,
            SignedOrderType::Delegated { inner, .. } => inner.signed_msg_order_params,
        }
    }
    /// Get the taker sub-account for the order
    ///
    /// `taker_authority` - the Authority pubkey of the taker's sub-account
    pub fn taker_subaccount(&self) -> Pubkey {
        match &self.order {
            SignedOrderType::Authority { inner, .. } => {
                Wallet::derive_user_account(&self.taker_authority, inner.sub_account_id)
            }
            SignedOrderType::Delegated { inner, .. } => inner.taker_pubkey,
        }
    }
    /// serialize the order message for onchain use e.g. signature verification
    pub fn encode_for_signing(&self) -> Vec<u8> {
        // the swift message format can change
        // if the message was received from an external source then we have to preserve the serialization
        // if we are constructing it locally then it can be serialized without issue
        match self.order {
            SignedOrderType::Authority { ref raw, ref inner } => {
                if let Some(raw) = raw {
                    raw.as_bytes().into()
                } else {
                    let mut buf = Vec::with_capacity(std::mem::size_of::<SignedOrder>() + 8);
                    (SWIFT_MSG_PREFIX).serialize(&mut buf).unwrap();
                    inner.serialize(&mut buf).unwrap();
                    hex::encode(buf).into()
                }
            }
            SignedOrderType::Delegated { ref raw, ref inner } => {
                if let Some(raw) = raw {
                    raw.as_bytes().into()
                } else {
                    let mut buf =
                        Vec::with_capacity(std::mem::size_of::<SignedDelegateOrder>() + 8);
                    (SWIFT_DELEGATE_MSG_PREFIX).serialize(&mut buf).unwrap();
                    inner.serialize(&mut buf).unwrap();
                    hex::encode(buf).into()
                }
            }
        }
    }
    /// convert swift order into anchor ix data
    pub fn to_ix_data(&self) -> Vec<u8> {
        let signed_msg = self.encode_for_signing();
        [
            self.signature.as_ref(),
            self.signer.as_ref(),
            &(signed_msg.len() as u16).to_le_bytes(),
            signed_msg.as_ref(),
        ]
        .concat()
    }

    /// Returns true if the order was signed using delegated authority
    pub fn using_delegate_signing(&self) -> bool {
        self.order.is_delegated()
    }

    pub fn new(
        uuid: String,
        taker_authority: Pubkey,
        signer: Pubkey,
        order: SignedOrderType,
        signature: Signature,
        pre_deposit: Option<String>,
    ) -> Self {
        Self {
            uuid,
            ts: unix_now_ms(),
            taker_authority,
            signer,
            order,
            signature,
            will_sanitize: false,
            pre_deposit,
        }
    }

    /// Build authority `SignedOrderInfo`
    pub fn authority(
        taker_authority: Pubkey,
        signed_order: SignedOrder,
        signature: Signature,
    ) -> Self {
        Self {
            uuid: core::str::from_utf8(&signed_order.uuid)
                .unwrap()
                .to_string(),
            ts: unix_now_ms(),
            order: SignedOrderType::authority(signed_order),
            signature,
            signer: taker_authority,
            taker_authority,
            will_sanitize: false,
            pre_deposit: None,
        }
    }

    /// Build delegated `SignedOrderInfo`
    pub fn delegated(
        taker_authority: Pubkey,
        signing_authority: Pubkey,
        delegated_order: SignedDelegateOrder,
        signature: Signature,
    ) -> Self {
        Self {
            uuid: core::str::from_utf8(&delegated_order.uuid)
                .unwrap()
                .to_string(),
            ts: unix_now_ms(),
            order: SignedOrderType::delegated(delegated_order),
            signature,
            signer: signing_authority,
            taker_authority,
            will_sanitize: false,
            pre_deposit: None,
        }
    }

    pub fn has_builder(&self) -> bool {
        match self.order {
            SignedOrderType::Authority { ref inner, .. } => {
                inner.builder_fee_tenth_bps.is_some() && inner.builder_idx.is_some()
            }
            SignedOrderType::Delegated { ref inner, .. } => {
                inner.builder_fee_tenth_bps.is_some() && inner.builder_idx.is_some()
            }
        }
    }

    /// True if the signed order uses isolated margin mode
    pub fn has_isolated_position_deposit(&self) -> bool {
        self.isolated_position_deposit().is_some_and(|x| x > 0)
    }

    /// Return the isolated deposit amount
    pub fn isolated_position_deposit(&self) -> Option<u64> {
        match self.order {
            SignedOrderType::Authority { ref inner, .. } => inner.isolated_position_deposit,
            SignedOrderType::Delegated { ref inner, .. } => inner.isolated_position_deposit,
        }
    }
}

/// Emits swift orders from the Ws server
pub type SwiftOrderStream = ReceiverStream<SignedOrderInfo>;

/// Subscribe to the Swift WebSocket server, authenticate, and listen to new orders
///
/// * `client` - Drift client instance
/// * `markets` - markets to listen on for new swift orders
/// * `accept_sanitized` - set to true to receive *sanitized order flow (default: false)
/// * `accept_deposit_trades` - set to true to receive 'deposit+trade' order flow (default: false)
/// * `swift_ws_override` - custom swift Ws server endpoint
///
/// * a sanitized order may have its auction params modified by the program when
///   placed onchain. Makers should understand the time/price implications to accept these.
///
/// * deposit+trade orders require fillers to send an attached, preceding deposit tx
///   before the swift order
///
/// Returns a stream of new Swift order messages
pub async fn subscribe_swift_orders(
    client: &DriftClient,
    markets: &[MarketId],
    accept_sanitized: bool,
    accept_deposit_trades: bool,
    swift_ws_override: Option<String>,
) -> SdkResult<SwiftOrderStream> {
    let base_url = if let Some(custom_base_url) = swift_ws_override {
        custom_base_url
    } else if client.context == Context::MainNet {
        SWIFT_MAINNET_WS_URL.to_string()
    } else {
        SWIFT_DEVNET_WS_URL.to_string()
    };

    let maker_pubkey = client.wallet().authority().to_string();
    let uri = format!("{base_url}/ws?pubkey={maker_pubkey}");
    let (ws_stream, _) = connect_async(uri).await.map_err(|err| {
        log::error!(target: LOG_TARGET, "couldn't connect to server: {err:?}");
        SdkError::WsClient(Box::new(err))
    })?;

    let (mut outgoing, mut incoming) = ws_stream.split();

    // handle authentication and subscription
    while let Some(msg) = incoming.next().await {
        let msg = msg.map_err(|err| {
            log::error!(target: LOG_TARGET, "failed reading swift msg: {err:?}");
            SdkError::WsClient(Box::new(err))
        })?;

        if let Message::Text(text) = msg {
            log::debug!(target: LOG_TARGET, "msg: {text}");
            let message: Value = serde_json::from_str(&text).expect("Failed to parse message");

            if let Some(err) = message.get("error") {
                log::error!(target: LOG_TARGET, "swift server error: {err:?}");
                return Err(SdkError::WebsocketError);
            }

            // authenticate with Ws server
            if message["channel"] == "auth" && message.get("nonce").is_some() {
                let nonce = message["nonce"].as_str().expect("got nonce");
                let signature = client
                    .wallet()
                    .sign_message(nonce.as_bytes())
                    .expect("infallible");
                let signature_b64 =
                    base64::engine::general_purpose::STANDARD.encode(signature.as_ref());

                let auth_message = json!({
                    "pubkey": maker_pubkey,
                    "signature": signature_b64,
                })
                .to_string();
                outgoing.send(Message::Text(auth_message.into())).await?;
                continue;
            }

            // subscribe to markets
            if message["channel"] == "auth" && message["message"] == "Authenticated" {
                let subscribe_msgs: Vec<Result<Message, _>> = markets
                    .iter()
                    .filter_map(|m| {
                        assert!(m.is_perp(), "only perp markets");
                        let market = client
                            .program_data()
                            .perp_market_config_by_index(m.index())
                            .expect("market exists");
                        if !market.symbol().contains("BET") {
                            let subscribe_msg = json!({
                              "action": "subscribe",
                              "market_type": "perp",
                              "market_name": market.symbol(),
                            })
                            .to_string();
                            Some(Ok(Message::Text(subscribe_msg.into())))
                        } else {
                            // skipping bet market
                            log::debug!(target: LOG_TARGET, "skip subscribe for bet market: {}", market.market_index);
                            None
                        }
                    })
                    .collect();

                outgoing
                    .send_all(&mut futures_util::stream::iter(subscribe_msgs))
                    .await?;
                break;
            }
        }
    }

    let (tx, rx) = tokio::sync::mpsc::channel(256);

    // handle swift orders
    tokio::spawn(async move {
        while let Some(msg) = incoming.next().await {
            match msg {
                Ok(Message::Text(ref text)) => {
                    match serde_json::from_str::<OrderNotification>(text) {
                        Ok(OrderNotification {
                            channel: _,
                            mut order,
                            deposit,
                        }) => {
                            log::debug!(
                                target: LOG_TARGET,
                                "uuid: {}, latency: {}ms",
                                order.uuid,
                                unix_now_ms().saturating_sub(order.ts)
                            );

                            if let Some(deposit) = deposit {
                                if !accept_deposit_trades {
                                    log::debug!(
                                        target: LOG_TARGET,
                                        "skipping deposit+trade order: {}",
                                        order.uuid
                                    );
                                    continue;
                                }
                                order.pre_deposit = Some(deposit.to_string());
                            }

                            if !accept_sanitized {
                                log::debug!(
                                    target: LOG_TARGET,
                                    "skipping sanitized order: {}",
                                    order.uuid
                                );
                                continue;
                            }
                            if let Err(err) = tx.try_send(order) {
                                log::error!(target: LOG_TARGET, "order chan failed: {err:?}");
                                break;
                            }
                        }
                        Err(err) => {
                            if text.contains("heartbeat") {
                                if let Ok(heartbeat) = serde_json::from_str::<Heartbeat>(text) {
                                    log::debug!(
                                        target: LOG_TARGET,
                                        "heartbeat latency: {}",
                                        unix_now_ms().saturating_sub(heartbeat.ts)
                                    );
                                    continue;
                                }
                            }
                            if let Ok(msg) = serde_json::from_str::<ErrorNotification>(text) {
                                log::error!(target: LOG_TARGET, "{msg:?}");
                                continue;
                            }
                            log::error!(target: LOG_TARGET, "{text}. invalid json response: {err:?}");
                            break;
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    log::error!(target: LOG_TARGET, "server closed connection");
                    break;
                }
                Ok(_) => continue,
                Err(err) => {
                    // Invalid UTF-8 in a single frame (e.g. bad nanoid): skip so stream stays alive.
                    // Connection closed, I/O, protocol errors etc. end the stream so caller can reconnect.
                    match &err {
                        WsError::Utf8(_) => {
                            log::error!(target: LOG_TARGET, "invalid UTF-8 in swift msg (skipping frame): {err:?}");
                            continue;
                        }
                        _ => {
                            log::error!(target: LOG_TARGET, "failed reading swift msg: {err:?}");
                            break;
                        }
                    }
                }
            }
        }
    });

    Ok(ReceiverStream::new(rx))
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn deser_pubkey<'de, D>(deserializer: D) -> Result<Pubkey, D::Error>
where
    D: serde::de::Deserializer<'de>,
{
    let s: &str = serde::de::Deserialize::deserialize(deserializer)?;
    Ok(s.parse().expect("base58 pubkey"))
}

fn deser_signature<'de, D>(deserializer: D) -> Result<Signature, D::Error>
where
    D: serde::de::Deserializer<'de>,
{
    let s: &str = serde::de::Deserialize::deserialize(deserializer)?;
    Ok(Signature::try_from(base64::engine::general_purpose::STANDARD.decode(s).unwrap()).unwrap())
}

fn deser_int_str<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::de::Deserializer<'de>,
{
    let s: &str = serde::de::Deserialize::deserialize(deserializer)?;
    Ok(s.parse().unwrap())
}

/// Deserialize hex-ified, borsh bytes as a `SignedOrderType`
pub fn deser_signed_msg_type<'de, D>(deserializer: D) -> Result<SignedOrderType, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let payload: std::borrow::Cow<String> = serde::Deserialize::deserialize(deserializer)?;
    if !payload.len().is_multiple_of(2) {
        return Err(serde::de::Error::custom("Hex string length must be even"));
    }
    if payload.is_empty() {
        return Err(serde::de::Error::custom("invalid signed message hex"));
    }

    // decode expecting the largest possible variant
    let mut borsh_buf = [0u8; std::mem::size_of::<SignedDelegateOrder>() + 8];
    hex::decode_to_slice(payload.as_bytes(), &mut borsh_buf[..payload.len() / 2])
        .map_err(serde::de::Error::custom)?;

    // this is basically the same as if we derived AnchorDeserialize on `SignedOrderType` _expect_ it does not
    // add a u8 to distinguish the enum
    if borsh_buf[..8] == SWIFT_DELEGATE_MSG_PREFIX {
        AnchorDeserialize::deserialize(&mut &borsh_buf[8..])
            .map(|x| SignedOrderType::Delegated {
                raw: Some(payload.to_string()),
                inner: x,
            })
            .map_err(serde::de::Error::custom)
    } else {
        AnchorDeserialize::deserialize(&mut &borsh_buf[8..])
            .map(|x| SignedOrderType::Authority {
                raw: Some(payload.to_string()),
                inner: x,
            })
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        MarketType, OrderTriggerCondition, OrderType, PositionDirection, PostOnlyParam,
    };

    #[test]
    fn test_swift_order_deser_bad_message() {
        let msg = r#"{
            "channel":"signed_orders_perp_1",
            "order":{
                "market_index":1,
                "market_type":"perp",
                "order_message":"b9c165ffdf70594d0001010080841e00000000000000000000000000010000000000000000013201a4e99abc16000000011ab2f982160000000300900f84150000000072753959424c52740000b9c165ffdf70594d0001010080841e00000000000000000000000000010000000000000000013201a4e99abc16000000011ab2f982160000000300900f84150000000072753959424c52740000aabbccaabbccaabbccaabbcc",
                "order_signature":"FIgxWlW+C0abvtE8esSko7At1YGM8h66T0u5lJpwXirW63CuvEllVWZ68NNVFsaqcj4jqgQInXUnLPjIf/PQDA==",
                "signing_authority":"4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE",
                "taker_authority":"DxoRJ4f5XRMvXU9SGuM4ZziBFUxbhB3ubur5sVZEvue2",
                "ts":1739518796400,
                "uuid":"ru9YBLRt"
            }
        }"#;
        let result: Result<OrderNotification, _> = serde_json::from_str(&msg);
        assert!(result.is_err());

        let msg = r#"{
            "channel":"signed_orders_perp_1",
            "order":{
                "market_index":1,
                "market_type":"perp",
                "order_message":"",
                "order_signature":"FIgxWlW+C0abvtE8esSko7At1YGM8h66T0u5lJpwXirW63CuvEllVWZ68NNVFsaqcj4jqgQInXUnLPjIf/PQDA==",
                "signing_authority":"4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE",
                "taker_authority":"DxoRJ4f5XRMvXU9SGuM4ZziBFUxbhB3ubur5sVZEvue2",
                "ts":1739518796400,
                "uuid":"ru9YBLRt"
            }
        }"#;
        let result: Result<OrderNotification, _> = serde_json::from_str(&msg);
        assert!(result.is_err());
    }

    #[test]
    fn test_swift_order_deser() {
        let msg = r#"{
            "channel":"signed_orders_perp_1",
            "order":{
                "market_index":1,
                "market_type":"perp",
                "order_message":"b9c165ffdf70594d0001010080841e00000000000000000000000000010000000000000000013201a4e99abc16000000011ab2f982160000000300900f84150000000072753959424c52740000",
                "order_signature":"FIgxWlW+C0abvtE8esSko7At1YGM8h66T0u5lJpwXirW63CuvEllVWZ68NNVFsaqcj4jqgQInXUnLPjIf/PQDA==",
                "signing_authority":"4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE",
                "taker_authority":"DxoRJ4f5XRMvXU9SGuM4ZziBFUxbhB3ubur5sVZEvue2",
                "ts":1739518796400,
                "uuid":"ru9YBLRt"
            }
        }"#;
        let order_notification: OrderNotification = serde_json::from_str(&msg).unwrap();
        let signed_message = order_notification.order;
        assert_eq!(
            signed_message.signer,
            "4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE"
                .parse::<Pubkey>()
                .unwrap()
        );
        assert_eq!(
            signed_message.taker_authority,
            "DxoRJ4f5XRMvXU9SGuM4ZziBFUxbhB3ubur5sVZEvue2"
                .parse::<Pubkey>()
                .unwrap()
        );
        assert_eq!(signed_message.ts, 1739518796400);
        assert_eq!(signed_message.uuid, "ru9YBLRt");
        assert_eq!(signed_message.order_params().market_index, 1);
        assert_eq!(signed_message.order_params().market_type, MarketType::Perp);
    }

    #[test]
    fn test_swift_order_encode_for_signing() {
        let msg = "{\"channel\":\"swift_orders_perp_2\",\"order\":{\"market_index\":2,\"market_type\":\"perp\",\"order_message\":\"c8d5a65e2234f55d0001010080841e0000000000000000000000000002000000000000000001320124c6aa950000000001786b2f94000000000000bb64a9150000000074735730364f6d380000\",\"order_signature\":\"SaOaLJ1i0MqZ2cXdp00jGe2EJFa32eOfiQynFU7mclhT86yhIa4/tWXq7r6l7QPN0Jl6frfsZl0nNOvKZxZpAA==\",\"signing_authority\":\"4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE\",\"taker_authority\":\"4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE\",\"ts\":1740456840770,\"uuid\":\"tsW06Om8\"}}";
        let order_notification: OrderNotification = serde_json::from_str(&msg).unwrap();
        let signed_message = order_notification.order;
        assert_eq!(
            signed_message.encode_for_signing().as_slice(),
            b"c8d5a65e2234f55d0001010080841e0000000000000000000000000002000000000000000001320124c6aa950000000001786b2f94000000000000bb64a9150000000074735730364f6d380000"
        );
    }

    #[test]
    fn deser_ix_payload() {
        let data = hex_literal::hex!("204f658b1906620f040100000a09f3447ce77b9aa6374b05c5efb667042ca0cb15ca74af8a8b97b5ad09cd68aef5bda66b38c021c42ff59afad102b7ffa31bc9c52ee85a8752b3142d62b405833d29adc5096b41d5b9d3b2d6fe46deecb286644510a70f85b95853ec628209a20063386435613635653232333466353564303430313030303038306561383232623030303030303030303030303030303030303030303030303030303030303030303030303030303030313437373930303030303131343031623065386663666666666666666666663031343737393030303030303030303030303039303062323436383231343030303030303030363235393733333936393638343133353030303000");
        let ix =
            drift::instruction::PlaceSignedMsgTakerOrder::deserialize(&mut &data[8..]).unwrap();
        // signature, pubkey, len(u16)
        let mut payload = hex::decode(&ix.signed_msg_order_params_message_bytes[98..]).unwrap();
        dbg!(payload[..8] == SWIFT_MSG_PREFIX);

        payload.resize(std::mem::size_of::<SignedOrder>(), 0);
        let res: SignedOrder = AnchorDeserialize::deserialize(&mut &payload[8..]).unwrap();
        dbg!(&res);
        dbg!(core::str::from_utf8(&res.uuid).unwrap());
    }

    #[test]
    fn deserialize_incoming_signed_message_delegated() {
        let order_message_raw = "42656638c7259e230001010080841e00000000000000000000000000020000000000000000013201bb60507d000000000117c0127c00000000395311d51c1b87fd56c3b5872d1041111e51f399b12d291d981a0ea383407295272108160000000073386c754a4c5a650000";
        let payload = serde_json::json!({
            "channel": "swift_orders_perp_2",
            "order": {
                "market_index": 2,
                "market_type": "perp",
                "order_message": order_message_raw,
                "order_signature": "9G8luwFfeAc25HwXCgaUjrKv6yJHcMFDq4Z4uPXqom5mhwZ63YU5g7p07Kxe/AKSt5A/9OPDh3nN/c9IHjkCDA==",
                "taker_authority": "4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE",
                "signing_authority": "GiMXQkJXLVjScmQDkoLJShBJpTh9SDPvT2AZQq8NyEBf",
                "ts": 1739518796400_u64,
                "uuid":"s8luJLZe"
            }
        })
        .to_string();
        let actual: OrderNotification<'_> =
            serde_json::from_str(payload.as_str()).expect("deserializes");

        assert_eq!(
            actual.order.signer,
            solana_pubkey::pubkey!("GiMXQkJXLVjScmQDkoLJShBJpTh9SDPvT2AZQq8NyEBf")
        );
        assert_eq!(
            actual.order.taker_authority,
            solana_pubkey::pubkey!("4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE")
        );
        assert_eq!(actual.order.order_uuid_str(), "s8luJLZe");

        if let SignedOrderType::Delegated {
            inner: signed_msg,
            raw,
        } = actual.order.order
        {
            let expected = SignedDelegateOrder {
                signed_msg_order_params: OrderParams {
                    order_type: OrderType::Market,
                    market_type: MarketType::Perp,
                    direction: PositionDirection::Short,
                    user_order_id: 0,
                    base_asset_amount: 2000000,
                    price: 0,
                    market_index: 2,
                    reduce_only: false,
                    post_only: PostOnlyParam::None,
                    bit_flags: 0,
                    max_ts: None,
                    trigger_price: None,
                    trigger_condition: OrderTriggerCondition::Above,
                    oracle_price_offset: None,
                    auction_duration: Some(50),
                    auction_start_price: Some(2102419643),
                    auction_end_price: Some(2081603607),
                },
                taker_pubkey: solana_pubkey::pubkey!(
                    "4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE"
                ),
                slot: 369631527,
                uuid: [115, 56, 108, 117, 74, 76, 90, 101],
                take_profit_order_params: None,
                stop_loss_order_params: None,
                max_margin_ratio: None,
                builder_idx: None,
                builder_fee_tenth_bps: None,
                isolated_position_deposit: None,
            };
            assert_eq!(signed_msg, expected);
            assert_eq!(
                raw.unwrap().as_str(),
                order_message_raw,
                "preserved order message from payload"
            );
        } else {
            assert!(false, "unexpected variant");
        }
    }
}
