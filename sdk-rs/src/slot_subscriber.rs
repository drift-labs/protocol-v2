use crate::event_emitter::{Event, EventEmitter};
use crate::types::{SdkError, SdkResult};
use solana_client::nonblocking::pubsub_client::PubsubClient;

pub struct SlotSubscriber {
    current_slot: u64,
    event_emitter: EventEmitter,
    subscribed: bool,
    url: String,
    unsubscriber: Option<tokio::sync::mpsc::Sender<()>>,
}

#[derive(Clone, Debug)]
pub struct SlotUpdate {
    latest_slot: u64
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
            current_slot: 0,
            event_emitter,
            subscribed: false,
            url,
            unsubscriber: None,
        }
    }

    pub async fn subscribe(&mut self) -> SdkResult<()>{
        if self.subscribed {
            return Ok(())
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

        tokio::spawn(async move {

        });

        Ok(())
    }
}





