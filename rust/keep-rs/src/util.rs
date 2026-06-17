use std::{
    collections::HashSet,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use drift_rs::{
    constants::{
        perp_market_index_to_pyth_lazer_feed_id, pyth_lazer_feed_id_to_perp_market_index,
        pyth_lazer_feed_id_to_spot_market_index, spot_market_index_to_pyth_lazer_feed_id,
    },
    dlob::{L3Order, MakerCrosses},
    types::{MarketId, MarketType},
    Pubkey,
};
use futures_util::StreamExt;
use pyth_lazer_client::AnyResponse;
use pyth_lazer_protocol::{
    message::Message,
    payload::{PayloadData, PayloadPropertyValue},
    router::{
        Channel, DeliveryFormat, FixedRate, Format, JsonBinaryEncoding, PriceFeedId,
        PriceFeedProperty, SubscriptionParams, SubscriptionParamsRepr, TimestampUs,
    },
    subscription::{Response, SubscribeRequest, SubscriptionId},
};
use solana_sdk::signature::Signature;

pub struct OrderSlotLimiter<const N: usize> {
    slots: [Vec<u32>; N],
    generations: [u64; N],
}

impl<const N: usize> OrderSlotLimiter<N> {
    pub fn new() -> Self {
        let slots = std::array::from_fn(|_| Vec::new());
        let generations = [0; N];
        Self { slots, generations }
    }

    pub fn allow_event(&mut self, g: u64, id: u32) -> bool {
        let idx = (g % N as u64) as usize;

        // Replace old generation
        if self.generations[idx] != g {
            self.slots[idx].clear();
            self.generations[idx] = g;
        }

        // Count occurrences of id in generations g - 1 to g - 4
        let mut count = 0;
        for i in 2..=4 {
            let past_g = g.saturating_sub(i);
            let past_idx = (past_g % N as u64) as usize;

            if self.generations[past_idx] == past_g {
                if self.slots[past_idx].binary_search(&id).is_ok() {
                    count += 1;
                    if count >= 1 {
                        // Already appeared once, so this would be the second time
                        return false;
                    }
                }
            }
        }

        // Insert in sorted order
        let slot = &mut self.slots[idx];
        match slot.binary_search(&id) {
            Ok(_) => false, // Already present — shouldn't happen
            Err(pos) => {
                slot.insert(pos, id);
                true
            }
        }
    }

    pub fn check_event(&self, g: u64, id: u32) -> bool {
        // Check generations g - 1 and g - 4
        for i in 1..=4 {
            let past_g = g.saturating_sub(i);
            let past_idx = (past_g % N as u64) as usize;

            if self.generations[past_idx] == past_g {
                if self.slots[past_idx].binary_search(&id).is_ok() {
                    return false;
                }
            }
        }

        true
    }
}

#[derive(Clone, Default, Debug)]
pub enum TxIntent {
    #[default]
    None,
    AuctionFill {
        taker_order_id: u32,
        has_trigger: bool,
        maker_crosses: MakerCrosses,
    },
    SwiftFill {
        maker_crosses: MakerCrosses,
    },
    VAMMTakerFill {
        slot: u64,
        market_index: u16,
        maker_order_id: u32,
    },
    /// limit orders crossed
    LimitUncross {
        slot: u64,
        market_index: u16,
        taker_order_id: u32,
        maker_order_id: u32,
    },
    LiquidateWithFill {
        market_index: u16,
        liquidatee: Pubkey,
        slot: u64,
    },
    LiquidatePerp {
        market_index: u16,
        liquidatee: Pubkey,
        slot: u64,
    },
    LiquidatePerpPnlForDeposit {
        perp_market_index: u16,
        spot_market_index: u16,
        liquidatee: Pubkey,
        slot: u64,
    },
    LiquidateBorrowForPerpPnl {
        perp_market_index: u16,
        spot_market_index: u16,
        liquidatee: Pubkey,
        slot: u64,
    },
    LiquidateSpot {
        asset_market_index: u16,
        liability_market_index: u16,
        liquidatee: Pubkey,
        slot: u64,
    },
    Derisk {
        market_index: u16,
        subaccount: Pubkey,
    },
    SettlePnl {
        market_index: u16,
        subaccount: Pubkey,
    },
}

impl TxIntent {
    pub fn label(&self) -> &'static str {
        match self {
            TxIntent::None => "none",
            TxIntent::AuctionFill { maker_crosses, .. } => {
                if maker_crosses.has_vamm_cross {
                    "auction_fill_vamm"
                } else {
                    "auction_fill"
                }
            }
            TxIntent::SwiftFill { maker_crosses, .. } => {
                if maker_crosses.has_vamm_cross {
                    "swift_fill"
                } else {
                    "swift_fill_vamm"
                }
            }
            TxIntent::LimitUncross { .. } => "limit_uncross",
            TxIntent::VAMMTakerFill { .. } => "vamm_taker",
            TxIntent::LiquidateWithFill { .. } => "liq_with_fill",
            TxIntent::LiquidatePerp { .. } => "liq_perp",
            TxIntent::LiquidatePerpPnlForDeposit { .. } => "liq_perp_pnl_for_deposit",
            TxIntent::LiquidateBorrowForPerpPnl { .. } => "liq_borrow_for_perp_pnl",
            TxIntent::LiquidateSpot { .. } => "liq_spot",
            TxIntent::Derisk { .. } => "derisk",
            TxIntent::SettlePnl { .. } => "settle_pnl",
        }
    }

    pub fn expected_fill_count(&self) -> usize {
        match self {
            TxIntent::None => 0,
            TxIntent::AuctionFill { maker_crosses, .. } => {
                maker_crosses.orders.len() + if maker_crosses.has_vamm_cross { 1 } else { 0 }
            }
            TxIntent::SwiftFill { maker_crosses, .. } => {
                maker_crosses.orders.len() + if maker_crosses.has_vamm_cross { 1 } else { 0 }
            }
            TxIntent::VAMMTakerFill { .. } => 1,
            TxIntent::LimitUncross { .. } => 1,
            TxIntent::LiquidateWithFill { .. } => 1,
            TxIntent::LiquidatePerp { .. } => 0,
            TxIntent::LiquidatePerpPnlForDeposit { .. } => 0,
            TxIntent::LiquidateBorrowForPerpPnl { .. } => 0,
            TxIntent::LiquidateSpot { .. } => 0,
            TxIntent::Derisk { .. } => 0,
            TxIntent::SettlePnl { .. } => 0,
        }
    }

    /// true if tx was expected to trigger the taker order
    pub fn expected_trigger(&self) -> bool {
        match self {
            TxIntent::AuctionFill { has_trigger, .. } => *has_trigger,
            _ => false,
        }
    }

    pub fn crosses_and_slot(&self) -> (Vec<(L3Order, u64)>, u64) {
        match self {
            TxIntent::None => (vec![], 0),
            TxIntent::AuctionFill { maker_crosses, .. } => {
                (maker_crosses.orders.to_vec(), maker_crosses.slot)
            }
            TxIntent::SwiftFill { maker_crosses, .. } => {
                (maker_crosses.orders.to_vec(), maker_crosses.slot)
            }
            Self::VAMMTakerFill { slot, .. } => (vec![], *slot),
            Self::LimitUncross { slot, .. } => (vec![], *slot),
            Self::LiquidateWithFill { slot, .. } => (vec![], *slot),
            Self::LiquidatePerp { slot, .. } => (vec![], *slot),
            Self::LiquidatePerpPnlForDeposit { slot, .. } => (vec![], *slot),
            Self::LiquidateBorrowForPerpPnl { slot, .. } => (vec![], *slot),
            Self::LiquidateSpot { slot, .. } => (vec![], *slot),
            TxIntent::Derisk { .. } => (vec![], 0),
            TxIntent::SettlePnl { .. } => (vec![], 0),
        }
    }

    pub fn slot(&self) -> Option<u64> {
        match self {
            Self::VAMMTakerFill { slot, .. }
            | Self::LimitUncross { slot, .. }
            | Self::LiquidateWithFill { slot, .. }
            | Self::LiquidatePerp { slot, .. }
            | Self::LiquidatePerpPnlForDeposit { slot, .. }
            | Self::LiquidateBorrowForPerpPnl { slot, .. }
            | Self::LiquidateSpot { slot, .. } => Some(*slot),
            _ => None,
        }
    }

    /// Returns the liquidatee pubkey if this is a liquidation intent
    pub fn liquidatee(&self) -> Option<Pubkey> {
        match self {
            Self::LiquidateWithFill { liquidatee, .. }
            | Self::LiquidatePerp { liquidatee, .. }
            | Self::LiquidatePerpPnlForDeposit { liquidatee, .. }
            | Self::LiquidateBorrowForPerpPnl { liquidatee, .. }
            | Self::LiquidateSpot { liquidatee, .. } => Some(*liquidatee),
            _ => None,
        }
    }

    /// Returns true if this intent is a liquidation type
    pub fn is_liquidation(&self) -> bool {
        matches!(
            self,
            Self::LiquidateWithFill { .. }
                | Self::LiquidatePerp { .. }
                | Self::LiquidatePerpPnlForDeposit { .. }
                | Self::LiquidateBorrowForPerpPnl { .. }
                | Self::LiquidateSpot { .. }
        )
    }
}

#[derive(Clone, Default, Debug)]
pub struct PendingTxMeta {
    pub signature: Signature,
    pub intent: TxIntent,
    pub cu_limit: u64,
    pub ts: u64,
}

impl PendingTxMeta {
    pub fn new(sig: Signature, intent: TxIntent, cu_limit: u64) -> Self {
        Self {
            signature: sig,
            ts: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
            intent,
            cu_limit,
        }
    }
}

/// Circular buffer for pending transactions or similar FIFO workloads.
///
/// Usage example:
/// ```
/// let mut buf: PendingTxs<1024> = PendingTxs::new();
/// buf.insert(meta);
/// let confirmed = buf.confirm(|m| m.signature == sig);
/// ```
pub struct PendingTxs<const N: usize> {
    buffer: Box<[PendingTxMeta; N]>,
    head: usize,
    tail: usize,
    size: usize,
}

impl<const N: usize> PendingTxs<N> {
    pub fn new() -> Self {
        Self {
            buffer: Box::new([(); N].map(|_| PendingTxMeta::default())),
            head: 0,
            tail: 0,
            size: 0,
        }
    }

    /// Insert a new item, overwriting the oldest if full.
    pub fn insert(&mut self, item: PendingTxMeta) {
        self.buffer[self.tail] = item;
        self.tail = (self.tail + 1) % N;
        if self.size == N {
            self.head = (self.head + 1) % N;
        } else {
            self.size += 1;
        }
    }

    /// Confirm and return the first item with matching signature.
    ///
    /// Returns Some(item) if found, else None.
    pub fn confirm(&mut self, sig: &Signature) -> Option<PendingTxMeta> {
        for i in 0..self.size {
            let idx = (self.head + i) % N;
            // TODO: check if overwritten entry is confirmed or not
            if self.buffer[idx].signature == *sig {
                return Some(self.buffer[idx].clone());
            }
        }
        None
    }
}

#[derive(Clone, Debug)]
pub struct PythPriceUpdate {
    pub market_type: MarketType,
    pub market_id: u16,
    pub feed_id: u32,
    pub price: u64,
    // original pyth message
    pub message: Vec<u8>,
    pub ts: TimestampUs,
}

fn fixed_rate(feed_id: u32) -> FixedRate {
    match feed_id {
        1 | 2 | 6 => FixedRate::MIN,
        10 => FixedRate::from_ms(50).unwrap(),
        _ => FixedRate::from_ms(200).unwrap(),
    }
}

// scale pyth lazer price into drift price precision
#[inline(always)]
fn to_price_precision(price: u64, feed_id: u32, market_type: MarketType) -> u64 {
    match feed_id {
        // https://docs.pyth.network/lazer/price-feed-ids
        // LAZER_1M
        9 => match market_type {
            MarketType::Perp => price * 100,    // -10 => -6 * 1M
            MarketType::Spot => price / 10_000, // -10 => -6
        },
        4 => price * 100, // -10 => -6 * 1M
        // LAZER_1K
        1578 | 2396 | 137 => match market_type {
            MarketType::Perp => price * 10,  // -10 => -6 * 1K
            MarketType::Spot => price / 100, // -8 => -6
        },
        _ => price / 100, // -8 => -6
    }
}

pub fn subscribe_price_feeds(
    mut cli: pyth_lazer_client::LazerClient,
    perp_market_ids: &[MarketId],
    spot_market_ids: &[MarketId],
    extra_feed_ids: &[u32],
) -> tokio::sync::mpsc::Receiver<PythPriceUpdate> {
    let mut feed_id_set = HashSet::new();

    for m in perp_market_ids {
        if let Some(fid) = perp_market_index_to_pyth_lazer_feed_id(m.index()) {
            feed_id_set.insert(fid);
        }
    }

    for m in spot_market_ids {
        if let Some(fid) = spot_market_index_to_pyth_lazer_feed_id(m.index()) {
            feed_id_set.insert(fid);
        }
    }

    let extra_feeds: HashSet<u32> = extra_feed_ids.iter().copied().collect();
    feed_id_set.extend(extra_feeds.iter().copied());

    let feed_ids: Vec<PriceFeedId> = feed_id_set.into_iter().map(PriceFeedId).collect();

    const MAX_RETRIES: u32 = 10;

    let (price_tx, price_rx) = tokio::sync::mpsc::channel(512);

    let mut retries = 0u32;
    tokio::spawn(async move {
        loop {
            let pyth_lazer_stream = match cli.start().await {
                Ok(stream) => stream,
                Err(err) => {
                    retries += 1;

                    if retries >= MAX_RETRIES {
                        log::error!(
                            target: "pyth",
                            "FATAL: feed connection failed after {MAX_RETRIES} attempts; closing price feed channel"
                        );
                        return;
                    } else {
                        let backoff = 2u64.pow(retries).min(30); // 2^retries seconds, capped at 30s
                        log::warn!(
                            target: "pyth",
                            "feed connection failed: {err:?}, retry {retries}/{MAX_RETRIES} in {backoff}s"
                        );
                        tokio::time::sleep(Duration::from_secs(backoff)).await;
                        continue;
                    }
                }
            };

            // sub per feed
            let mut sub_id = 0;
            for feed_id in feed_ids.iter() {
                let subscribe_request = SubscribeRequest {
                    subscription_id: SubscriptionId(sub_id),
                    params: SubscriptionParams::new(SubscriptionParamsRepr {
                        price_feed_ids: vec![*feed_id],
                        // drift program requires exponent + feed_update_timestamp to apply the update
                        properties: vec![
                            PriceFeedProperty::Price,
                            PriceFeedProperty::Exponent,
                            PriceFeedProperty::FeedUpdateTimestamp,
                        ],
                        delivery_format: DeliveryFormat::Binary,
                        json_binary_encoding: JsonBinaryEncoding::Hex,
                        parsed: false,
                        channel: Channel::FixedRate(fixed_rate(feed_id.0)),
                        formats: vec![Format::Solana],
                        ignore_invalid_feed_ids: false,
                    })
                    .expect("invalid subscription params"),
                };
                sub_id += 1;
                if let Err(err) = cli
                    .subscribe(pyth_lazer_protocol::subscription::Request::Subscribe(
                        subscribe_request,
                    ))
                    .await
                {
                    log::error!(target: "pyth", "pyth feed subscribe failed: {err:?}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            }

            retries = 0u32; // retry on successful connect

            let mut stream = pyth_lazer_stream.boxed();
            while let Some(update) = stream.next().await {
                match update {
                    Ok(AnyResponse::Binary(outer)) => {
                        for message in outer.messages {
                            match message {
                                Message::Solana(solana) => {
                                    let mut buf = Vec::with_capacity(solana.payload.len() + 128);
                                    solana.serialize(&mut buf).expect("serialized");
                                    let data =
                                        PayloadData::deserialize_slice_le(&solana.payload).unwrap();

                                    log::trace!(target: "pyth", "got update: {data:?}");
                                    for f in data.feeds {
                                        for p in f.properties {
                                            if let PayloadPropertyValue::Price(Some(new_price)) = p
                                            {
                                                // TODO: bulk msg to avoid bouncing around tokio, bucket in some way, one message updates multiple markets...
                                                let feed_id = f.feed_id.0;
                                                let price: u64 = new_price.0.unsigned_abs().into();

                                                if let Some(market_id) =
                                                    pyth_lazer_feed_id_to_perp_market_index(feed_id)
                                                {
                                                    let scaled_price = to_price_precision(
                                                        price,
                                                        feed_id,
                                                        MarketType::Perp,
                                                    );
                                                    let _ = price_tx.try_send(PythPriceUpdate {
                                                        market_type: MarketType::Perp,
                                                        market_id,
                                                        feed_id,
                                                        price: scaled_price,
                                                        message: buf.clone(),
                                                        ts: data.timestamp_us,
                                                    });
                                                }

                                                if let Some(market_id) =
                                                    pyth_lazer_feed_id_to_spot_market_index(feed_id)
                                                {
                                                    let scaled_price = to_price_precision(
                                                        price,
                                                        feed_id,
                                                        MarketType::Spot,
                                                    );
                                                    let _ = price_tx.try_send(PythPriceUpdate {
                                                        market_type: MarketType::Spot,
                                                        market_id,
                                                        feed_id,
                                                        price: scaled_price,
                                                        message: buf.clone(),
                                                        ts: data.timestamp_us,
                                                    });
                                                }

                                                // Extra feeds (cluster-specific): emit a synthetic
                                                // update so the relayer ships them. drift-rs
                                                // derives the oracle PDA from feed_id alone, so
                                                // market_id is informational only.
                                                if extra_feeds.contains(&feed_id)
                                                    && pyth_lazer_feed_id_to_perp_market_index(
                                                        feed_id,
                                                    )
                                                    .is_none()
                                                    && pyth_lazer_feed_id_to_spot_market_index(
                                                        feed_id,
                                                    )
                                                    .is_none()
                                                {
                                                    let scaled_price = to_price_precision(
                                                        price,
                                                        feed_id,
                                                        MarketType::Spot,
                                                    );
                                                    let _ = price_tx.try_send(PythPriceUpdate {
                                                        market_type: MarketType::Spot,
                                                        market_id: u16::MAX,
                                                        feed_id,
                                                        price: scaled_price,
                                                        message: buf.clone(),
                                                        ts: data.timestamp_us,
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                                _ => (),
                            }
                        }
                    }
                    other => match other {
                        Ok(AnyResponse::Json(Response::Subscribed(sub))) => {
                            log::info!(
                                target: "pyth",
                                "subscribed feed {}",
                                sub.subscription_id.0
                            );
                        }
                        Ok(AnyResponse::Json(msg)) => {
                            log::info!(target: "pyth", "control msg: {msg:?}");
                        }
                        Err(err) => {
                            log::warn!(
                                target: "pyth",
                                "websocket error from pyth stream: {err:?}"
                            );
                        }
                        Ok(other_ok) => {
                            log::info!(target: "pyth", "non-binary msg: {other_ok:?}");
                        }
                    },
                }
            }
            // stream ended, will retry
            retries += 1;
            if retries >= MAX_RETRIES {
                log::error!(
                    target: "pyth",
                    "FATAL: feed disconnected after {MAX_RETRIES} attempts; closing price feed channel"
                );
                return;
            }
            let backoff = 2u64.pow(retries).min(30);
            log::warn!(
                target: "pyth",
                "feed disconnected, retry {retries}/{MAX_RETRIES} in {backoff}s"
            );
            tokio::time::sleep(Duration::from_secs(backoff)).await;
        }
    });

    price_rx
}
