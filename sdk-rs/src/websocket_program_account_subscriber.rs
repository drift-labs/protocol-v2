use std::{any::Any, sync::{Arc, Mutex}};

use anchor_lang::AccountDeserialize;
use crate::event_emitter::{Event, EventEmitter};
// use events_emitter::EventEmitter;
use futures_util::StreamExt;
use log::{debug, error, warn};
use solana_account_decoder::{UiAccountData, UiAccountEncoding};
use solana_client::{
    nonblocking::pubsub_client::PubsubClient,
    rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    rpc_filter::RpcFilterType,
};
use solana_sdk::{commitment_config::CommitmentConfig};
use crate::types::{DataAndSlot, SdkError, SdkResult};

#[derive(Clone, Debug)]
pub struct ProgramAccountUpdate<T: Clone + Send + 'static> {
    pub pubkey: String,
    pub data_and_slot: DataAndSlot<T>,
}

impl<T: Clone + Send + 'static> ProgramAccountUpdate<T> {
    pub fn new(pubkey: String, data_and_slot: DataAndSlot<T>) -> Self {
        Self {
            pubkey,
            data_and_slot
        }
    }
}


impl<T: Clone + Send + 'static> Event for ProgramAccountUpdate<T> {
    fn box_clone(&self) -> Box<dyn Event> {
        Box::new((*self).clone())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

pub type OnUpdate<T> =
    Arc<dyn Fn(EventEmitter, ProgramAccountUpdate<T>) + Send + Sync>;


pub struct WebsocketProgramAccountOptions {
    pub filters: Vec<RpcFilterType>,
    pub commitment: CommitmentConfig,
    pub encoding: UiAccountEncoding,
}

pub struct WebsocketProgramAccountSubscriber<T>
where
    T: AccountDeserialize + core::fmt::Debug + Send + Clone + 'static ,
{
    subscription_name: String,
    url: String,
    options: WebsocketProgramAccountOptions,
    on_update: Option<OnUpdate<T>>,
    _resub_timeout_ms: Option<u64>,
    pub subscribed: bool,
    event_emitter: EventEmitter,
    unsubscriber: Option<tokio::sync::mpsc::Sender<()>>,
}

impl<T> WebsocketProgramAccountSubscriber<T>
where
    T: AccountDeserialize + core::fmt::Debug + Send + Clone + 'static ,
{
    pub fn new(
        subscription_name: String,
        url: String,
        options: WebsocketProgramAccountOptions,
        on_update: Option<OnUpdate<T>>,
        event_emitter: EventEmitter,
        resub_timeout_ms: Option<u64>,
    ) -> Self {
        WebsocketProgramAccountSubscriber {
            subscription_name,
            url,
            options,
            on_update,
            _resub_timeout_ms: resub_timeout_ms,
            subscribed: false,
            event_emitter,
            unsubscriber: None,
        }
    }

    #[inline(always)]
    fn decode(data: UiAccountData) -> SdkResult<T> {
        let data_str = match data {
            UiAccountData::Binary(encoded, _) => encoded,
            _ => return Err(SdkError::UnsupportedAccountData),
        };

        let decoded_data = base64::decode(data_str)?;
        let mut decoded_data_slice = decoded_data.as_slice();

        T::try_deserialize(&mut decoded_data_slice).map_err(|err| SdkError::Anchor(Box::new(err)))
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
        let account_config = RpcAccountInfoConfig {
            commitment: Some(self.options.commitment),
            encoding: Some(self.options.encoding),
            ..RpcAccountInfoConfig::default()
        };
        let config = RpcProgramAccountsConfig {
            filters: Some(self.options.filters.clone()),
            account_config,
            ..RpcProgramAccountsConfig::default()
        };

        let url = self.url.clone();
        let mut latest_slot = 0;
        let on_update = self.on_update.clone();

        let pubsub = PubsubClient::new(&url).await?;

        let event_emitter = self.event_emitter.clone();

        let (unsub_tx, mut unsub_rx) = tokio::sync::mpsc::channel::<()>(1);

        self.unsubscriber = Some(unsub_tx);
        let subscription_name = self.subscription_name.clone();

        tokio::spawn(async move {
            let on_update_ref = on_update.as_ref();
            let (mut accounts, unsubscriber) = pubsub
                .program_subscribe(&drift_program::ID, Some(config))
                .await
                .unwrap();
            loop {
                tokio::select! {
                    message = accounts.next() => {
                        match message {
                            Some(message) => {
                                let slot = message.context.slot;
                                if slot >= latest_slot {
                                    latest_slot = slot;
                                    let pubkey = message.value.pubkey;
                                    let account_data = message.value.account.data;
                                    match Self::decode(account_data) {
                                        Ok(data) => {
                                            let data_and_slot = DataAndSlot { slot, data };
                                            if let Some(on_update_callback) = on_update_ref {
                                                on_update_callback(event_emitter.clone(), ProgramAccountUpdate::new(pubkey, data_and_slot));
                                            }
                                        },
                                        Err(e) => {
                                            error!("Error decoding account data {e}");
                                        }
                                    }
                                }
                            }
                            None => {
                                warn!("{} stream ended", subscription_name);
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
    use drift_program::state::user::User;

    use super::*;
    use crate::memcmp::{get_non_idle_user_filter, get_user_filter};

    // this is my (frank) free helius endpoint
    const MAINNET_ENDPOINT: &str =
        "https://mainnet.helius-rpc.com/?api-key=3a1ca16d-e181-4755-9fe7-eac27579b48c";

    #[cfg(feature = "rpc_tests")]
    #[tokio::test]
    async fn test_subscribe() {
        let filters = vec![get_user_filter(), get_non_idle_user_filter()];
        let commitment = CommitmentConfig::confirmed();
        let options = WebsocketProgramAccountOptions {
            filters,
            commitment,
            encoding: UiAccountEncoding::Base64,
        };
        let cluster = Cluster::from_str(MAINNET_ENDPOINT).unwrap();
        let url = cluster.ws_url().to_string();
        let resub_timeout_ms = 10_000;
        let subscription_name = "Test".to_string();

        fn on_update(
            emitter: EventEmitter,
            update: ProgramAccountUpdate<User>
        ) {
            emitter.emit("ProgramAccountUpdate", Box::new(update));
        }

        let on_update_fn: OnUpdate<User> = Arc::new(move |emitter, update| {
            on_update(emitter, update);
        });

        let mut ws_subscriber = WebsocketProgramAccountSubscriber::new(
            subscription_name,
            url,
            options,
            Some(on_update_fn),
            EventEmitter::new(),
            Some(resub_timeout_ms),
        );

        let _ = ws_subscriber.subscribe().await;
        dbg!("sub'd");

        ws_subscriber.event_emitter.clone().subscribe("ProgramAccountUpdate", move |event| {
            if let Some(event) = event.as_any().downcast_ref::<ProgramAccountUpdate<User>>() {
                dbg!(event);
            }
        });

        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
        let _ = ws_subscriber.unsubscribe().await;
        dbg!("unsub'd");
    }
}
