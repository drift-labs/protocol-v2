// Standard Library Imports
use std::sync::{Arc, Mutex};

// External Crate Imports
use drift_program::state::user::User;
use events_emitter::EventEmitter;
use solana_account_decoder::UiAccountEncoding;
use solana_sdk::commitment_config::CommitmentConfig;

// Internal Crate/Module Imports
use crate::{
    memcmp::{get_user_filter, get_user_with_auction_filter},
    types::{DataAndSlot, SdkResult},
    websocket_program_account_subscriber::{
        OnUpdate, SafeEventEmitter, WebsocketProgramAccountOptions,
        WebsocketProgramAccountSubscriber,
    },
};

pub struct AuctionSubscriberConfig {
    pub commitment: CommitmentConfig,
    pub resub_timeout_ms: Option<u64>,
    pub url: String,
}

pub struct AuctionSubscriber {
    pub subscriber: WebsocketProgramAccountSubscriber<User>,
    pub event_emitter: SafeEventEmitter<User>,
}

impl AuctionSubscriber {
    pub fn new(config: AuctionSubscriberConfig) -> Self {
        let safe_event_emitter: SafeEventEmitter<User> = Arc::new(Mutex::new(EventEmitter::new()));

        let on_update_fn: OnUpdate<User> =
            Arc::new(move |emitter, s: String, d: DataAndSlot<User>| {
                Self::on_update(emitter, s, d);
            });

        let filters = vec![get_user_filter(), get_user_with_auction_filter()];

        let websocket_options = WebsocketProgramAccountOptions {
            filters,
            commitment: config.commitment,
            encoding: UiAccountEncoding::Base64,
        };

        let subscriber = WebsocketProgramAccountSubscriber::new(
            "AuctionSubscriber".to_string(),
            config.url.clone(),
            websocket_options,
            Some(on_update_fn),
            Some(Arc::clone(&safe_event_emitter)),
            config.resub_timeout_ms,
        );

        AuctionSubscriber {
            subscriber,
            event_emitter: safe_event_emitter.clone(),
        }
    }

    fn on_update(emitter: Option<SafeEventEmitter<User>>, pubkey: String, data: DataAndSlot<User>) {
        if let Some(emitter) = emitter.clone() {
            let mut emitter = emitter.lock().unwrap();
            emitter.emit("Auction", &(pubkey, data));
        }
    }

    pub async fn subscribe(&mut self) -> SdkResult<()> {
        if self.subscriber.subscribed {
            return Ok(());
        }

        self.subscriber.subscribe().await?;

        Ok(())
    }

    pub async fn unsubscribe(&mut self) -> SdkResult<()> {
        self.subscriber.unsubscribe().await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use anchor_client::Cluster;

    use super::*;

    // this is my (frank) free helius endpoint
    const MAINNET_ENDPOINT: &str =
        "https://mainnet.helius-rpc.com/?api-key=3a1ca16d-e181-4755-9fe7-eac27579b48c";

    #[cfg(feature = "rpc_tests")]
    #[tokio::test]
    async fn test_auction_subscriber() {
        let cluster = Cluster::from_str(MAINNET_ENDPOINT).unwrap();
        let url = cluster.ws_url().to_string();

        let config = AuctionSubscriberConfig {
            commitment: CommitmentConfig::confirmed(),
            resub_timeout_ms: None,
            url,
        };

        let mut auction_subscriber = AuctionSubscriber::new(config);

        let mut emitter = auction_subscriber.event_emitter.lock().unwrap();

        emitter.on("Auction", |(p, d)| {
            dbg!(p);
            dbg!(d);
        });

        drop(emitter);

        let _ = auction_subscriber.subscribe().await;

        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;

        let _ = auction_subscriber.unsubscribe().await;

        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    }
}
