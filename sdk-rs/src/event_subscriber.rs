use std::{
    str::FromStr,
    sync::Arc,
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
use futures_util::{
    future::BoxFuture, stream::FuturesOrdered, Future, FutureExt, Stream, StreamExt,
};
use log::{debug, error, warn};
use serde::Serializer;
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
    sync::mpsc::{channel, Receiver, Sender},
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
    ) -> BoxFuture<SdkResult<Vec<Signature>>> {
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

            Ok(results
                .iter()
                .map(|r| Signature::from_str(r.signature.as_str()).expect("ok"))
                .collect())
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
    ) -> BoxFuture<SdkResult<Vec<Signature>>>;
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
        sub_account: Pubkey,
        retry_policy: impl TaskRetryPolicy,
    ) -> DriftEventStream {
        log_stream(provider, sub_account, retry_policy)
    }
    /// Subscribe to drift events of `sub_account`, backed by RPC polling APIs
    pub fn subscribe_polled(provider: impl EventRpcProvider, account: Pubkey) -> DriftEventStream {
        polled_stream(provider, account)
    }
}

struct LogEventStream {
    provider: Arc<PubsubClient>,
    sub_account: Pubkey,
    event_tx: Sender<DriftEvent>,
}

impl LogEventStream {
    /// Returns a future for running the configured log event stream
    fn stream_fn(&self) -> impl Future<Output = ()> {
        let sub_account = self.sub_account;
        let provider_ref = Arc::clone(&self.provider);
        let event_tx = self.event_tx.clone();
        async move {
            let subscribe_result = provider_ref
                .logs_subscribe(
                    solana_client::rpc_config::RpcTransactionLogsFilter::Mentions(vec![
                        sub_account.to_string(),
                    ]),
                    RpcTransactionLogsConfig {
                        commitment: Some(CommitmentConfig::processed()),
                    },
                )
                .await;
            if let Err(err) = subscribe_result {
                warn!(target: LOG_TARGET, "log subscription failed: {sub_account:?} with: {err:?}");
                return;
            }

            let (mut log_stream, _) = subscribe_result.unwrap();
            debug!(target: LOG_TARGET, "start log subscription: {sub_account:?}");

            while let Some(response) = log_stream.next().await {
                // don't emit events for failed txs
                if response.value.err.is_some() {
                    continue;
                }
                for log in response.value.logs {
                    // a drift sub-account should not interact with any other program by definition
                    if let Some(event) = try_parse_log(log.as_str()) {
                        // unrelated events from same tx should not be emitted e.g. a filler tx which produces other fill events
                        if event.pertains_to(sub_account) {
                            // TODO: handle RevertFill semantics
                            event_tx.try_send(event).expect("sent");
                        }
                    }
                }
            }
        }
    }
}

/// Creates a Ws-backed event stream using `logsSubscribe` interface
fn log_stream(
    provider: PubsubClient,
    sub_account: Pubkey,
    retry_policy: impl TaskRetryPolicy,
) -> DriftEventStream {
    debug!(target: LOG_TARGET, "stream events for {sub_account:?}");
    let (event_tx, event_rx) = channel(32);
    let log_stream = LogEventStream {
        provider: Arc::new(provider),
        sub_account,
        event_tx,
    };

    // spawn the event subscription task
    let join_handle = spawn_retry_task(move || log_stream.stream_fn(), retry_policy);

    DriftEventStream {
        rx: event_rx,
        task: join_handle,
    }
}

/// Creates a polled event stream from RPC only interfaces `getTxSignatures` and `getTx`
pub fn polled_stream(provider: impl EventRpcProvider, sub_account: Pubkey) -> DriftEventStream {
    debug!(target: LOG_TARGET, "stream events for {sub_account:?}");
    let (event_tx, event_rx) = channel(32);

    // spawn the event subscription task
    let join_handle = tokio::spawn(async move {
        // poll for events in any tx after this tx
        // initially fetch the most recent tx from account
        debug!(target: LOG_TARGET, "fetch initial txs");
        let res = provider.get_tx_signatures(sub_account, None, Some(1)).await;
        debug!(target: LOG_TARGET, "fetched initial txs");

        let mut last_seen_tx = res.expect("fetched tx").first().cloned();
        let provider_ref = &provider;
        loop {
            debug!(target: LOG_TARGET, "searching txs for events");
            let signatures = provider_ref
                .get_tx_signatures(sub_account, last_seen_tx, Some(16))
                .await
                .expect("fetched txs");

            // txs from RPC are ordered newest to oldest
            // process in reverse order, so subscribers receive events in chronological order
            let mut futs = FuturesOrdered::from_iter(
                signatures
                    .into_iter()
                    .map(|s| async move { (s, provider_ref.get_tx(s).await) })
                    .rev(),
            );

            while let Some((sig, response)) = futs.next().await {
                // TODO: on RPC error should attempt to re-query the tx
                last_seen_tx = Some(sig);
                if let Err(err) = response {
                    error!(target: LOG_TARGET, "processing tx: {err:?}");
                    continue;
                }
                let response = response.unwrap();
                if response.meta.is_none() {
                    continue;
                }
                if let Some(VersionedTransaction { message, .. }) = response.transaction.decode() {
                    // only txs interacting with drift program
                    if !message
                        .static_account_keys()
                        .iter()
                        .any(|k| k == &constants::PROGRAM_ID)
                    {
                        continue;
                    }
                }

                if let OptionSerializer::Some(logs) = response.meta.unwrap().log_messages {
                    for log in logs {
                        if let Some(event) = try_parse_log(log.as_str()) {
                            if event.pertains_to(sub_account) {
                                event_tx.try_send(event).expect("sent");
                            }
                        }
                    }
                }
            }
            // don't spam the RPC nor spin lock the tokio thread
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    });

    DriftEventStream {
        rx: event_rx,
        task: join_handle,
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
fn try_parse_log(raw: &str) -> Option<DriftEvent> {
    // Log emitted from the current program.
    if let Some(log) = raw
        .strip_prefix(PROGRAM_LOG)
        .or_else(|| raw.strip_prefix(PROGRAM_DATA))
    {
        if let Ok(borsh_bytes) = anchor_lang::__private::base64::decode(log) {
            let (disc, mut data) = borsh_bytes.split_at(8);
            let disc: [u8; 8] = disc.try_into().unwrap();

            return DriftEvent::from_discriminant(disc, &mut data);
        }
    }

    None
}

/// Enum of all drift program events
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DriftEvent {
    #[serde(rename_all = "camelCase")]
    OrderFill {
        #[serde(serialize_with = "serialize_pubkey")]
        maker: Option<Pubkey>,
        maker_fee: i64,
        maker_order_id: u32,
        maker_side: Option<PositionDirection>,
        #[serde(serialize_with = "serialize_pubkey")]
        taker: Option<Pubkey>,
        taker_fee: u64,
        taker_order_id: u32,
        taker_side: Option<PositionDirection>,
        base_asset_amount_filled: u64,
        quote_asset_amount_filled: u64,
        market_index: u16,
        market_type: MarketType,
        oracle_price: i64,
        ts: u64,
    },
    #[serde(rename_all = "camelCase")]
    OrderCancel {
        #[serde(serialize_with = "serialize_pubkey")]
        taker: Option<Pubkey>,
        #[serde(serialize_with = "serialize_pubkey")]
        maker: Option<Pubkey>,
        taker_order_id: u32,
        maker_order_id: u32,
        ts: u64,
    },
    #[serde(rename_all = "camelCase")]
    OrderCreate { order: Order, ts: u64 },
    // sub-case of cancel?
    #[serde(rename_all = "camelCase")]
    OrderExpire { order_id: u32, fee: u64, ts: u64 },
}

impl DriftEvent {
    /// Return true if the event is connected to sub-account
    fn pertains_to(&self, sub_account: Pubkey) -> bool {
        let subject = &Some(sub_account);
        match self {
            Self::OrderCancel { taker, maker, .. } => maker == subject || taker == subject,
            Self::OrderFill { maker, taker, .. } => maker == subject || taker == subject,
            // these order types are contextual
            Self::OrderCreate { .. } | Self::OrderExpire { .. } => true,
        }
    }
    /// Deserialize drift event by discriminant
    fn from_discriminant(disc: [u8; 8], data: &mut &[u8]) -> Option<Self> {
        match disc {
            // deser should only fail on a breaking protocol changes
            OrderActionRecord::DISCRIMINATOR => {
                Self::from_oar(OrderActionRecord::deserialize(data).expect("deserializes"))
            }
            OrderRecord::DISCRIMINATOR => {
                Self::from_order_record(OrderRecord::deserialize(data).expect("deserializes"))
            }
            _ => {
                debug!(target: LOG_TARGET, "unhandled event: {disc:?}");
                None
            }
        }
    }
    fn from_order_record(value: OrderRecord) -> Option<Self> {
        Some(DriftEvent::OrderCreate {
            order: value.order,
            ts: value.ts.unsigned_abs(),
        })
    }
    fn from_oar(value: OrderActionRecord) -> Option<Self> {
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
                    })
                } else {
                    Some(DriftEvent::OrderCancel {
                        maker: value.maker,
                        taker: value.taker,
                        maker_order_id: value.maker_order_id.unwrap_or_default(),
                        taker_order_id: value.taker_order_id.unwrap_or_default(),
                        ts: value.ts.unsigned_abs(),
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
            }),
            // Place - parsed from `OrderRecord` event, ignored here due to lack of useful info
            // Expire - never emitted
            // Trigger - unimplemented
            OrderAction::Place | OrderAction::Expire | OrderAction::Trigger => None,
        }
    }
}

fn serialize_pubkey<S>(x: &Option<Pubkey>, s: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if let Some(x) = x {
        s.serialize_str(x.to_string().as_str())
    } else {
        s.serialize_none()
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
            Pubkey::from_str("9JtczxrJjPM4J1xooxr2rFXmRivarb4BwjNiBgXDwe2p").unwrap(),
            retry_policy::never(),
        )
        .take(5);

        while let Some(event) = event_stream.next().await {
            dbg!(event);
        }
    }
}
