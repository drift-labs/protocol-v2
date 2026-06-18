use std::{collections::BTreeMap, time::Duration};

use futures_util::{
    future::{ready, BoxFuture, FutureExt},
    sink::SinkExt,
    stream::{self, BoxStream, StreamExt},
};
use log::*;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use solana_account_decoder_client_types::UiAccount;
use solana_clock::Slot;
use solana_pubkey::Pubkey;
use solana_rpc_client_api::{
    config::{
        RpcAccountInfoConfig, RpcBlockSubscribeConfig, RpcBlockSubscribeFilter,
        RpcProgramAccountsConfig, RpcSignatureSubscribeConfig, RpcTransactionLogsConfig,
        RpcTransactionLogsFilter,
    },
    error_object::RpcErrorObject,
    response::{
        Response as RpcResponse, RpcBlockUpdate, RpcKeyedAccount, RpcLogsResponse,
        RpcSignatureResult, RpcVote, SlotInfo, SlotUpdate,
    },
};
use solana_signature::Signature;
use thiserror::Error;
use tokio::{
    sync::{
        mpsc::{self, UnboundedSender},
        oneshot,
    },
    task::JoinHandle,
};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        protocol::frame::{coding::CloseCode, CloseFrame},
        Message,
    },
};
use url::Url;

pub type PubsubClientResult<T = ()> = Result<T, PubsubClientError>;

#[derive(Debug, Error)]
pub enum PubsubClientError {
    #[error("url parse error")]
    UrlParseError(#[from] url::ParseError),

    #[error("unable to connect to server")]
    ConnectionError(tokio_tungstenite::tungstenite::Error),

    #[error("websocket error")]
    WsError(#[from] tokio_tungstenite::tungstenite::Error),

    #[error("connection closed (({0})")]
    ConnectionClosed(String),

    #[error("json parse error")]
    JsonParseError(#[from] serde_json::error::Error),

    #[error("subscribe failed: {reason}")]
    SubscribeFailed { reason: String, message: String },

    #[error("unexpected message format: {0}")]
    UnexpectedMessageError(String),

    #[error("request failed: {reason}")]
    RequestFailed { reason: String, message: String },

    #[error("request error: {0}")]
    RequestError(String),

    #[error("could not find subscription id: {0}")]
    UnexpectedSubscriptionResponse(String),

    #[error("could not find node version: {0}")]
    UnexpectedGetVersionResponse(String),
}

type UnsubscribeFn = Box<dyn FnOnce() -> BoxFuture<'static, ()> + Send>;
type SubscribeResponseMsg =
    Result<(mpsc::UnboundedReceiver<Value>, UnsubscribeFn), PubsubClientError>;
type SubscribeRequestMsg = (String, Value, oneshot::Sender<SubscribeResponseMsg>);
type SubscribeResult<'a, T> = PubsubClientResult<(BoxStream<'a, T>, UnsubscribeFn)>;
type RequestMsg = (
    String,
    Value,
    oneshot::Sender<Result<Value, PubsubClientError>>,
);

#[derive(Clone)]
struct SubscriptionInfo {
    sender: UnboundedSender<Value>,
    payload: String,
}

/// A client for subscribing to messages from the RPC server.
///
/// See the [module documentation][self].
#[derive(Debug)]
pub struct PubsubClient {
    subscribe_sender: mpsc::UnboundedSender<SubscribeRequestMsg>,
    _request_sender: mpsc::UnboundedSender<RequestMsg>,
    shutdown_sender: oneshot::Sender<()>,
    ws: JoinHandle<Result<(), PubsubClientError>>,
    url: Url,
}

impl PubsubClient {
    pub async fn new(url: &str) -> PubsubClientResult<Self> {
        let url = Url::parse(url)?;

        let (subscribe_sender, subscribe_receiver) = mpsc::unbounded_channel();
        let (_request_sender, request_receiver) = mpsc::unbounded_channel();
        let (shutdown_sender, shutdown_receiver) = oneshot::channel();

        // spawn Ws manager task
        let ws_handle = tokio::spawn(PubsubClient::run_ws(
            url.clone(),
            subscribe_receiver,
            request_receiver,
            shutdown_receiver,
        ));

        #[allow(clippy::used_underscore_binding)]
        Ok(Self {
            subscribe_sender,
            _request_sender,
            shutdown_sender,
            ws: ws_handle,
            url,
        })
    }

    /// Returns the URL of the underlying Ws
    pub fn url(&self) -> Url {
        self.url.clone()
    }

    /// Returns true if the underlying Ws connection task is running
    ///
    /// NB: the actual Ws may be either connected or reconnecting
    pub fn is_running(&self) -> bool {
        !self.ws.is_finished()
    }

    pub async fn shutdown(self) -> PubsubClientResult {
        let _ = self.shutdown_sender.send(());
        self.ws.await.unwrap() // WS future should not be cancelled or panicked
    }

    async fn subscribe<'a, T>(&self, operation: &str, params: Value) -> SubscribeResult<'a, T>
    where
        T: DeserializeOwned + Send + 'a,
    {
        let (response_sender, response_receiver) = oneshot::channel();
        self.subscribe_sender
            .send((operation.to_string(), params.clone(), response_sender))
            .map_err(|err| PubsubClientError::ConnectionClosed(err.to_string()))?;

        let (notifications, unsubscribe) = response_receiver
            .await
            .map_err(|err| PubsubClientError::ConnectionClosed(err.to_string()))??;

        Ok((
            UnboundedReceiverStream::new(notifications)
                .filter_map(|value| ready(serde_json::from_value::<T>(value).ok()))
                .boxed(),
            unsubscribe,
        ))
    }

    /// Subscribe to account events.
    ///
    /// Receives messages of type [`UiAccount`] when an account's lamports or data changes.
    ///
    /// # RPC Reference
    ///
    /// This method corresponds directly to the [`accountSubscribe`] RPC method.
    ///
    /// [`accountSubscribe`]: https://solana.com/docs/rpc/websocket#accountsubscribe
    pub async fn account_subscribe(
        &self,
        pubkey: &Pubkey,
        config: Option<RpcAccountInfoConfig>,
    ) -> SubscribeResult<'_, RpcResponse<UiAccount>> {
        let params = json!([pubkey.to_string(), config]);
        self.subscribe("account", params).await
    }

    /// Subscribe to block events.
    ///
    /// Receives messages of type [`RpcBlockUpdate`] when a block is confirmed or finalized.
    ///
    /// This method is disabled by default. It can be enabled by passing
    /// `--rpc-pubsub-enable-block-subscription` to `agave-validator`.
    ///
    /// # RPC Reference
    ///
    /// This method corresponds directly to the [`blockSubscribe`] RPC method.
    ///
    /// [`blockSubscribe`]: https://solana.com/docs/rpc/websocket#blocksubscribe
    pub async fn block_subscribe(
        &self,
        filter: RpcBlockSubscribeFilter,
        config: Option<RpcBlockSubscribeConfig>,
    ) -> SubscribeResult<'_, RpcResponse<RpcBlockUpdate>> {
        self.subscribe("block", json!([filter, config])).await
    }

    /// Subscribe to transaction log events.
    ///
    /// Receives messages of type [`RpcLogsResponse`] when a transaction is committed.
    ///
    /// # RPC Reference
    ///
    /// This method corresponds directly to the [`logsSubscribe`] RPC method.
    ///
    /// [`logsSubscribe`]: https://solana.com/docs/rpc/websocket#logssubscribe
    pub async fn logs_subscribe(
        &self,
        filter: RpcTransactionLogsFilter,
        config: RpcTransactionLogsConfig,
    ) -> SubscribeResult<'_, RpcResponse<RpcLogsResponse>> {
        self.subscribe("logs", json!([filter, config])).await
    }

    /// Subscribe to program account events.
    ///
    /// Receives messages of type [`RpcKeyedAccount`] when an account owned
    /// by the given program changes.
    ///
    /// # RPC Reference
    ///
    /// This method corresponds directly to the [`programSubscribe`] RPC method.
    ///
    /// [`programSubscribe`]: https://solana.com/docs/rpc/websocket#programsubscribe
    pub async fn program_subscribe(
        &self,
        pubkey: &Pubkey,
        config: Option<RpcProgramAccountsConfig>,
    ) -> SubscribeResult<'_, RpcResponse<RpcKeyedAccount>> {
        let params = json!([pubkey.to_string(), config]);
        self.subscribe("program", params).await
    }

    /// Subscribe to vote events.
    ///
    /// Receives messages of type [`RpcVote`] when a new vote is observed. These
    /// votes are observed prior to confirmation and may never be confirmed.
    ///
    /// This method is disabled by default. It can be enabled by passing
    /// `--rpc-pubsub-enable-vote-subscription` to `agave-validator`.
    ///
    /// # RPC Reference
    ///
    /// This method corresponds directly to the [`voteSubscribe`] RPC method.
    ///
    /// [`voteSubscribe`]: https://solana.com/docs/rpc/websocket#votesubscribe
    pub async fn vote_subscribe(&self) -> SubscribeResult<'_, RpcVote> {
        self.subscribe("vote", json!([])).await
    }

    /// Subscribe to root events.
    ///
    /// Receives messages of type [`Slot`] when a new [root] is set by the
    /// validator.
    ///
    /// [root]: https://solana.com/docs/terminology#root
    ///
    /// # RPC Reference
    ///
    /// This method corresponds directly to the [`rootSubscribe`] RPC method.
    ///
    /// [`rootSubscribe`]: https://solana.com/docs/rpc/websocket#rootsubscribe
    pub async fn root_subscribe(&self) -> SubscribeResult<'_, Slot> {
        self.subscribe("root", json!([])).await
    }

    /// Subscribe to transaction confirmation events.
    ///
    /// Receives messages of type [`RpcSignatureResult`] when a transaction
    /// with the given signature is committed.
    ///
    /// This is a subscription to a single notification. It is automatically
    /// cancelled by the server once the notification is sent.
    ///
    /// # RPC Reference
    ///
    /// This method corresponds directly to the [`signatureSubscribe`] RPC method.
    ///
    /// [`signatureSubscribe`]: https://solana.com/docs/rpc/websocket#signaturesubscribe
    pub async fn signature_subscribe(
        &self,
        signature: &Signature,
        config: Option<RpcSignatureSubscribeConfig>,
    ) -> SubscribeResult<'_, RpcResponse<RpcSignatureResult>> {
        let params = json!([signature.to_string(), config]);
        self.subscribe("signature", params).await
    }

    /// Subscribe to slot events.
    ///
    /// Receives messages of type [`SlotInfo`] when a slot is processed.
    ///
    /// # RPC Reference
    ///
    /// This method corresponds directly to the [`slotSubscribe`] RPC method.
    ///
    /// [`slotSubscribe`]: https://solana.com/docs/rpc/websocket#slotsubscribe
    pub async fn slot_subscribe(&self) -> SubscribeResult<'_, SlotInfo> {
        self.subscribe("slot", json!([])).await
    }

    /// Subscribe to slot update events.
    ///
    /// Receives messages of type [`SlotUpdate`] when various updates to a slot occur.
    ///
    /// Note that this method operates differently than other subscriptions:
    /// instead of sending the message to a receiver on a channel, it accepts a
    /// `handler` callback that processes the message directly. This processing
    /// occurs on another thread.
    ///
    /// # RPC Reference
    ///
    /// This method corresponds directly to the [`slotUpdatesSubscribe`] RPC method.
    ///
    /// [`slotUpdatesSubscribe`]: https://solana.com/docs/rpc/websocket#slotsupdatessubscribe
    pub async fn slot_updates_subscribe(&self) -> SubscribeResult<'_, SlotUpdate> {
        self.subscribe("slotsUpdates", json!([])).await
    }

    async fn run_ws(
        url: Url,
        mut subscribe_receiver: mpsc::UnboundedReceiver<SubscribeRequestMsg>,
        mut request_receiver: mpsc::UnboundedReceiver<RequestMsg>,
        mut shutdown_receiver: oneshot::Receiver<()>,
    ) -> PubsubClientResult {
        // manage Ws requests and forward subscription messages to subscribers
        // this loop will retry indefinitely unless the consumer invokes `shutdown` or successive failures exceed maximum
        let max_retry_count = 3;
        let mut retry_count = 0;

        // all existing subscriptions here
        let mut request_id: u64 = 0;
        let mut subscriptions = BTreeMap::<u64, SubscriptionInfo>::new();
        let mut request_id_to_sid = BTreeMap::<u64, u64>::new();
        let (unsubscribe_sender, mut unsubscribe_receiver) = mpsc::unbounded_channel();

        'reconnect: loop {
            log::debug!(target: "ws", "PubsubClient connecting: {:?}", url.as_str());
            let mut ws = match connect_async(url.as_str()).await {
                Ok((ws, response)) => {
                    if response.status().is_server_error() || response.status().is_client_error() {
                        log::warn!(target: "ws", "couldn't reconnect: {response:?}");
                        retry_count += 1;
                        let delay = 2_u64.pow(2 + retry_count);
                        info!(target: "ws", "PubsubClient trying reconnect after {delay}s, attempt: {retry_count}/{max_retry_count}");
                        tokio::time::sleep(Duration::from_secs(delay)).await;
                        continue 'reconnect;
                    }

                    retry_count = 0;
                    ws
                }
                Err(err) => {
                    log::warn!(target: "ws", "couldn't reconnect: {err:?}");
                    if retry_count >= max_retry_count {
                        log::error!(target: "ws", "reached max reconnect attempts: {err:?}");
                        panic!("PubsubCliwnt reached max reconnect attempts: {err:?}");
                    }
                    retry_count += 1;
                    let delay = 2_u64.pow(2 + retry_count);
                    info!(target: "ws", "PubsubClient trying reconnect after {delay}s, attempt: {retry_count}/{max_retry_count}");
                    tokio::time::sleep(Duration::from_secs(delay)).await;
                    continue 'reconnect;
                }
            };

            let mut inflight_subscribes =
                BTreeMap::<u64, (String, String, oneshot::Sender<SubscribeResponseMsg>)>::new();
            let mut inflight_unsubscribes = BTreeMap::<u64, oneshot::Sender<()>>::new();
            let mut inflight_requests = BTreeMap::<u64, oneshot::Sender<_>>::new();

            // resend subscriptions
            if !subscriptions.is_empty() {
                info!(target: "ws", "resubscribing: {:?}", subscriptions.values().map(|x| x.payload.clone()).collect::<Vec<String>>());
                if let Err(err) = ws
                    .send_all(&mut stream::iter(
                        subscriptions
                            .values()
                            .cloned()
                            .map(|s| Ok(Message::text(s.payload))),
                    ))
                    .await
                {
                    error!(target: "ws", "PubsubClient failed resubscribing: {err:?}");
                    continue 'reconnect;
                }
            }

            let mut liveness_check = tokio::time::interval(Duration::from_secs(60));
            let _ = liveness_check.tick().await;

            let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
            let _ = heartbeat.tick().await;

            'manager: loop {
                tokio::select! {
                    biased;
                    // Send close on shutdown signal
                    _ = (&mut shutdown_receiver) => {
                        log::info!(target: "ws", "PubsubClient received shutdown");
                        let frame = CloseFrame { code: CloseCode::Normal, reason: "".into() };
                        let _ = ws.send(Message::Close(Some(frame))).await;
                        let _ = ws.flush().await;
                        break 'reconnect Ok(());
                    },
                    // Read incoming WebSocket message
                    next_msg = ws.next() => {
                        liveness_check.reset();
                        let msg = match next_msg {
                            Some(Ok(msg)) => msg,
                            Some(Err(err)) => {
                                log::warn!(target: "ws", "PubsubClient disconnected: {err:?}");
                                break 'manager
                            }
                            None => {
                                log::debug!(target: "ws", "PubsubClient disconnected");
                                break 'manager
                            },
                        };
                        trace!("ws.next(): {:?}", &msg);

                        // Get text from the message
                        let text = match msg {
                            Message::Text(ref text) => text,
                            Message::Close(_frame) => break 'manager,
                            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_) => continue 'manager,
                        };

                        // Notification, example:
                        // `{"jsonrpc":"2.0","method":"logsNotification","params":{"result":{...},"subscription":3114862}}`
                        let params = gjson::get(text, "params");
                        if params.exists() {
                            let sid = params.get("subscription").u64();
                            let mut unsubscribe_required = false;

                            if let Some(sub) = subscriptions.get(&sid) {
                                let result = params.get("result");
                                if result.exists() && sub.sender.send(serde_json::from_str(result.json()).expect("valid json")).is_err() {
                                    unsubscribe_required = true;
                                }
                            } else {
                                unsubscribe_required = true;
                            }

                            if unsubscribe_required {
                                let method = gjson::get(text, "method");
                                if let Some(operation) = method.str().strip_suffix("Notification") {
                                    let (response_sender, _response_receiver) = oneshot::channel();
                                    let _ = unsubscribe_sender.send((operation.to_string(), sid, response_sender));
                                }
                            }
                            // done processing notification
                            continue 'manager;
                        }

                        // Subscribe/Unsubscribe response, example:
                        // `{"jsonrpc":"2.0","result":5308752,"id":1}`
                        let id = gjson::get(text, "id");
                        if id.exists() {
                            let err = gjson::get(text, "error");
                            let err = if err.exists() {
                                match serde_json::from_str::<RpcErrorObject>(err.json()) {
                                    Ok(rpc_error_object) => {
                                        Some(format!("{} ({})",  rpc_error_object.message, rpc_error_object.code))
                                    }
                                    Err(e) => Some(format!(
                                        "Failed to deserialize RPC error response: {} [{e}]", err.str(),
                                    ))
                                }
                            } else {
                                None
                            };

                            let id = id.u64();
                            if let Some(response_sender) = inflight_requests.remove(&id) {
                                match err {
                                    Some(reason) => {
                                        let _ = response_sender.send(Err(PubsubClientError::RequestFailed { reason, message: text.to_string()}));
                                    },
                                    None => {
                                        let json_result = gjson::get(text, "result");
                                        let json_result_value = if json_result.exists() {
                                            Ok(serde_json::from_str::<Value>(json_result.json()).unwrap())
                                        } else {
                                            Err(PubsubClientError::RequestFailed { reason: "missing `result` field".into(), message: text.to_string() })
                                        };

                                        if let Err(err) = response_sender.send(json_result_value) {
                                            log::warn!(target: "ws", "Ws request failed: {err:?}");
                                            break 'manager;
                                        }
                                    }
                                }
                            } else if let Some(response_sender) = inflight_unsubscribes.remove(&id) {
                                let _ = response_sender.send(()); // do not care if receiver is closed
                            } else if let Some((operation, payload, response_sender)) = inflight_subscribes.remove(&id) {
                                match err {
                                    Some(reason) => {
                                        let _ = response_sender.send(Err(PubsubClientError::SubscribeFailed { reason, message: text.to_string()}));
                                    },
                                    None => {
                                        // Subscribe Id
                                        let sid = gjson::get(text, "result");
                                        if !sid.exists() {
                                            return Err(PubsubClientError::SubscribeFailed { reason: "invalid `result` field".into(), message: text.to_string() });
                                        }
                                        let sid = sid.u64();

                                        // Create notifications channel and unsubscribe function
                                        let (notifications_sender, notifications_receiver) = mpsc::unbounded_channel();
                                        let unsubscribe_sender = unsubscribe_sender.clone();
                                        let unsubscribe = Box::new(move || async move {
                                            let (response_sender, response_receiver) = oneshot::channel();
                                            // do nothing if ws already closed
                                            if unsubscribe_sender.send((operation, id, response_sender)).is_ok() {
                                                let _ = response_receiver.await; // channel can be closed only if ws is closed
                                            }
                                        }.boxed());

                                        if response_sender.send(Ok((notifications_receiver, unsubscribe))).is_err() {
                                            break 'manager;
                                        }
                                        log::debug!(target: "ws", "subscription added: {sid:?}");
                                        request_id_to_sid.insert(id, sid);
                                        subscriptions.insert(sid, SubscriptionInfo {
                                            sender: notifications_sender,
                                            payload,
                                        });
                                    }
                                }
                            } else if let Some(previous_sid) = request_id_to_sid.remove(&id) {
                                match err {
                                    Some(reason) => {
                                        log::error!(target: "ws", "resubscription failed: {:?}, {reason:?}", text);
                                        panic!();
                                    },
                                    None => {
                                        // Subscribe Id
                                        let sid = gjson::get(text, "result");
                                        if !sid.exists() {
                                            log::error!(target: "ws", "resubscription failed. invalid `result` field: {:?}", text);
                                            panic!();
                                        }
                                        let new_sid = sid.u64();

                                        info!(target: "ws", "resubscribed: {previous_sid:>} => {new_sid:?}");
                                        request_id_to_sid.insert(id, new_sid);
                                        let info = subscriptions.remove(&previous_sid).unwrap();
                                        subscriptions.insert(
                                            new_sid,
                                            info
                                        );
                                    }
                                }
                            } else {
                                error!(target: "ws", "PubSubClient received unknown request id: {id}");
                                break 'manager;
                            }
                            continue 'manager;
                        }
                    }
                    // Read message for subscribe
                    subscribe = subscribe_receiver.recv() => {
                        let (operation, params, response_sender) = subscribe.expect("subscribe channel");
                        request_id += 1;
                        let method = format!("{operation}Subscribe");
                        let text = json!({"jsonrpc":"2.0","id":request_id,"method":method,"params":params}).to_string();
                        if let Err(ref err) = ws.send(Message::Text(text.clone().into())).await {
                            log::warn!(target: "ws", "sending subscribe failed, {text}, {err:?}");
                            break 'manager;
                        }
                        inflight_subscribes.insert(request_id, (operation, text, response_sender));
                    },
                    // Read message for unsubscribe
                   unsubscribe = unsubscribe_receiver.recv() => {
                        let (operation, id, response_sender) = unsubscribe.expect("unsub channel");
                        if let Some(sid) = request_id_to_sid.remove(&id) {
                            subscriptions.remove(&sid);
                            request_id += 1;
                            let method = format!("{operation}Unsubscribe");
                            let text = json!({"jsonrpc":"2.0","id":request_id,"method":method,"params":[sid]}).to_string();
                            if let Err(err) = ws.send(Message::Text(text.clone().into())).await {
                                log::warn!(target: "ws", "sending unsubscribe failed: {text}, {err:?}");
                            }
                            inflight_unsubscribes.insert(request_id, response_sender);
                        }
                    },
                    // Read message for other requests
                    request = request_receiver.recv() => {
                        let (method, params, response_sender) = request.expect("request channel");
                        request_id += 1;
                        let text = json!({"jsonrpc":"2.0","id":request_id,"method":method,"params":params}).to_string();
                        if let Err(err) = ws.send(Message::Text(text.into())).await {
                            log::warn!(target: "ws", "sending request failed. {err:?}");
                        }
                        inflight_requests.insert(request_id, response_sender);
                    },
                    _ = heartbeat.tick() => {
                        ws.send(Message::Ping(Default::default())).await?;
                    },
                    _ = liveness_check.tick() => {
                        warn!(target: "ws", "PubsubClient timed out");
                        break 'manager;
                    }
                }
            }
            log::debug!(target: "ws", "manager finished");
        }
    }
}
