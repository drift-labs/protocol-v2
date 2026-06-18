use std::{
    cell::LazyCell,
    collections::HashMap,
    env,
    net::SocketAddr,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use anchor_lang::AccountDeserialize;
use anyhow::{Context, Result};
use axum::{routing::get, Router};
use dashmap::DashMap;
use dotenv::dotenv;
use ed25519_dalek::{PublicKey, Signature, Verifier};
use futures_util::{
    stream::{self, FuturesUnordered},
    Sink, SinkExt, Stream, StreamExt, TryStreamExt,
};
use log::{debug, warn};
use prometheus::Registry;
use rand::Rng;
use serde::Deserialize;
use tokio::{
    io::AsyncWriteExt,
    sync::{
        broadcast::{self},
        mpsc::{self, error::TrySendError},
    },
    time::timeout,
};
use tokio_tungstenite::tungstenite::{
    self, extensions::DeflateConfig, protocol::WebSocketConfig, Message,
};
use velocity_rs::{
    constants::MarketExt,
    swift_order_subscriber::SignedMessageInfo,
    types::{
        accounts::{PerpMarket, SignedMsgWsDelegates, UserStats},
        MarketType, MarketTypeExt,
    },
    Pubkey, RpcClient, Wallet,
};

use crate::{
    types::{
        messages::{
            OrderMetadataAndMessage, SubscribeActions, WsAuthMessage, WsClientMessage, WsMessage,
            WsSubscribeMessage,
        },
        types::{unix_now_ms, WsError},
    },
    util::metrics::{metrics_handler, MetricsServerParams, WsServerMetrics},
};

#[cfg(test)]
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);
#[cfg(not(test))]
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const FAST_SLOW_WS_DIFF: Duration = Duration::from_secs(1);

const HEARTBEAT_LOG_INTERVAL_MS: u64 = 30_000;
static LAST_REDIS_HEARTBEAT_LOG_MS: AtomicU64 = AtomicU64::new(0);

fn should_log_heartbeat(last_log: &AtomicU64) -> bool {
    let now = unix_now_ms();
    let previous = last_log.load(Ordering::Relaxed);
    if now.saturating_sub(previous) >= HEARTBEAT_LOG_INTERVAL_MS {
        last_log.store(now, Ordering::Relaxed);
        true
    } else {
        false
    }
}

const ENDPOINT: LazyCell<String> = LazyCell::new(|| {
    env::var("ENDPOINT").unwrap_or_else(|_| "https://api.devnet.solana.com".to_string())
});

const FAST_CHECK: LazyCell<bool> =
    LazyCell::new(|| env::var("FAST_CHECK").unwrap_or("false".to_string()) == "true");

#[derive(Clone, Debug)]
pub struct OrderNotification {
    /// json-ified order
    json: String,
    /// internal order processing latency
    recv_lag: u64,
}

type Subscriptions = DashMap<String, broadcast::Sender<OrderNotification>>;

// Used for authentication
#[derive(Clone, Debug)]
pub struct Challenge {
    pub nonce: String,
    pub expires_at: std::time::Instant,
}
const NONCE_VALIDITY_DURATION: Duration = Duration::from_secs(30);

#[derive(Clone, Default)]
pub struct ServerParams {
    pub perp_markets: Vec<PerpMarket>,
    pub subscriptions: Subscriptions,
    pub host: String,
    pub port: String,
    pub metrics: WsServerMetrics,
}

impl Challenge {
    /// Try to authenticate
    ///
    /// * `pubkey` purported identity
    /// * `signature` signed bytes of challenge `nonce`
    fn authenticate(&self, pubkey: [u8; 32], signature: &Signature) -> Result<()> {
        let pubkey = PublicKey::from_bytes(pubkey.as_slice()).context("Invalid public key")?;

        // Check if the nonce has expired
        if self.expires_at < std::time::Instant::now() {
            return Err(anyhow::Error::msg("Nonce expired"));
        }

        pubkey
            .verify(self.nonce.as_bytes(), signature)
            .context("Invalid message/signature")
    }
}

fn find_market_index_from_symbol(
    perp_markets: &[PerpMarket],
    symbol: &str,
    market_type: MarketType,
) -> Option<u16> {
    if market_type == MarketType::Perp {
        perp_markets.iter().find_map(|perp_market| {
            if perp_market.symbol().eq_ignore_ascii_case(symbol) {
                Some(perp_market.market_index)
            } else {
                None
            }
        })
    } else {
        None
    }
}

pub fn derive_ws_auth_delegates_pubkey(authority: &Pubkey) -> Pubkey {
    let (account_drift_pda, _seed) = Pubkey::find_program_address(
        &[&b"SIGNED_MSG_WS"[..], authority.as_ref()],
        &velocity_rs::constants::PROGRAM_ID,
    );
    account_drift_pda
}

async fn determine_fast_ws(ws_delegate: &Pubkey, stake_pubkey: &Pubkey) -> Result<bool> {
    let rpc = RpcClient::new(ENDPOINT.to_string());
    if stake_pubkey.to_bytes() == [0u8; 32] {
        return Ok(false);
    }

    let ws_auth_delegates_pubkey = derive_ws_auth_delegates_pubkey(stake_pubkey);
    let user_stats_pubkey = Wallet::derive_stats_account(stake_pubkey);

    let response = rpc
        .get_multiple_accounts(&[ws_auth_delegates_pubkey, user_stats_pubkey])
        .await
        .context("Failed to get stake and ws delegate account data")?;

    if response[0].is_none() || response[1].is_none() {
        log::debug!("Failed to get stake and ws delegate account data for {stake_pubkey:?}");
        return Ok(false);
    }

    let ws_delegates_for_stake =
        SignedMsgWsDelegates::try_deserialize(&mut response[0].as_ref().unwrap().data.as_slice())
            .context("Could not deserialize ws delegates")?;

    if !ws_delegates_for_stake.delegates.contains(ws_delegate) {
        log::debug!(
            target: "ws",
            "Delegate {ws_delegate:?} not found in stake {stake_pubkey:?}"
        );
        return Ok(false);
    }

    let user_stats = UserStats::try_deserialize(&mut response[1].as_ref().unwrap().data.as_slice())
        .context("Could not deserialize user stats")?;

    // velocity removed gov-token staking (`if_staked_gov_token_amount`); the
    // staker fast-path now keys off insurance-fund (quote-asset) stake.
    log::debug!(
        target: "ws",
        "IF stake for {}: {}",
        stake_pubkey,
        user_stats.if_staked_quote_asset_amount
    );

    Ok(user_stats.if_staked_quote_asset_amount > 0)
}

/// Stateful Ws connection
#[derive(Debug)]
pub struct WsConnection {
    /// True if the connection has authenticated its pubkey
    authenticated: bool,
    subscribed_topics: HashMap<String, broadcast::Receiver<OrderNotification>>,
    challenge: Option<Challenge>,
    fast_ws: Arc<AtomicBool>,
    /// write half of outbound message queue
    message_tx: mpsc::Sender<String>,
    /// read half of outbound message queue
    message_rx: mpsc::Receiver<String>,
    /// pubkey of the connection
    /// if not authenticated it cannot be relied upon
    pubkey: Pubkey,
}

impl WsConnection {
    /// Initialize a new Ws context
    pub fn new(pubkey: Pubkey) -> Self {
        // Internal buffer for outbound messages to client to allow back-pressure
        let (message_tx, message_rx) = mpsc::channel::<String>(128);
        Self {
            authenticated: false,
            fast_ws: Arc::new(AtomicBool::new(true)),
            subscribed_topics: Default::default(),
            challenge: Some(Challenge {
                // Set nonce store for authentication and the send message immediately to the user
                nonce: rand::thread_rng()
                    .sample_iter(&rand::distributions::Alphanumeric)
                    .take(30)
                    .map(char::from)
                    .collect(),
                expires_at: std::time::Instant::now() + NONCE_VALIDITY_DURATION,
            }),
            message_tx,
            message_rx,
            pubkey,
        }
    }
    /// Returns true if the Ws connection should run in fast mode
    pub fn is_fast(&self) -> bool {
        self.fast_ws.load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn is_authenticated(&self) -> bool {
        self.authenticated
    }
    pub fn nonce(&self) -> Option<String> {
        self.challenge.as_ref().map(|x| x.nonce.clone())
    }
    /// Queues a `message` for sending
    fn send_message(&self, message: WsMessage) -> Result<(), WsError> {
        match self.message_tx.try_send(message.jsonify()) {
            Ok(_) => Ok(()),
            Err(TrySendError::Full(_)) => {
                log::error!(target: "ws", "User message channel full, dropping message");
                Err(WsError::Backpressure)
            }
            Err(TrySendError::Closed(_)) => {
                log::error!(target: "ws", "User message channel closed, dropping message");
                Err(WsError::ChannelClosed)
            }
        }
    }
    /// Process an incoming Ws message from client
    ///
    /// * `message` - the message to process from connected client
    /// * `shared_state` - shared global app state
    pub fn handle_client_message(
        &mut self,
        message: WsClientMessage,
        shared_state: &'static ServerParams,
    ) -> Result<(), WsError> {
        match message {
            WsClientMessage::Subscribe(WsSubscribeMessage {
                market_name,
                market_type,
                action,
            }) => {
                if !self.is_authenticated() {
                    debug!("{}: subscribe when not authenticated", self.pubkey,);
                    self.send_message(
                        WsMessage::auth().set_error("Not authenticated to subscribe"),
                    )?;
                    return Err(WsError::Unauthenticated);
                }
                let market_index = find_market_index_from_symbol(
                    &shared_state.perp_markets,
                    &market_name,
                    market_type,
                );

                if market_index.is_none() {
                    log::debug!("{}: subscribe for market that doesn't exist", self.pubkey,);
                    self.send_message(
                        WsMessage::subscribe().set_error(&format!("Market {market_name} invalid")),
                    )?;
                    return Ok(());
                }

                let topic = format!(
                    "swift_orders_{}_{}",
                    market_type.as_str(),
                    market_index.unwrap()
                );
                let deposit_topic = format!(
                    "swift_orders_deposit_{}_{}",
                    market_type.as_str(),
                    market_index.unwrap()
                );

                match action {
                    SubscribeActions::Subscribe => {
                        // Don't subscribe if not authenticated
                        if let Some(tx) = shared_state.subscriptions.get(&topic) {
                            log::info!(
                                target: "ws",
                                "{}: subscribing to topic: {topic}",
                                self.pubkey,
                            );
                            self.subscribed_topics.insert(topic.clone(), tx.subscribe());

                            if let Some(tx) = shared_state.subscriptions.get(&deposit_topic) {
                                self.subscribed_topics
                                    .insert(deposit_topic.clone(), tx.subscribe());
                            } else {
                                log::info!(target: "ws", "deposit topic not subbed");
                            }
                            Ok(())
                        } else {
                            log::info!(
                                target: "ws",
                                "{}: trying to subscribe to topic not found: {topic}",
                                self.pubkey,
                            );
                            self.send_message(
                                WsMessage::auth()
                                    .set_error(&format!("Couldn't subscribe: {:?}", topic)),
                            )?;
                            // the topic is expected to exist at this point
                            Err(WsError::UnknownTopic(format!("unknown topic: {topic:?}")))
                        }
                    }
                    SubscribeActions::Unsubscribe => {
                        log::info!(
                            target: "ws",

                            "{}: unsubscribing from topic: {topic}",
                            self.pubkey,
                        );
                        self.subscribed_topics.remove(&topic);
                        self.subscribed_topics.remove(&deposit_topic);
                        Ok(())
                    }
                }
            }
            WsClientMessage::Auth(WsAuthMessage {
                pubkey,
                signature,
                stake_pubkey,
            }) => {
                if self.is_authenticated() {
                    return Ok(());
                }

                let challenge = self.challenge.as_ref().expect("challenge exists");
                match challenge.authenticate(pubkey.to_bytes(), &signature) {
                    Ok(_) => {
                        self.send_message(WsMessage::auth().set_message("Authenticated"))?;
                        self.authenticated = true;
                        self.challenge.take();
                        // Load the connection priority from IF stake (async)
                        tokio::spawn({
                            let fast_ws = Arc::clone(&self.fast_ws);
                            let pubkey = self.pubkey;
                            async move {
                                let is_fast_ws = if *FAST_CHECK {
                                    determine_fast_ws(&pubkey, &stake_pubkey).await
                                } else {
                                    Ok(true)
                                };
                                if let Err(ref err) = is_fast_ws {
                                    log::error!(
                                        "{}: Failed to determine if fast ws: {err:?}",
                                        pubkey,
                                    );
                                    shared_state
                                        .metrics
                                        .ws_connections
                                        .with_label_values(&["false"])
                                        .inc();
                                } else {
                                    log::info!(
                                        target: "ws",
                                        "{}: Is fast ws: {is_fast_ws:?}",
                                        pubkey,
                                    );
                                    let is_fast_ws = is_fast_ws.unwrap();
                                    shared_state
                                        .metrics
                                        .ws_connections
                                        .with_label_values(&[&is_fast_ws.to_string()])
                                        .inc();
                                    fast_ws.store(is_fast_ws, std::sync::atomic::Ordering::Relaxed);
                                }
                            }
                        });
                        Ok(())
                    }
                    Err(e) => {
                        self.send_message(
                            WsMessage::auth().set_error(&format!("Failed to authenticate: {e:?}")),
                        )?;

                        Err(WsError::FailedChallenge)
                    }
                }
            }
        }
    }
    /// Run Ws handler for a connection
    ///
    /// * `ws_sink` - write-half of the Ws connection (sends to client)
    /// * `ws_stream` - read-half of the Ws connection (receives from client)
    /// * `shared_state` - app global vars
    async fn spawn_handler(
        mut self,
        mut ws_sink: impl Sink<Message> + Unpin,
        mut ws_stream: impl Stream<Item = Result<Message, tungstenite::Error>> + Unpin,
        shared_state: &'static ServerParams,
    ) -> Result<(), WsError> {
        let log_prefix = format!("[websocket: {}]", self.pubkey);

        if let Err(err) = self
            .send_message(WsMessage::auth().set_nonce(self.nonce().expect("nonce exists").as_str()))
        {
            log::error!(target: "ws", "{log_prefix}: failed to init Ws auth challenge: {err:?}");
            return Err(WsError::ChannelClosed);
        }

        let mut outbox = Vec::<String>::with_capacity(100); // buffer messages for sending

        let mut heartbeat_interval = tokio::time::interval(HEARTBEAT_INTERVAL);
        let _ = heartbeat_interval.tick().await; // skip first immediate tick

        // Loop that handles the message forwarding and transmission
        let res = 'handler: loop {
            let is_fast_ws = self.is_fast();
            let has_subs = !self.subscribed_topics.is_empty();
            let mut topic_subs =
                FuturesUnordered::from_iter(self.subscribed_topics.iter_mut().map(|r| r.1.recv()))
                    .try_ready_chunks(8);
            tokio::select! {
                biased;
                n_read = self.message_rx.recv_many(&mut outbox, 16) => {
                    shared_state.metrics.ws_outbox_size.observe(self.message_rx.len() as f64 + n_read as f64);
                    debug!(target: "ws", "queued {n_read} outbox messages");
                }
                client_message = ws_stream.next() => {
                    drop(topic_subs);
                    match client_message {
                            Some(Ok(Message::Text(ref message))) => {
                                match serde_json::from_str::<WsClientMessage>(message) {
                                    Ok(msg) => {
                                        if let Err(err) = self.handle_client_message(msg, shared_state) {
                                            log::error!(target: "ws", "{log_prefix}: processing msg failed: {err:?}");
                                        }
                                    }
                                    Err(e) => {
                                        debug!(target: "ws", "{log_prefix}: failed to parse Ws message: {e:?}");
                                        let _ = self.message_tx.try_send(format!("{e:?}"));
                                        break 'handler Err(WsError::BadMessage);
                                    }
                                };
                                log::debug!(target: "ws", "processed client msg");
                            }
                            Some(Ok(Message::Close(c))) => {
                                if let Some(cf) = c {
                                    debug!(target: "ws", "{log_prefix}: close with code: {}, reason: `{}`", cf.code, cf.reason);
                                } else {
                                    debug!(target: "ws", "{log_prefix}: close without frame");
                                }
                                break 'handler Ok(());
                            }
                            Some(Ok(Message::Binary(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
                            Some(Err(tungstenite::Error::ConnectionClosed)) => {
                                // normal close
                                break 'handler Ok(())
                            }
                            Some(Err(err)) => {
                                match err {
                                    // these variants are not problematic errors, safely ignore
                                    tungstenite::Error::ConnectionClosed | tungstenite::Error::Protocol(tungstenite::error::ProtocolError::ResetWithoutClosingHandshake) => (),
                                    _ => warn!(target: "ws", "{log_prefix}: Ws protocol error: {err:?}"),
                                }
                                break 'handler Err(WsError::Protocol);
                            },
                            None => {
                                warn!(target: "ws", "{log_prefix}: Ws closed unexpectedly");
                                break 'handler Err(WsError::SocketClosed);
                            }
                        }
                },
                batch_updates = topic_subs.next(), if has_subs => {
                    // forward broadcast messages to the outbox
                    match batch_updates {
                        Some(Ok(updates)) => {
                            if is_fast_ws {
                                for new_order_info in updates {
                                    if let Err(err) = self.message_tx.try_send(new_order_info.json) {
                                        // client will miss this message
                                        // either channel is full or closed
                                        log::error!(target: "ws", "{log_prefix}: queueing send failed: {err:?}");
                                        break 'handler Err(WsError::Backpressure);
                                    }
                                }
                            } else {
                                let sender = self.message_tx.clone();
                                let log_prefix = log_prefix.clone();
                                // remove internal routing latency from the delay
                                let delay_ms = FAST_SLOW_WS_DIFF - Duration::from_millis(updates.first().unwrap().recv_lag);
                                let delay_fut = tokio::time::sleep(delay_ms);
                                tokio::spawn(async move {
                                    let _ = delay_fut.await;
                                    for new_order_info in updates {
                                        if let Err(err) = sender.try_send(new_order_info.json) {
                                            // client will miss this message
                                            // either channel is full or closed
                                            log::error!(target: "ws", "{log_prefix}: queueing send failed: {err:?}");
                                        }
                                    }
                                });
                            }
                        }
                        Some(Err(err)) => {
                            log::error!(
                                target: "ws",
                                "{:?}. couldn't load msg: {err:?}",
                                self.pubkey.to_string()
                            );
                            break 'handler Err(WsError::ChannelClosed);
                        }
                        None => {
                            log::error!(
                                target: "ws",
                                "{:?}. channel failed. closing Ws",
                                self.pubkey.to_string()
                            );
                            break 'handler Err(WsError::ChannelClosed);
                        }
                    }
                }
                _ = heartbeat_interval.tick() => {
                    drop(topic_subs);
                    if !self.authenticated {
                        debug!(
                            target: "ws",
                            "closing unauthenticated Ws (timeout)"
                        );
                        break 'handler Ok(());
                    }
                    outbox.push(
                        WsMessage::heartbeat().set_message(&unix_now_ms().to_string()).jsonify()
                    );
                }
            }

            // TODO: with compression on it may be worth caching the message for
            // use by other connections
            if !outbox.is_empty() {
                let outbox_ready_count = outbox.len();
                let send_now = outbox.drain(..).map(|m| Ok(Message::text(m)));
                #[cfg(test)]
                dbg!(&send_now);
                if ws_sink.send_all(&mut stream::iter(send_now)).await.is_err() {
                    log::error!(target: "ws", "sending messages to client failed. closing connection");
                    break 'handler Err(WsError::SendFailed);
                }
                log::debug!(target: "ws", "processed outbox. sent: {outbox_ready_count}");
            }
        };

        // drain outbox
        self.message_rx.close();
        while let Some(msg) = self.message_rx.recv().await {
            if ws_sink.send(Message::Text(msg)).await.is_err() {
                log::error!(target: "ws", "sending messages to client failed. closing connection");
            }
        }

        // Decrement connection counter
        if self.is_authenticated() {
            shared_state
                .metrics
                .ws_connections
                .with_label_values(&[&self.is_fast().to_string()])
                .dec();
        }

        if let Err(err) = res {
            log::warn!(target: "ws", "{log_prefix}: closed unexpectedly: {err:?}");
            Err(err)
        } else {
            log::info!(target: "ws", "{log_prefix}: closed ok");
            Ok(())
        }
    }
}

async fn subscribe_redis_pubsub(
    mut redis: redis::aio::PubSub,
    server_params: &'static ServerParams,
    all_topics: Vec<String>,
) -> Result<(), ()> {
    // Subscribe manually for now because of elasticache
    let subscribe_with_timeout =
        timeout(Duration::from_secs(5), redis.subscribe(&all_topics)).await;
    if subscribe_with_timeout.is_err() {
        log::error!(target:"redis", "subscribing topics timed out");
        return Err(());
    }
    if let Ok(Err(err)) = subscribe_with_timeout {
        log::error!(target:"redis", "subscribing topics failed: {err:?}");
        return Err(());
    }

    log::info!(target: "redis", "subscribed to {} topics", all_topics.len());

    let mut stream = redis.on_message();
    while let Some(message) = stream.next().await {
        let topic = message.get_channel_name();

        // encountered new topic
        if !server_params.subscriptions.contains_key(topic) {
            log::info!(target: "redis", "loaded new topic: {topic}");
            server_params
                .subscriptions
                .insert(topic.to_string(), broadcast::channel(20).0);
        };

        let tx = server_params
            .subscriptions
            .get(topic)
            .expect("topic channel exists");

        server_params
            .metrics
            .redis_messages_received
            .with_label_values(&[topic])
            .inc();

        let receiver_count = tx.receiver_count();
        if receiver_count == 0 {
            if topic != "heartbeat" {
                log::warn!(target: "redis", "No receiver found for topic: {topic}, dropping order message!");
            } else if should_log_heartbeat(&LAST_REDIS_HEARTBEAT_LOG_MS) {
                log::trace!(target: "redis", "Received heartbeat message");
            }
            continue;
        }
        let payload: &[u8] = message.get_payload_bytes();
        let payload_str = std::str::from_utf8(payload)
            .context("Failed to convert payload to string")
            .unwrap();

        let (order_metadata, deposit) = if !topic.contains("deposit") {
            (
                OrderMetadataAndMessage::decode(payload_str)
                    .context("Failed to decode order metadata"),
                None,
            )
        } else {
            #[derive(Deserialize)]
            struct DepositOrder<'a> {
                #[serde(borrow)]
                deposit: &'a str,
                #[serde(borrow)]
                order: &'a str,
            }
            let value: DepositOrder = serde_json::from_str(payload_str).unwrap();
            (
                OrderMetadataAndMessage::decode(value.order)
                    .context("Failed to decode order metadata"),
                Some(value.deposit),
            )
        };

        if let Err(ref err) = order_metadata {
            log::error!(target: "redis", "Failed to decode order metadata: {err:?}, {order_metadata:?}");
            continue;
        }
        let order_metadata = order_metadata.unwrap();
        let now_ms = unix_now_ms();
        let forward_latency = now_ms.saturating_sub(order_metadata.ts);

        server_params
            .metrics
            .redis_message_forward_latency
            .with_label_values(&[topic])
            .observe(forward_latency as f64 / 1000.0);

        let SignedMessageInfo {
            taker_pubkey: taker_subaccount,
            order_params,
            ..
        } = order_metadata.order_info();

        log::info!(
            target: "redis",
            "topic={topic} uuid={} market_type={} market_index={} direction={:?} base={} price={} order_type={:?} taker_authority={} signer={} taker_subaccount={} will_sanitize={} deposit_present={} recv_lag_ms={forward_latency} receivers={receiver_count}",
            order_metadata.uuid(),
            order_params.market_type.as_str(),
            order_params.market_index,
            order_params.direction,
            order_params.base_asset_amount,
            order_params.price,
            order_params.order_type,
            order_metadata.taker_authority,
            order_metadata.signing_authority,
            taker_subaccount,
            order_metadata.will_sanitize,
            deposit.is_some(),
        );
        let mut message = WsMessage::new(topic).set_order(&order_metadata);
        // order has a deposit tx attached
        if let Some(deposit) = deposit {
            message = message.set_deposit(deposit);
        }
        log::trace!("message jsonify(): {:?}", message);
        match tx.send(OrderNotification {
            json: message.jsonify(),
            recv_lag: forward_latency,
        }) {
            Ok(_) => {
                log::debug!(
                    target: "redis",
                    "topic={topic} uuid={} forwarded at {} receivers={receiver_count}",
                    order_metadata.uuid(),
                    now_ms,
                );
            }
            Err(e) => {
                log::error!(
                    target: "redis",
                    "topic={topic} uuid={} failed to forward at {}. Error: {e:?}",
                    order_metadata.uuid(),
                    now_ms,
                );
            }
        }
    }

    Ok(())
}

pub async fn start_server() {
    dotenv().ok();

    let client = RpcClient::new(ENDPOINT.to_string());
    let (perp_market_accounts, _) =
        velocity_rs::marketmap::get_market_accounts_with_fallback::<PerpMarket>(&client)
            .await
            .unwrap();

    let perp_market_accounts: Vec<PerpMarket> = perp_market_accounts
        .into_iter()
        .filter(|m| {
            if m.symbol().contains("BET") {
                log::info!("Skipping BET market: {}", m.market_index);
                false
            } else {
                true
            }
        })
        .collect();

    // Set up the server with the server params
    let subscriptions = DashMap::new();
    let mut topic_names: Vec<String> = vec!["heartbeat".to_string()];
    for market in perp_market_accounts.iter() {
        let topic = format!(
            "swift_orders_{}_{}",
            market.market_type(),
            market.market_index
        );
        let deposit_topic = format!(
            "swift_orders_deposit_{}_{}",
            market.market_type(),
            market.market_index
        );
        topic_names.extend_from_slice(&[topic.clone(), deposit_topic.clone()]);
        subscriptions.insert(topic, broadcast::channel(20).0);
        subscriptions.insert(deposit_topic, broadcast::channel(20).0);
    }

    // Registry for metrics
    let registry = Registry::new();
    let ws_metrics = WsServerMetrics::new();
    ws_metrics.register(&registry);

    let state: &'static ServerParams = Box::leak(Box::new(ServerParams {
        perp_markets: perp_market_accounts,
        subscriptions,
        host: env::var("WS_HOST").unwrap_or("0.0.0.0".to_string()),
        port: env::var("WS_PORT").unwrap_or("3000".to_string()),
        metrics: ws_metrics,
    }));

    // Create the redis pubsub subscriber
    let elasticache_host = env::var("ELASTICACHE_HOST").unwrap_or_else(|_| "localhost".to_string());
    let elasticache_port = env::var("ELASTICACHE_PORT").unwrap_or_else(|_| "6379".to_string());
    let connection_string = if env::var("USE_SSL").unwrap_or_else(|_| "false".to_string()) == "true"
    {
        format!("rediss://{}:{}", elasticache_host, elasticache_port)
    } else {
        format!("redis://{}:{}", elasticache_host, elasticache_port)
    };

    log::info!(target: "redis", "connecting to redis at {connection_string}");

    let redis_client = redis::Client::open(connection_string)
        .context("Failed to create redis client")
        .expect("redis client created");

    tokio::spawn(async move {
        // Reconnect loop: if the subscriber exits, try to re-establish the pubsub
        // connection rather than tearing down the whole ws server.
        let mut attempt: u32 = 0;
        loop {
            match redis_client.get_async_pubsub().await {
                Ok(pubsub) => {
                    if attempt > 0 {
                        log::info!(target: "redis", "pubsub reconnected after {attempt} attempts");
                    }
                    attempt = 0;
                    let _ = subscribe_redis_pubsub(pubsub, state, topic_names.clone()).await;
                    log::warn!(target: "redis", "redis subscriber task ended; reconnecting");
                    state.metrics.redis_subscriber_reconnects.inc();
                }
                Err(err) => {
                    log::error!(
                        target: "redis",
                        "failed to create redis pubsub (attempt {attempt}): {err:?}"
                    );
                    state.metrics.redis_subscriber_reconnects.inc();
                }
            }
            attempt = attempt.saturating_add(1);
            // exponential-ish backoff, capped at 30s
            let backoff_ms = 250u64.saturating_mul(1u64 << attempt.min(7));
            tokio::time::sleep(Duration::from_millis(backoff_ms.min(30_000))).await;
        }
    });

    // Metrics
    let registry = Arc::new(registry);
    let server_metrics_state = MetricsServerParams { registry };
    let metrics_addr: SocketAddr = format!(
        "0.0.0.0:{}",
        env::var("METRICS_PORT").unwrap_or("9464".to_string())
    )
    .parse()
    .unwrap();
    let metrics_app = Router::new()
        .route("/metrics", get(metrics_handler))
        .with_state(server_metrics_state);

    tokio::spawn(async move {
        let listener_metrics = tokio::net::TcpListener::bind(&metrics_addr).await.unwrap();
        log::info!(
            target: "ws",
            "Swift metrics server on {}",
            listener_metrics.local_addr().unwrap()
        );
        let res = axum::serve(listener_metrics, metrics_app).await;
        log::error!("metrics server finished: {res:?}");
        std::process::exit(1);
    });

    // Start Ws server
    let addr: SocketAddr = format!("{}:{}", state.host, state.port).parse().unwrap();
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    log::info!(
        target: "ws",
        "Swift Ws server on {}",
        listener.local_addr().unwrap()
    );

    let mut ws_config = WebSocketConfig::default();
    ws_config.compression = Some(DeflateConfig::default());
    ws_config.max_message_size = Some(2 << 20); // max. Ws message size ~2MiB

    // ~max len of a valid request + some room for headers
    // GET https://host.example.com/ws?pubkey=FN3CntYCrHnDAXBV6HntRxcYxkZ2qwnHw3z7RLPKzQpm
    let mut request_buf = [0u8; 1024];

    while let Ok((mut tcp_stream, addr)) = listener.accept().await {
        // 'peek' as Ws upgrade handshake needs to see the request value too
        let n_read = match tcp_stream.peek(&mut request_buf).await {
            Ok(n) => n,
            Err(err) => {
                log::warn!(target: "ws", "couldn't read client buffer: {err:?}");
                let _ = tcp_stream
                    .write(b"HTTP/1.1 500\r\nContent-Length: 0\r\n\r\n")
                    .await;
                continue;
            }
        };

        // check for http request
        let request = match core::str::from_utf8(request_buf[..n_read].trim_ascii_end()) {
            Ok(r) => r,
            Err(_) => {
                let _ = tcp_stream
                    .write(b"HTTP/1.1 400\r\nContent-Length: 0\r\n\r\n")
                    .await;
                continue;
            }
        };
        if request.starts_with("GET /ws?pubkey") {
            let pubkey = match decode_pubkey(request) {
                Ok(p) => p,
                Err(_) => {
                    let _ = tcp_stream
                        .write(b"HTTP/1.1 400\r\nContent-Length: 0\r\n\r\n")
                        .await;
                    continue;
                }
            };
            // spawn handler for the connection
            tokio::spawn(async move {
                log::info!(target: "ws", "new connection: {addr:?}|{pubkey:?}");
                match tokio_tungstenite::accept_async_with_config(tcp_stream, Some(ws_config)).await
                {
                    Ok(ws) => {
                        let (ws_send, ws_recv) = ws.split();
                        let ws_conn = WsConnection::new(pubkey);
                        if let Err(err) = ws_conn.spawn_handler(ws_send, ws_recv, state).await {
                            state
                                .metrics
                                .ws_connection_errors
                                .with_label_values(&[err.as_ref()])
                                .inc();
                        }
                    }
                    Err(err) => {
                        log::error!(target: "ws", "handshake failed: {addr:?}|{pubkey:?}: {err:?}");
                        state
                            .metrics
                            .ws_connection_errors
                            .with_label_values(&[WsError::Handshake.as_ref()])
                            .inc();
                    }
                }
                log::info!(target: "ws", "connection closed: {addr:?}|{pubkey:?}");
            });
        } else if request.starts_with("GET /ws/health") {
            let _ = tcp_stream
                .write(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await;
        } else {
            let _ = tcp_stream
                .write(b"HTTP/1.1 404\r\nContent-Length: 0\r\n\r\n")
                .await;
        }
    }
}

// extract pubkey string from HTTP request
fn decode_pubkey(request: &str) -> Result<Pubkey, &'static str> {
    if let Some(idx) = request.find('=') {
        let pubkey_str = &request[idx + 1..];
        let pubkey_token = pubkey_str
            .split_whitespace()
            .next()
            .ok_or("No pubkey found")?;
        return Pubkey::from_str(pubkey_token).map_err(|_| "Invalid pubkey format");
    }
    Err("No '=' found in request")
}

#[cfg(test)]
mod test {
    use serde_json::{json, Value};
    use solana_keypair::Keypair;

    use super::*;

    fn sol_perp_market() -> PerpMarket {
        let mut sol_perp_name = [0x20; 32];
        sol_perp_name[..3].copy_from_slice(b"sol");
        PerpMarket {
            name: sol_perp_name,
            ..Default::default()
        }
    }

    #[test]
    fn decode_pubkey_works() {
        assert!(decode_pubkey("blahblah=").is_err());
        assert!(decode_pubkey("=DxoRJ4f5XRMvXU9SGuM4ZziBFUxbhB3ubur5sVZEvue2").is_ok());
    }

    #[tokio::test]
    async fn auth_challenge_ok() {
        let wallet = Wallet::new(Keypair::new().into());

        let mut ws_conn = WsConnection::new(*wallet.authority());
        let signature = wallet
            .sign_message(ws_conn.nonce().unwrap().as_bytes())
            .expect("signed");

        let res = ws_conn.handle_client_message(
            WsClientMessage::Auth(WsAuthMessage {
                pubkey: *wallet.authority(),
                stake_pubkey: Pubkey::new_unique(),
                signature: signature.as_ref().try_into().unwrap(),
            }),
            Box::leak(Box::default()),
        );

        assert!(res.is_ok());
        assert!(ws_conn.is_authenticated());
    }

    #[tokio::test]
    async fn auth_challenge_fail() {
        let pubkey = Pubkey::new_unique();
        let stake_pubkey = Pubkey::new_unique();
        let mut ws_conn = WsConnection::new(pubkey);
        let res = ws_conn.handle_client_message(
            WsClientMessage::Auth(WsAuthMessage {
                pubkey,
                signature: [1u8; 64].into(),
                stake_pubkey,
            }),
            Box::leak(Box::default()),
        );

        assert!(res.is_err());
        assert!(!ws_conn.is_authenticated());
    }

    #[tokio::test]
    async fn subscribe_authenticated_ok() {
        let mut ws_conn = WsConnection::new(Pubkey::new_unique());
        ws_conn.authenticated = true;

        let (sender, _receiver) = broadcast::channel(1);
        let shared_state = ServerParams {
            perp_markets: vec![sol_perp_market()],
            subscriptions: DashMap::from_iter([("swift_orders_perp_0".into(), sender)]),
            ..Default::default()
        };

        let subscribe_sol_perp = WsClientMessage::Subscribe(WsSubscribeMessage {
            action: SubscribeActions::Subscribe,
            market_type: MarketType::Perp,
            market_name: "sol".into(),
        });

        let res =
            ws_conn.handle_client_message(subscribe_sol_perp, Box::leak(Box::new(shared_state)));
        assert!(res.is_ok());
    }

    #[tokio::test]
    async fn subscribe_unauthenticated_fail() {
        let mut ws_conn = WsConnection::new(Pubkey::new_unique());

        let subscribe_sol_perp = WsClientMessage::Subscribe(WsSubscribeMessage {
            action: SubscribeActions::Subscribe,
            market_type: MarketType::Perp,
            market_name: "sol".into(),
        });

        let res = ws_conn.handle_client_message(subscribe_sol_perp, Box::leak(Box::default()));
        assert_eq!(res, Err(WsError::Unauthenticated));
    }

    #[tokio::test]
    async fn ws_on_connect_receive_challenge() {
        let _ = env_logger::try_init();
        let mut client_rx = vec![];
        let mut client_tx = stream::iter(vec![]);

        let ws_conn = WsConnection::new(Pubkey::new_unique());
        let expected_nonce = ws_conn.nonce().expect("nonce init");

        let _res = tokio::time::timeout(
            Duration::from_millis(100),
            ws_conn.spawn_handler(
                &mut client_rx,
                &mut client_tx,
                Box::leak(Box::new(ServerParams::default())),
            ),
        )
        .await;

        let auth_response_raw = client_rx.pop().expect("has auth message");
        let auth_response: Value =
            serde_json::from_str(auth_response_raw.to_text().unwrap()).unwrap();
        dbg!(&auth_response);

        assert_eq!(
            auth_response.get("channel").map(|m| m.as_str()).unwrap(),
            Some("auth"),
        );
        assert_eq!(
            auth_response.get("nonce").map(|m| m.as_str()).unwrap(),
            Some(expected_nonce.as_str()),
        );
    }

    #[tokio::test]
    async fn ws_receive_heartbeat() {
        let _ = env_logger::try_init();
        let mut client_rx = vec![];
        let mut client_tx = stream::pending();
        let mut ws_conn = WsConnection::new(Pubkey::new_unique());
        ws_conn.authenticated = true;

        let _ = tokio::time::timeout(
            (HEARTBEAT_INTERVAL * 2) + Duration::from_millis(1_000),
            ws_conn.spawn_handler(
                &mut client_rx,
                &mut client_tx,
                Box::leak(Box::new(ServerParams::default())),
            ),
        )
        .await;

        dbg!(&client_rx);

        let hb_raw = client_rx.get(1).expect("has hb message");
        let hb: Value = serde_json::from_str(hb_raw.to_text().unwrap()).unwrap();

        assert_eq!(
            hb.get("channel").map(|m| m.as_str()).unwrap(),
            Some("heartbeat"),
        );
        // 2 heartbeats
        assert!(client_rx.get(1).unwrap().is_text());
        assert!(client_rx.get(2).unwrap().is_text());
    }

    #[tokio::test]
    async fn ws_forwards_outbox_messages() {
        let _ = env_logger::try_init();

        let mut client_rx = vec![];
        let mut client_tx = stream::pending();

        let ws_conn = WsConnection::new(Pubkey::new_unique());

        // queue up a bunch of messages
        for i in 1..=8 {
            let _ = ws_conn.send_message(WsMessage::auth().set_message(&format!("msg{i}")));
        }

        let _res = tokio::time::timeout(
            Duration::from_millis(100),
            ws_conn.spawn_handler(
                &mut client_rx,
                &mut client_tx,
                Box::leak(Box::new(ServerParams::default())),
            ),
        )
        .await;

        dbg!(&client_rx);
        assert!(client_rx.len() > 8);
    }

    #[tokio::test]
    async fn ws_forwards_subscribed_topics_with_priority() {
        let _ = env_logger::try_init();
        let base_delay_ms = 500;
        struct TestCase {
            is_fast: bool,
            delay_ms: u64,
            expect_update: bool,
        }
        let test_cases = [
            TestCase {
                is_fast: false,
                delay_ms: base_delay_ms,
                expect_update: false,
            },
            TestCase {
                is_fast: false,
                delay_ms: base_delay_ms + (2 * FAST_SLOW_WS_DIFF.as_millis() as u64),
                expect_update: true,
            },
            TestCase {
                is_fast: true,
                delay_ms: base_delay_ms,
                expect_update: true,
            },
        ];

        for (
            idx,
            TestCase {
                delay_ms,
                is_fast,
                expect_update,
            },
        ) in test_cases.into_iter().enumerate()
        {
            dbg!("TEST CASE****", idx);
            let mut client_rx = vec![];
            // client subscribes, then waits
            let mut client_tx = stream::iter([Ok(Message::Text(
                json!({
                    "channel": "subscribe",
                    "action": "subscribe",
                    "market_type": "perp",
                    "market_name": "sol",
                })
                .to_string(),
            ))])
            .chain(stream::pending());

            let (sender, _receiver) = broadcast::channel(8);
            let shared_state = Box::leak(Box::new(ServerParams {
                perp_markets: vec![sol_perp_market()],
                subscriptions: DashMap::from_iter([("swift_orders_perp_0".into(), sender.clone())]),
                ..Default::default()
            }));

            let mut ws_conn = WsConnection::new(Pubkey::new_unique());
            ws_conn.authenticated = true;
            ws_conn
                .fast_ws
                .store(is_fast, std::sync::atomic::Ordering::Relaxed);

            // spawn upstream publisher
            tokio::spawn(async move {
                // wait to send the update after the Ws connection is alive
                tokio::time::sleep(Duration::from_millis(50)).await;
                sender
                    .send(OrderNotification {
                        json: "wow much update".into(),
                        recv_lag: 0,
                    })
                    .expect("sent");
            });

            // run Ws connection
            let _ = tokio::time::timeout(
                Duration::from_millis(delay_ms),
                ws_conn.spawn_handler(&mut client_rx, &mut client_tx, shared_state),
            )
            .await;

            dbg!(&client_rx);

            assert_eq!(
                client_rx
                    .iter()
                    .any(|x| x.to_text().unwrap() == "wow much update"),
                expect_update
            );
        }
    }

    #[tokio::test]
    async fn ws_close_on_bad_client_message() {
        let _ = env_logger::try_init();

        let mut client_rx = vec![];
        let mut client_tx = stream::iter([Ok(Message::text("hmm think this is bad"))]);

        let mut ws_conn = WsConnection::new(Pubkey::new_unique());
        ws_conn.authenticated = true;

        let _ = ws_conn
            .spawn_handler(&mut client_rx, &mut client_tx, Box::leak(Box::default()))
            .await;

        let last_msg = client_rx.last().cloned().unwrap().into_text().unwrap();
        assert!(last_msg.contains("Error"));
    }

    #[tokio::test]
    async fn ws_close_cleanup_ok() {
        let _ = env_logger::try_init();
        let mut client_rx = vec![];
        // empty input from client causes Ws to close
        // it should not hang e.g. during outbox draining
        let mut client_tx = stream::empty();
        let ws_conn = WsConnection::new(Pubkey::new_unique());

        let res = tokio::time::timeout(
            Duration::from_secs(5),
            ws_conn.spawn_handler(&mut client_rx, &mut client_tx, Box::leak(Box::default())),
        );

        assert!(res.await.is_ok(), "Ws cleanup hanging...");
    }

    #[tokio::test]
    async fn ws_close_on_close_msg() {
        let _ = env_logger::try_init();
        let mut client_rx = vec![];
        let mut client_tx = stream::iter([Ok(Message::Close(None))]);
        let ws_conn = WsConnection::new(Pubkey::new_unique());
        let _ = ws_conn
            .spawn_handler(&mut client_rx, &mut client_tx, Box::leak(Box::default()))
            .await;
    }

    #[tokio::test]
    async fn batch_send_outbox() {
        let _ = env_logger::try_init();
        let mut client_rx = vec![];
        let mut client_tx = stream::iter([Ok(Message::Close(None))]);
        let ws_conn = WsConnection::new(Pubkey::new_unique());
        let _ = ws_conn.send_message(WsMessage::heartbeat());
        let _ = ws_conn.send_message(WsMessage::heartbeat());
        let _ = ws_conn.send_message(WsMessage::heartbeat());
        let _ = ws_conn
            .spawn_handler(&mut client_rx, &mut client_tx, Box::leak(Box::default()))
            .await;
        assert!(client_rx.len() >= 3);
    }
}
