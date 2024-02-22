use std::any::Any;

use anchor_lang::AccountDeserialize;
use futures_util::StreamExt;
use log::{debug, error, warn};
use solana_account_decoder::UiAccountEncoding;
use solana_client::{
    nonblocking::pubsub_client::PubsubClient,
    rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    rpc_filter::RpcFilterType,
};
use solana_sdk::commitment_config::CommitmentConfig;

use crate::{
    event_emitter::{Event, EventEmitter},
    types::{DataAndSlot, SdkError, SdkResult},
    utils::decode,
};

#[derive(Clone, Debug)]
pub struct ProgramAccountUpdate<T: Clone + Send + AccountDeserialize + 'static> {
    pub pubkey: String,
    pub data_and_slot: DataAndSlot<T>,
}

impl<T: Clone + Send + AccountDeserialize + 'static> ProgramAccountUpdate<T> {
    pub fn new(pubkey: String, data_and_slot: DataAndSlot<T>) -> Self {
        Self {
            pubkey,
            data_and_slot,
        }
    }
}

impl<T: Clone + Send + AccountDeserialize + 'static> Event for ProgramAccountUpdate<T> {
    fn box_clone(&self) -> Box<dyn Event> {
        Box::new((*self).clone())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

pub struct WebsocketProgramAccountOptions {
    pub filters: Vec<RpcFilterType>,
    pub commitment: CommitmentConfig,
    pub encoding: UiAccountEncoding,
}

pub struct WebsocketProgramAccountSubscriber {
    subscription_name: String,
    url: String,
    options: WebsocketProgramAccountOptions,
    pub subscribed: bool,
    pub event_emitter: EventEmitter,
    unsubscriber: Option<tokio::sync::mpsc::Sender<()>>,
}

impl WebsocketProgramAccountSubscriber {
    pub fn new(
        subscription_name: String,
        url: String,
        options: WebsocketProgramAccountOptions,
        event_emitter: EventEmitter,
    ) -> Self {
        WebsocketProgramAccountSubscriber {
            subscription_name,
            url,
            options,
            subscribed: false,
            event_emitter,
            unsubscriber: None,
        }
    }

    pub async fn subscribe<T>(&mut self) -> SdkResult<()>
    where
        T: AccountDeserialize + Clone + Send + 'static,
    {
        if self.subscribed {
            return Ok(());
        }
        self.subscribed = true;
        self.subscribe_ws::<T>().await?;

        Ok(())
    }

    async fn subscribe_ws<T>(&mut self) -> SdkResult<()>
    where
        T: AccountDeserialize + Clone + Send + 'static,
    {
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

        let pubsub = PubsubClient::new(&url).await?;

        let event_emitter = self.event_emitter.clone();

        let (unsub_tx, mut unsub_rx) = tokio::sync::mpsc::channel::<()>(1);

        self.unsubscriber = Some(unsub_tx);
        let subscription_name: &'static str =
            Box::leak(self.subscription_name.clone().into_boxed_str());

        tokio::spawn(async move {
            let (mut accounts, unsubscriber) = pubsub
                .program_subscribe(&drift::ID, Some(config))
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
                                    match decode(account_data) {
                                        Ok(data) => {
                                            let data_and_slot = DataAndSlot::<T> { slot, data };
                                            event_emitter.emit(subscription_name, Box::new(ProgramAccountUpdate::new(pubkey, data_and_slot)));
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
    use drift::state::user::User;

    use super::*;
    use crate::{
        memcmp::{get_non_idle_user_filter, get_user_filter},
        utils::envs::mainnet_endpoint,
    };

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
        let cluster = Cluster::from_str(&mainnet_endpoint()).unwrap();
        let url = cluster.ws_url().to_string();
        let subscription_name = "Test".to_string();

        let mut ws_subscriber = WebsocketProgramAccountSubscriber::new(
            subscription_name,
            url,
            options,
            EventEmitter::new(),
        );

        let _ = ws_subscriber.subscribe::<User>().await;
        dbg!("sub'd");

        ws_subscriber
            .event_emitter
            .clone()
            .subscribe("Test", move |event| {
                if let Some(event) = event.as_any().downcast_ref::<ProgramAccountUpdate<User>>() {
                    dbg!(event);
                }
            });

        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
        let _ = ws_subscriber.unsubscribe().await;
        dbg!("unsub'd");
    }
}
