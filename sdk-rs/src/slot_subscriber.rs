use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use log::{debug, error, warn};
use solana_client::nonblocking::pubsub_client::PubsubClient;

use crate::{
    event_emitter::{Event, EventEmitter},
    types::{SdkError, SdkResult},
};

/// To subscribe to slot updates, subscribe to the event_emitter's "slot" event type.
pub struct SlotSubscriber {
    current_slot: Arc<Mutex<u64>>,
    event_emitter: EventEmitter,
    subscribed: bool,
    url: String,
    unsubscriber: Option<tokio::sync::mpsc::Sender<()>>,
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

impl Event for SlotUpdate {
    fn box_clone(&self) -> Box<dyn Event> {
        Box::new((*self).clone())
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl SlotSubscriber {
    pub fn new(url: String) -> Self {
        let event_emitter = EventEmitter::new();
        Self {
            current_slot: Arc::new(Mutex::new(0)),
            event_emitter,
            subscribed: false,
            url,
            unsubscriber: None,
        }
    }

    pub fn current_slot(&self) -> u64 {
        let slot_guard = self.current_slot.lock().unwrap();
        *slot_guard
    }

    pub async fn subscribe(&mut self) -> SdkResult<()> {
        if self.subscribed {
            return Ok(());
        }
        self.subscribed = true;
        self.subscribe_ws().await?;
        Ok(())
    }

    async fn subscribe_ws(&mut self) -> SdkResult<()> {
        let pubsub = PubsubClient::new(&self.url.clone()).await?;

        let event_emitter = self.event_emitter.clone();

        let (unsub_tx, mut unsub_rx) = tokio::sync::mpsc::channel::<()>(1);

        self.unsubscriber = Some(unsub_tx);

        let current_slot = self.current_slot.clone();

        tokio::spawn(async move {
            let (mut slot_updates, unsubscriber) = pubsub.slot_subscribe().await.unwrap();
            loop {
                tokio::select! {
                    message = slot_updates.next() => {
                        match message {
                            Some(message) => {
                                let slot = message.slot;
                                let mut current_slot_guard = current_slot.lock().unwrap();
                                if slot >= *current_slot_guard {
                                    *current_slot_guard = slot;
                                    event_emitter.emit("slot", Box::new(SlotUpdate::new(slot)));
                                }
                            }
                            None => {
                                warn!("Slot stream ended");
                                unsubscriber().await;
                                break;
                            }
                        }
                    }
                    _ = unsub_rx.recv() => {
                        debug!("Unsubscribing.");
                        unsubscriber().await;
                        break;
                    }
                }
            }
        });

        Ok(())
    }

    pub async fn unsubscribe(&mut self) -> SdkResult<()> {
        if self.subscribed && self.unsubscriber.is_some() {
            if let Err(e) = self.unsubscriber.as_ref().unwrap().send(()).await {
                error!("Failed to send unsubscribe signal: {:?}", e);
                return Err(SdkError::CouldntUnsubscribe(e));
            }
            self.subscribed = false;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use anchor_client::Cluster;

    use super::*;
    use crate::utils::envs::mainnet_endpoint;

    #[cfg(feature = "rpc_tests")]
    #[tokio::test]
    async fn test_subscribe() {
        let cluster = Cluster::from_str(&mainnet_endpoint()).unwrap();
        let url = cluster.ws_url().to_string();

        let mut slot_subscriber = SlotSubscriber::new(url);
        let _ = slot_subscriber.subscribe().await;

        slot_subscriber
            .event_emitter
            .clone()
            .subscribe("slot", move |event| {
                if let Some(event) = event.as_any().downcast_ref::<SlotUpdate>() {
                    dbg!(event);
                }
            });
        dbg!("sub'd");

        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
        let _ = slot_subscriber.unsubscribe().await;
        dbg!("unsub'd");
    }
}
