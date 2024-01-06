use std::{
    str::FromStr,
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
use futures_util::{future::BoxFuture, stream::FuturesOrdered, FutureExt, Stream, StreamExt};
use log::{debug, error};
use solana_client::{
    nonblocking::rpc_client::RpcClient, rpc_client::GetConfirmedSignaturesForAddress2Config,
};
use solana_sdk::{pubkey::Pubkey, signature::Signature, transaction::VersionedTransaction};
use solana_transaction_status::{
    option_serializer::OptionSerializer, EncodedTransactionWithStatusMeta, UiTransactionEncoding,
};
use tokio::sync::mpsc::{channel, Receiver};

use crate::{constants, types::SdkResult};

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

pub struct EventSubscriber<T: EventRpcProvider> {
    provider: &'static T,
}

impl<T: EventRpcProvider> EventSubscriber<T> {
    pub fn new(provider: T) -> Self {
        Self {
            provider: Box::leak(Box::new(provider)),
        }
    }

    /// Subscribe to drift events of `account`
    ///
    /// it uses an RPC polling mechanism to fetch the events
    pub fn subscribe(&self, account: Pubkey) -> DriftEventStream {
        DriftEventStream::new(self.provider, account)
    }
}

impl<T: EventRpcProvider> Drop for EventSubscriber<T> {
    fn drop(&mut self) {
        unsafe {
            drop(Box::from_raw((self.provider as *const T) as *mut T));
        }
    }
}

/// Provides a stream API of drift account events
pub struct DriftEventStream(Receiver<DriftEvent>);

impl DriftEventStream {
    pub fn new(provider: &'static impl EventRpcProvider, account: Pubkey) -> Self {
        let (event_tx, event_rx) = channel(32);

        // spawn the event subscription task
        tokio::spawn(async move {
            // poll for events in any tx after this tx
            // initially fetch the most recent tx from account
            let mut last_seen_tx = provider
                .get_tx_signatures(account, None, Some(1))
                .await
                .expect("fetched tx")
                .first()
                .cloned();

            loop {
                let signatures = provider
                    .get_tx_signatures(account, last_seen_tx, Some(16))
                    .await
                    .expect("fetched txs");

                // txs from RPC are ordered newest to oldest
                // process in reverse order, so subscribers receive events in chronological order
                let mut futs = FuturesOrdered::from_iter(
                    signatures
                        .into_iter()
                        .map(|s| async move { (s, provider.get_tx(s).await) })
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
                    if let Some(VersionedTransaction { message, .. }) =
                        response.transaction.decode()
                    {
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
                                event_tx.try_send(event).expect("sent");
                            }
                        }
                    }
                }
                // don't spam the RPC nor spin lock the tokio thread
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });

        Self(event_rx)
    }
}

impl Stream for DriftEventStream {
    type Item = DriftEvent;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        self.as_mut().0.poll_recv(cx)
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
        market_index: u16,
        market_type: MarketType,
        ts: u64,
    },
    OrderCancel {
        taker: Option<Pubkey>,
        maker: Option<Pubkey>,
        taker_order_id: u32,
        maker_order_id: u32,
        ts: u64,
    },
    OrderCreate {
        order: Order,
        ts: u64,
    },
    // sub-case of cancel?
    OrderExpire {
        order_id: u32,
        fee: u64,
        ts: u64,
    },
}

impl DriftEvent {
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

#[cfg(test)]
mod test {
    use solana_sdk::commitment_config::CommitmentConfig;

    use super::*;

    #[tokio::test]
    async fn event_streaming() {
        let event_subscriber = EventSubscriber::new(RpcClient::new_with_commitment(
            "https://api.devnet.solana.com".into(),
            CommitmentConfig::confirmed(),
        ));

        let mut event_stream = event_subscriber
            .subscribe(Pubkey::from_str("9JtczxrJjPM4J1xooxr2rFXmRivarb4BwjNiBgXDwe2p").unwrap());

        while let Some(event) = event_stream.next().await {
            dbg!(event);
        }
    }
}
