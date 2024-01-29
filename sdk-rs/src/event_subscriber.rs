use std::{
    collections::VecDeque,
    str::FromStr,
    sync::{Arc, OnceLock},
    task::{Context, Poll},
    time::Duration,
};

use anchor_lang::{AnchorDeserialize, Discriminator};
use drift_program::{
    controller::position::PositionDirection,
    state::{
        events::{OrderAction, OrderActionExplanation, OrderActionRecord, OrderRecord},
        user::{MarketType, Order},
    },
};
use fnv::FnvHashSet;
use futures_util::{future::BoxFuture, stream::FuturesOrdered, FutureExt, Stream, StreamExt};
use log::{debug, warn};
use regex::Regex;
pub use solana_client::nonblocking::{pubsub_client::PubsubClient, rpc_client::RpcClient};
use solana_client::{
    rpc_client::GetConfirmedSignaturesForAddress2Config, rpc_config::RpcTransactionLogsConfig,
};
pub use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::{pubkey::Pubkey, signature::Signature, transaction::VersionedTransaction};
use solana_transaction_status::{
    option_serializer::OptionSerializer, EncodedTransactionWithStatusMeta, UiTransactionEncoding,
};
use tokio::{
    sync::{
        mpsc::{channel, Receiver, Sender},
        RwLock,
    },
    task::JoinHandle,
};

use crate::{
    async_utils::{retry_policy::TaskRetryPolicy, spawn_retry_task},
    constants,
    types::SdkResult,
};

const LOG_TARGET: &str = "events";

impl EventRpcProvider for RpcClient {
    fn get_tx(
        &self,
        signature: Signature,
    ) -> BoxFuture<SdkResult<EncodedTransactionWithStatusMeta>> {
        async move {
            let result = self
                .get_transaction_with_config(
                    &signature,
                    solana_client::rpc_config::RpcTransactionConfig {
                        encoding: Some(UiTransactionEncoding::Base64),
                        max_supported_transaction_version: Some(0),
                        ..Default::default()
                    },
                )
                .await?;

            Ok(result.transaction)
        }
        .boxed()
    }
    fn get_tx_signatures(
        &self,
        account: Pubkey,
        after: Option<Signature>,
        limit: Option<usize>,
    ) -> BoxFuture<SdkResult<Vec<String>>> {
        async move {
            let results = self
                .get_signatures_for_address_with_config(
                    &account,
                    GetConfirmedSignaturesForAddress2Config {
                        until: after,
                        limit,
                        ..Default::default()
                    },
                )
                .await?;

            Ok(results.iter().map(|r| r.signature.clone()).collect())
        }
        .boxed()
    }
}

/// RPC functions required for drift event subscriptions
pub trait EventRpcProvider: Send + Sync + 'static {
    /// Fetch tx signatures of account
    /// `after` only return txs more recent than this signature, if given
    /// `limit` return at most this many signatures, if given
    fn get_tx_signatures(
        &self,
        account: Pubkey,
        after: Option<Signature>,
        limit: Option<usize>,
    ) -> BoxFuture<SdkResult<Vec<String>>>;
    /// Fetch tx with `signature`
    fn get_tx(
        &self,
        signature: Signature,
    ) -> BoxFuture<SdkResult<EncodedTransactionWithStatusMeta>>;
}

/// Provides sub-account event streaming
pub struct EventSubscriber;

impl EventSubscriber {
    /// Subscribe to drift events of `sub_account`, backed by Ws APIs
    ///
    /// The underlying stream will reconnect according to the given `retry_policy`
    pub fn subscribe(
        provider: PubsubClient,
        rpc_provider: impl EventRpcProvider,
        sub_account: Pubkey,
        retry_policy: impl TaskRetryPolicy,
    ) -> DriftEventStream {
        log_stream(provider, rpc_provider, sub_account, retry_policy)
    }
    /// Subscribe to drift events of `sub_account`, backed by RPC polling APIs
    pub fn subscribe_polled(provider: impl EventRpcProvider, account: Pubkey) -> DriftEventStream {
        polled_stream(provider, account)
    }
}

struct LogEventStream {
    cache: Arc<RwLock<TxSignatureCache>>,
    provider: Arc<PubsubClient>,
    sub_account: Pubkey,
    event_tx: Sender<DriftEvent>,
    commitment: CommitmentConfig,
}

impl LogEventStream {
    /// Returns a future for running the configured log event stream
    async fn stream_fn(self) {
        let sub_account = self.sub_account;
        let subscribe_result = self
            .provider
            .logs_subscribe(
                solana_client::rpc_config::RpcTransactionLogsFilter::Mentions(vec![
                    sub_account.to_string()
                ]),
                RpcTransactionLogsConfig {
                    commitment: Some(self.commitment),
                },
            )
            .await;
        if let Err(err) = subscribe_result {
            warn!(target: LOG_TARGET, "log subscription failed: {sub_account:?} with: {err:?}");
            return;
        }

        let (mut log_stream, _) = subscribe_result.unwrap();
        debug!(target: LOG_TARGET, "start log subscription: {sub_account:?}");

        let mut cache = self.cache.write().await;
        while let Some(response) = log_stream.next().await {
            // don't emit events for failed txs
            if response.value.err.is_some() {
                debug!(target: LOG_TARGET, "skipping event for failed tx: {}", response.value.signature);
                continue;
            }
            let signature = response.value.signature;
            if cache.contains(&signature) {
                continue;
            }
            cache.insert(signature.clone());

            for log in response.value.logs {
                // a drift sub-account should not interact with any other program by definition
                if let Some(event) = try_parse_log(log.as_str(), &signature) {
                    // unrelated events from same tx should not be emitted e.g. a filler tx which produces other fill events
                    if event.pertains_to(sub_account) {
                        // TODO: if we can't send then the event is lost...
                        // outer retry is not appropriate, must bail
                        self.event_tx.try_send(event).expect("sent");
                    }
                }
            }
        }
    }
}

/// Creates a poll-ed stream using JSON-RPC interfaces
fn polled_stream(provider: impl EventRpcProvider, sub_account: Pubkey) -> DriftEventStream {
    let (event_tx, event_rx) = channel(64);
    let cache = Arc::new(RwLock::new(TxSignatureCache::new(128)));
    let join_handle = tokio::spawn(
        PolledEventStream {
            cache: Arc::clone(&cache),
            provider,
            sub_account,
            event_tx,
        }
        .stream_fn(),
    );

    DriftEventStream {
        rx: event_rx,
        task: join_handle,
    }
}

/// Creates a Ws-backed event stream using `logsSubscribe` interface
fn log_stream(
    provider: PubsubClient,
    rpc_provider: impl EventRpcProvider,
    sub_account: Pubkey,
    retry_policy: impl TaskRetryPolicy,
) -> DriftEventStream {
    debug!(target: LOG_TARGET, "stream events for {sub_account:?}");
    let (event_tx, event_rx) = channel(64);
    let provider = Arc::new(provider);
    let cache = Arc::new(RwLock::new(TxSignatureCache::new(128)));

    let _handle = tokio::spawn(
        PolledEventStream {
            cache: Arc::clone(&cache),
            provider: rpc_provider,
            sub_account,
            event_tx: event_tx.clone(),
        }
        .stream_fn(),
    );

    // spawn the event subscription task
    let join_handle = spawn_retry_task(
        move || {
            let log_stream = LogEventStream {
                cache: Arc::clone(&cache),
                provider: Arc::clone(&provider),
                sub_account,
                event_tx: event_tx.clone(),
                commitment: CommitmentConfig::confirmed(),
            };
            log_stream.stream_fn()
        },
        retry_policy,
    );

    DriftEventStream {
        rx: event_rx,
        task: join_handle,
    }
}

pub struct PolledEventStream<T: EventRpcProvider> {
    cache: Arc<RwLock<TxSignatureCache>>,
    event_tx: Sender<DriftEvent>,
    provider: T,
    sub_account: Pubkey,
}

impl<T: EventRpcProvider> PolledEventStream<T> {
    async fn stream_fn(self) {
        debug!(target: LOG_TARGET, "poll events for {:?}", self.sub_account);
        // poll for events in any tx after this tx
        // initially fetch the most recent tx from account
        debug!(target: LOG_TARGET, "fetch initial txs");
        let res = self
            .provider
            .get_tx_signatures(self.sub_account, None, Some(1))
            .await;
        debug!(target: LOG_TARGET, "fetched initial txs");

        let mut last_seen_tx = res.expect("fetched tx").first().cloned();
        let provider_ref = &self.provider;
        'outer: loop {
            // don't needlessly spam the RPC or hog the executor
            tokio::time::sleep(Duration::from_millis(400)).await;

            debug!(target: LOG_TARGET, "poll txs for events");
            let signatures = provider_ref
                .get_tx_signatures(
                    self.sub_account,
                    last_seen_tx
                        .clone()
                        .map(|s| Signature::from_str(&s).unwrap()),
                    None,
                )
                .await;

            if let Err(err) = signatures {
                warn!(target: LOG_TARGET, "poll tx signatures: {err:?}");
                continue;
            }

            let signatures = signatures.unwrap();
            // txs from RPC are ordered newest to oldest
            // process in reverse order, so subscribers receive events in chronological order
            let mut futs = {
                let cache = self.cache.read().await;
                FuturesOrdered::from_iter(
                    signatures
                        .into_iter()
                        .filter(|s| !cache.contains(s))
                        .map(|s| async move {
                            (
                                s.clone(),
                                provider_ref
                                    .get_tx(
                                        Signature::from_str(s.as_str()).expect("valid signature"),
                                    )
                                    .await,
                            )
                        })
                        .rev(),
                )
            };
            if futs.is_empty() {
                continue;
            }
            let mut cache = self.cache.write().await;

            while let Some((signature, response)) = futs.next().await {
                if let Err(err) = response {
                    warn!(target: LOG_TARGET, "poll processing tx: {err:?}");
                    // retry querying the batch
                    continue 'outer;
                }

                last_seen_tx = Some(signature.clone());
                cache.insert(signature.clone());

                let EncodedTransactionWithStatusMeta {
                    meta, transaction, ..
                } = response.unwrap();
                if meta.is_none() {
                    continue;
                }
                let meta = meta.unwrap();

                if let Some(VersionedTransaction { message, .. }) = transaction.decode() {
                    // only txs interacting with drift program
                    if !message
                        .static_account_keys()
                        .iter()
                        .any(|k| k == &constants::PROGRAM_ID)
                    {
                        continue;
                    }
                }
                // ignore failed txs
                if meta.err.is_some() {
                    continue;
                }

                if let OptionSerializer::Some(logs) = meta.log_messages {
                    for log in logs {
                        if let Some(event) = try_parse_log(log.as_str(), signature.as_str()) {
                            if event.pertains_to(self.sub_account) {
                                self.event_tx.try_send(event).expect("sent");
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Provides a stream API of drift sub-account events
pub struct DriftEventStream {
    /// handle to end the stream task
    task: JoinHandle<()>,
    /// channel of events from stream task
    rx: Receiver<DriftEvent>,
}

impl DriftEventStream {
    /// End the event stream
    pub fn unsubscribe(&self) {
        self.task.abort();
    }
}

impl Drop for DriftEventStream {
    fn drop(&mut self) {
        self.unsubscribe()
    }
}

impl Stream for DriftEventStream {
    type Item = DriftEvent;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        self.as_mut().rx.poll_recv(cx)
    }
}

const PROGRAM_LOG: &str = "Program log: ";
const PROGRAM_DATA: &str = "Program data: ";

/// Try deserialize a drift event type from raw log string
/// https://github.com/coral-xyz/anchor/blob/9d947cb26b693e85e1fd26072bb046ff8f95bdcf/client/src/lib.rs#L552
fn try_parse_log(raw: &str, signature: &str) -> Option<DriftEvent> {
    // Log emitted from the current program.
    if let Some(log) = raw
        .strip_prefix(PROGRAM_LOG)
        .or_else(|| raw.strip_prefix(PROGRAM_DATA))
    {
        if let Ok(borsh_bytes) = anchor_lang::__private::base64::decode(log) {
            let (disc, mut data) = borsh_bytes.split_at(8);
            let disc: [u8; 8] = disc.try_into().unwrap();

            return DriftEvent::from_discriminant(disc, &mut data, signature);
        }

        let order_cancel_missing_re = ORDER_CANCEL_MISSING_RE
            .get_or_init(|| Regex::new(r"could not find( user){0,1} order id (\d+)").unwrap());
        if let Some(captures) = order_cancel_missing_re.captures(log) {
            let order_id = captures
                .get(2)
                .unwrap()
                .as_str()
                .parse::<u32>()
                .expect("<u32");
            let event = if captures.get(1).is_some() {
                // cancel by user order Id
                DriftEvent::OrderCancelMissing {
                    user_order_id: order_id as u8,
                    order_id: 0,
                    signature: signature.to_string(),
                }
            } else {
                // cancel by order id
                DriftEvent::OrderCancelMissing {
                    user_order_id: 0,
                    order_id,
                    signature: signature.to_string(),
                }
            };

            return Some(event);
        }
    }

    None
}

static ORDER_CANCEL_MISSING_RE: OnceLock<Regex> = OnceLock::new();

/// Enum of all drift program events
#[derive(Debug, PartialEq)]
pub enum DriftEvent {
    OrderFill {
        maker: Option<Pubkey>,
        maker_fee: i64,
        maker_order_id: u32,
        maker_side: Option<PositionDirection>,
        taker: Option<Pubkey>,
        taker_fee: u64,
        taker_order_id: u32,
        taker_side: Option<PositionDirection>,
        base_asset_amount_filled: u64,
        quote_asset_amount_filled: u64,
        market_index: u16,
        market_type: MarketType,
        oracle_price: i64,
        signature: String,
        ts: u64,
    },
    OrderCancel {
        taker: Option<Pubkey>,
        maker: Option<Pubkey>,
        taker_order_id: u32,
        maker_order_id: u32,
        signature: String,
        ts: u64,
    },
    /// An order cancel for a missing order Id / user order id
    OrderCancelMissing {
        user_order_id: u8,
        order_id: u32,
        signature: String,
    },
    OrderCreate {
        order: Order,
        ts: u64,
        signature: String,
    },
    // sub-case of cancel?
    OrderExpire {
        order_id: u32,
        fee: u64,
        ts: u64,
        signature: String,
    },
}

impl DriftEvent {
    /// Return true if the event is connected to sub-account
    fn pertains_to(&self, sub_account: Pubkey) -> bool {
        let subject = &Some(sub_account);
        match self {
            Self::OrderCancel { taker, maker, .. } => maker == subject || taker == subject,
            Self::OrderFill { maker, taker, .. } => maker == subject || taker == subject,
            // these order types are contextual
            Self::OrderCreate { .. }
            | Self::OrderExpire { .. }
            | Self::OrderCancelMissing { .. } => true,
        }
    }
    /// Deserialize drift event by discriminant
    fn from_discriminant(disc: [u8; 8], data: &mut &[u8], signature: &str) -> Option<Self> {
        match disc {
            // deser should only fail on a breaking protocol changes
            OrderActionRecord::DISCRIMINATOR => Self::from_oar(
                OrderActionRecord::deserialize(data).expect("deserializes"),
                signature,
            ),
            OrderRecord::DISCRIMINATOR => Self::from_order_record(
                OrderRecord::deserialize(data).expect("deserializes"),
                signature,
            ),
            _ => {
                debug!(target: LOG_TARGET, "unhandled event: {disc:?}");
                None
            }
        }
    }
    fn from_order_record(value: OrderRecord, signature: &str) -> Option<Self> {
        Some(DriftEvent::OrderCreate {
            order: value.order,
            ts: value.ts.unsigned_abs(),
            signature: signature.to_string(),
        })
    }
    fn from_oar(value: OrderActionRecord, signature: &str) -> Option<Self> {
        match value.action {
            OrderAction::Cancel => {
                if let OrderActionExplanation::OrderExpired = value.action_explanation {
                    // TODO: would be nice to report the `user_order_id` too...
                    Some(DriftEvent::OrderExpire {
                        fee: value.filler_reward.unwrap_or_default(),
                        order_id: value
                            .maker_order_id
                            .or(value.taker_order_id)
                            .expect("order id set"),
                        ts: value.ts.unsigned_abs(),
                        signature: signature.to_string(),
                    })
                } else {
                    Some(DriftEvent::OrderCancel {
                        maker: value.maker,
                        taker: value.taker,
                        maker_order_id: value.maker_order_id.unwrap_or_default(),
                        taker_order_id: value.taker_order_id.unwrap_or_default(),
                        ts: value.ts.unsigned_abs(),
                        signature: signature.to_string(),
                    })
                }
            }
            OrderAction::Fill => Some(DriftEvent::OrderFill {
                maker: value.maker,
                maker_fee: value.maker_fee.unwrap_or_default(),
                maker_order_id: value.maker_order_id.unwrap_or_default(),
                maker_side: value.maker_order_direction,
                taker: value.taker,
                taker_fee: value.taker_fee.unwrap_or_default(),
                taker_order_id: value.taker_order_id.unwrap_or_default(),
                taker_side: value.taker_order_direction,
                base_asset_amount_filled: value.base_asset_amount_filled.unwrap_or_default(),
                quote_asset_amount_filled: value.quote_asset_amount_filled.unwrap_or_default(),
                oracle_price: value.oracle_price,
                market_index: value.market_index,
                market_type: value.market_type,
                ts: value.ts.unsigned_abs(),
                signature: signature.to_string(),
            }),
            // Place - parsed from `OrderRecord` event, ignored here due to lack of useful info
            // Expire - never emitted
            // Trigger - unimplemented
            OrderAction::Place | OrderAction::Expire | OrderAction::Trigger => None,
        }
    }
}

/// fixed capacity cache of tx signatures
struct TxSignatureCache {
    capacity: usize,
    entries: FnvHashSet<String>,
    age: VecDeque<String>,
}

impl TxSignatureCache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: FnvHashSet::<String>::with_capacity_and_hasher(capacity, Default::default()),
            age: VecDeque::with_capacity(capacity),
        }
    }
    fn contains(&self, x: &str) -> bool {
        self.entries.contains(x)
    }
    fn insert(&mut self, x: String) {
        self.entries.insert(x.clone());
        self.age.push_back(x);

        if self.age.len() >= self.capacity {
            if let Some(ref oldest) = self.age.pop_front() {
                self.entries.remove(oldest);
            }
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::async_utils::retry_policy::{self};

    #[ignore]
    #[tokio::test]
    async fn event_streaming_logs() {
        let mut event_stream = EventSubscriber::subscribe(
            PubsubClient::new("wss://api.devnet.solana.com")
                .await
                .expect("connects"),
            RpcClient::new("https://api.devnet.solana.com".to_string()),
            Pubkey::from_str("9JtczxrJjPM4J1xooxr2rFXmRivarb4BwjNiBgXDwe2p").unwrap(),
            retry_policy::never(),
        )
        .take(5);

        while let Some(event) = event_stream.next().await {
            dbg!(event);
        }
    }

    #[test]
    fn test_log() {
        let result = try_parse_log("Program log: 4DRDR8LtbQH+x7JlAAAAAAIIAAABAbpHl8YM/aWjrjfQ48x0R2DclPigyXtYx+5d/vSVjUIZAQoCAAAAAAAAAaJhIgAAAAAAAQDC6wsAAAAAAZjQCQEAAAAAAWsUAAAAAAAAAWTy////////AAAAAaNzGgMga9TnxjVkycO4bmqSGjK6kP92OrKdZMYqFV+aAS4eKQ4BAQEAHkHaNAAAAAEAwusLAAAAAAGY0AkBAAAAAAFneQwBwHPUIY9ykEdbxsTV7Lh6K+vISfq8nLCTm/rWoAHwCQAAAQABAMLrCwAAAAABAMLrCwAAAAABmNAJAQAAAAA9Zy8FAAAAAA==", "sig");
        dbg!(result);
    }
}
