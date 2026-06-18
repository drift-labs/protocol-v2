use std::time::UNIX_EPOCH;

use velocity_rs::types::MarketType;
use solana_pubkey::Pubkey;

use crate::types::messages::IncomingSignedMessage;

#[derive(PartialEq, Debug, strum_macros::AsRefStr)]
pub enum WsError {
    /// Client tried to do a protected action while unauthenticated
    Unauthenticated,
    /// Client failed to authenticate its challenge
    FailedChallenge,
    /// Unknown topic
    UnknownTopic(String),
    /// Server couldn't handle the message backpressure
    /// in a timely manner
    Backpressure,
    /// Sending Ws update to client failed
    SendFailed,
    /// Websocket closed unexpectedly
    SocketClosed,
    /// Closed for some Ws protocol reason
    Protocol,
    /// Internal channel closed
    ChannelClosed,
    /// Invalid client message
    BadMessage,
    /// Failed Ws handshake
    Handshake,
}

/// Current unix timestamp (ms)
pub fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[derive(Clone)]
pub struct RequestContext {
    pub recv_ts: u64,
    pub log_prefix: String,
    pub market_index: u16,
    pub market_type: &'static str,
    pub taker_authority: Pubkey,
    pub order_uuid: String,
}

impl RequestContext {
    pub fn from_incoming_message(msg: &IncomingSignedMessage) -> Result<Self, ()> {
        let recv_ts = unix_now_ms();
        let info = msg.order().info(&msg.taker_authority);
        let market_index = info.order_params.market_index;
        let market_type = match info.order_params.market_type {
            MarketType::Perp => "perp",
            MarketType::Spot => "spot",
        };
        match core::str::from_utf8(&info.uuid) {
            Ok(order_uuid) => {
                let taker_authority = if msg.taker_authority != Pubkey::default() {
                    msg.taker_authority
                } else {
                    msg.taker_pubkey
                };

                Ok(Self {
                    market_index,
                    market_type,
                    recv_ts,
                    log_prefix: format!(
                        "[order uuid={order_uuid} market={market_type}:{market_index} taker={taker_authority}]"
                    ),
                    taker_authority,
                    order_uuid: order_uuid.to_string(),
                })
            }
            Err(_) => {
                let taker_authority = if msg.taker_authority != Pubkey::default() {
                    msg.taker_authority
                } else {
                    msg.taker_pubkey
                };
                log::info!(
                    target: "swift",
                    "[order market={market_type}:{market_index} taker={taker_authority}] uuid invalid utf-8"
                );
                Err(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use velocity_rs::{
        swift_order_subscriber::SignedOrderType,
        types::{
            OrderParams, OrderTriggerCondition, OrderType, PositionDirection, PostOnlyParam,
            SignedMsgOrderParamsMessage,
        },
    };

    use super::*;

    #[test]
    fn from_incoming_message_valid_utf8_uuid() {
        // Regenerated to the current message format (velocity fork added OrderParams /
        // SignedMsg*Message fields). Same uuid as the messages::tests fixture:
        // [115, 56, 108, 117, 74, 76, 90, 101] = "s8luJLZe".
        let order = SignedMsgOrderParamsMessage {
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
                builder_idx: None,
                builder_fee_tenth_bps: None,
            },
            sub_account_id: 0,
            slot: 369631527,
            uuid: [115, 56, 108, 117, 74, 76, 90, 101],
            take_profit_order_params: None,
            stop_loss_order_params: None,
            max_margin_ratio: None,
            builder_idx: None,
            builder_fee_tenth_bps: None,
            isolated_position_deposit: None,
        };
        let hex_msg =
            faster_hex::hex_string(SignedOrderType::authority(order).to_borsh().as_slice());
        let json = format!(
            r#"{{
            "market_index": 2,
            "market_type": "perp",
            "message": "{hex_msg}",
            "signature": "H8HRloc2vBdhHyiNK5W/Shv3kVKmIYsHTBzlD2ecyxyOUh7EuysU/Y5AOXZ3IpsMxRyLn6OSAHKEgCIQX4OpDQ==",
            "signing_authority": "4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE",
            "taker_pubkey": "4rmhwytmKH1XsgGAUyUUH7U64HS5FtT6gM8HGKAfwcFE"
        }}"#
        );
        let msg: IncomingSignedMessage = serde_json::from_str(&json).expect("deserialize");
        let ctx = RequestContext::from_incoming_message(&msg).expect("valid utf8 uuid");
        assert_eq!(ctx.order_uuid, "s8luJLZe");
        assert_eq!(ctx.market_index, 2);
        assert_eq!(ctx.market_type, "perp");
    }
}
