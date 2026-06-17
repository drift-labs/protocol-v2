use std::sync::{atomic::AtomicU64, Arc, Mutex};

use crate::solana_sdk::clock::Slot;
use drift_pubsub_client::PubsubClient;
use futures_util::StreamExt;
use log::{debug, error, warn};
use tokio::sync::oneshot;

use crate::types::{SdkError, SdkResult};

const LOG_TARGET: &str = "slotsub";

/// Subscribes to network slot number increases
///
/// ```example
/// let slot_subscriber = SlotSubscriber::new("http://rpc.example.com");
/// slot_subscriber.subscribe(move |slot| {
///     dbg!("new slot", slot);
/// }).expect("subd");
///
/// // get latest slot
/// let latest_slot = slot_subscriber.current_slot();
/// ```
///
pub struct SlotSubscriber {
    pubsub: Arc<PubsubClient>,
    current_slot: Arc<AtomicU64>,
    unsub: Mutex<Option<oneshot::Sender<()>>>,
}

#[derive(Clone, Debug)]
pub struct SlotUpdate {
    pub latest_slot: u64,
}

impl SlotUpdate {
    pub fn new(latest_slot: u64) -> Self {
        Self { latest_slot }
    }
}

impl SlotSubscriber {
    pub const SUBSCRIPTION_ID: &'static str = "slot";

    pub fn is_subscribed(&self) -> bool {
        let guard = self.unsub.lock().expect("acquired");
        guard.is_some()
    }

    /// Create a new `SlotSubscriber`
    ///
    /// * `pubsub` - a `PubsubClient` instance for the subscription to utilize (maybe shared)
    ///
    /// Consumer must call `.subscribe()` to start receiving updates
    pub fn new(pubsub: Arc<PubsubClient>) -> Self {
        Self {
            pubsub,
            current_slot: Arc::default(),
            unsub: Mutex::new(None),
        }
    }

    /// Returns the latest slot
    pub fn current_slot(&self) -> Slot {
        self.current_slot.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Start the slot subscription task
    ///
    /// * `on_slot` - callback invoked on new slot updates
    ///
    pub fn subscribe<F>(&mut self, on_slot: F) -> SdkResult<()>
    where
        F: 'static + Send + Fn(SlotUpdate),
    {
        if self.is_subscribed() {
            debug!(target: LOG_TARGET, "already subscribed");
            return Ok(());
        }
        self.subscribe_ws(on_slot)
    }

    fn subscribe_ws<F>(&mut self, on_slot: F) -> SdkResult<()>
    where
        F: 'static + Send + Fn(SlotUpdate),
    {
        let (unsub_tx, mut unsub_rx) = oneshot::channel::<()>();
        {
            let mut guard = self.unsub.try_lock().expect("uncontested");
            *guard = Some(unsub_tx);
        }

        let current_slot = Arc::clone(&self.current_slot);
        let pubsub = Arc::clone(&self.pubsub);

        tokio::spawn(async move {
            debug!(target: LOG_TARGET, "start slot subscriber");
            loop {
                let (mut slot_updates, unsubscriber) = match pubsub.slot_subscribe().await {
                    Ok(s) => s,
                    Err(err) => {
                        error!(target: LOG_TARGET, "slot subscribe failed: {err:?}");
                        continue;
                    }
                };

                let res = loop {
                    tokio::select! {
                        biased;
                        new_slot = slot_updates.next() => {
                            match new_slot {
                                Some(update) => {
                                    current_slot.store(update.slot, std::sync::atomic::Ordering::Relaxed);
                                    on_slot(SlotUpdate::new(update.slot));
                                }
                                None => {
                                    warn!(target: LOG_TARGET, "slot subscriber finished");
                                    break Err(());
                                }
                            }
                        }
                        _ = &mut unsub_rx => {
                            debug!(target: LOG_TARGET, "unsubscribed");
                            unsubscriber().await;
                            break Ok(());
                        }
                    }
                };

                if res.is_ok() {
                    break;
                }
            }
        });

        Ok(())
    }

    pub async fn unsubscribe(&self) -> SdkResult<()> {
        let mut guard = self.unsub.lock().expect("acquired");
        if let Some(unsub) = guard.take() {
            if unsub.send(()).is_err() {
                error!(target: LOG_TARGET, "Failed to send unsubscribe signal");
                return Err(SdkError::CouldntUnsubscribe);
            }
        }

        Ok(())
    }
}

#[cfg(feature = "rpc_tests")]
mod tests {
    use std::str::FromStr;

    use super::*;
    use crate::utils::test_envs::mainnet_endpoint;

    #[tokio::test]
    async fn test_subscribe() {
        let cluster = Cluster::from_str(&mainnet_endpoint()).unwrap();
        let url = cluster.ws_url().to_string();

        let mut slot_subscriber = SlotSubscriber::new(url);
        let _ = slot_subscriber.subscribe().await;

        slot_subscriber.event_emitter.clone().subscribe(
            SlotSubscriber::SUBSCRIPTION_ID,
            move |event| {
                if let Some(event) = event.as_any().downcast_ref::<SlotUpdate>() {
                    dbg!(event);
                }
            },
        );
        dbg!("sub'd");

        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
        let _ = slot_subscriber.unsubscribe().await;
        dbg!("unsub'd");
    }
}
