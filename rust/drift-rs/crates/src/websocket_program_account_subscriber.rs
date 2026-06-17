use std::time::Instant;

use crate::solana_sdk::commitment_config::CommitmentConfig;
use anchor_lang::AnchorDeserialize;
use drift_pubsub_client::PubsubClient;
use futures_util::StreamExt;
use log::warn;
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_rpc_client_api::{
    config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    filter::RpcFilterType,
};
use tokio::sync::oneshot;

use crate::{constants, types::DataAndSlot, UnsubHandle};

#[derive(Clone, Debug)]
pub struct ProgramAccountUpdate<T: AnchorDeserialize + Send> {
    pub pubkey: String,
    pub data_and_slot: DataAndSlot<T>,
    pub now: Instant,
}

impl<T: AnchorDeserialize + Send> ProgramAccountUpdate<T> {
    pub fn new(pubkey: String, data_and_slot: DataAndSlot<T>, now: Instant) -> Self {
        Self {
            pubkey,
            data_and_slot,
            now,
        }
    }
}

#[derive(Clone)]
pub struct WebsocketProgramAccountOptions {
    pub filters: Vec<RpcFilterType>,
    pub commitment: CommitmentConfig,
    pub encoding: UiAccountEncoding,
}

pub struct WebsocketProgramAccountSubscriber {
    url: String,
    pub options: WebsocketProgramAccountOptions,
}

impl WebsocketProgramAccountSubscriber {
    pub fn new(url: String, options: WebsocketProgramAccountOptions) -> Self {
        WebsocketProgramAccountSubscriber { url, options }
    }

    /// Start a GPA subscription task
    ///
    /// `subscription_name` some user defined identifier for the subscription
    /// `on_update` handles updates from the subscription task
    pub fn subscribe<T, F>(&self, subscription_name: &'static str, on_update: F) -> UnsubHandle
    where
        T: AnchorDeserialize + Clone + Send + 'static,
        F: 'static + Send + Fn(&ProgramAccountUpdate<T>),
    {
        let account_config = RpcAccountInfoConfig {
            commitment: Some(self.options.commitment),
            encoding: Some(self.options.encoding),
            ..Default::default()
        };
        let config = RpcProgramAccountsConfig {
            filters: Some(self.options.filters.clone()),
            account_config,
            ..Default::default()
        };

        let (unsub_tx, mut unsub_rx) = oneshot::channel::<()>();
        let url = self.url.clone();

        tokio::spawn(async move {
            let mut latest_slot = 0;
            loop {
                let pubsub = match PubsubClient::new(&url).await {
                    Ok(pubsub) => pubsub,
                    Err(err) => {
                        log::error!("GPA stream connect failed: {err:?}");
                        continue;
                    }
                };
                let (mut accounts, unsub) = match pubsub
                    .program_subscribe(&constants::PROGRAM_ID, Some(config.clone()))
                    .await
                {
                    Ok(res) => res,
                    Err(err) => {
                        log::error!("GPA stream subscribe failed: {err:?}");
                        continue;
                    }
                };

                let res = loop {
                    tokio::select! {
                        biased;
                        message = accounts.next() => {
                            match message {
                                Some(message) => {
                                    let slot = message.context.slot;
                                    if slot >= latest_slot {
                                        latest_slot = slot;
                                        let pubkey = message.value.pubkey;
                                        let data = &message.value.account.data.decode().expect("account has data");
                                        let data = T::deserialize(&mut &data[8..]).expect("deserializes T");
                                        on_update(&ProgramAccountUpdate::new(pubkey, DataAndSlot::<T> { slot, data }, Instant::now()));
                                    }
                                },
                                None => {
                                    log::warn!("{subscription_name}: Ws GPA stream ended unexpectedly");
                                    break Err(());
                                }
                            }
                        }
                        _ = &mut unsub_rx => {
                            warn!("unsubscribing: {subscription_name}");
                            unsub().await;
                            break Ok(());
                        }
                    }
                };
                if res.is_ok() {
                    break;
                }
            }
        });

        unsub_tx
    }
}

#[cfg(feature = "rpc_tests")]
mod tests {
    use super::*;
    use crate::{
        drift_idl::accounts::User,
        memcmp::{get_non_idle_user_filter, get_user_filter},
        utils::test_envs::mainnet_endpoint,
    };

    #[tokio::test]
    async fn test_subscribe() {
        let filters = vec![get_user_filter(), get_non_idle_user_filter()];
        let commitment = CommitmentConfig::confirmed();
        let options = WebsocketProgramAccountOptions {
            filters,
            commitment,
            encoding: UiAccountEncoding::Base64,
        };
        let subscription_name = "Test";

        let mut ws_subscriber = WebsocketProgramAccountSubscriber::<User>::new(
            subscription_name,
            mainnet_endpoint(),
            options,
            EventEmitter::new(),
        );

        let _ = ws_subscriber.subscribe().await;
        dbg!("sub'd");

        ws_subscriber.event_emitter.clone().subscribe(move |event| {
            dbg!(event);
        });

        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
        let _ = ws_subscriber.unsubscribe().await;
        dbg!("unsub'd");
    }
}
