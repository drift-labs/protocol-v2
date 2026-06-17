use std::sync::Mutex;

use crate::solana_sdk::commitment_config::CommitmentConfig;
use solana_account_decoder_client_types::UiAccountEncoding;

use crate::{
    drift_idl::accounts::User,
    memcmp::{get_user_filter, get_user_with_auction_filter},
    types::SdkResult,
    websocket_program_account_subscriber::{
        ProgramAccountUpdate, WebsocketProgramAccountOptions, WebsocketProgramAccountSubscriber,
    },
    SdkError, UnsubHandle,
};

pub struct AuctionSubscriberConfig {
    pub commitment: CommitmentConfig,
    pub resub_timeout_ms: Option<u64>,
    pub url: String,
}

/// Subscribes to all user auction events across all markets
///
/// DEV: take care it is not dropped or the Auction stream will unsubscribe
pub struct AuctionSubscriber {
    subscriber: WebsocketProgramAccountSubscriber,
    unsub: Mutex<Option<UnsubHandle>>,
}

impl AuctionSubscriber {
    pub const SUBSCRIPTION_ID: &'static str = "auction";

    pub fn new(config: AuctionSubscriberConfig) -> Self {
        let filters = vec![get_user_filter(), get_user_with_auction_filter()];
        let websocket_options = WebsocketProgramAccountOptions {
            filters,
            commitment: config.commitment,
            encoding: UiAccountEncoding::Base64Zstd,
        };

        Self {
            subscriber: WebsocketProgramAccountSubscriber::new(config.url, websocket_options),
            unsub: Mutex::new(None),
        }
    }

    /// Start the auction subscription task
    ///
    /// * `handler_fn` - fn to invoke on each update
    ///
    /// this class sends the entire User account, the callback is required to
    /// interpret the diff e.g orders added/removed
    ///
    pub fn subscribe<F>(&self, handler_fn: F)
    where
        F: 'static + Send + Fn(&ProgramAccountUpdate<User>),
    {
        let mut guard = self.unsub.try_lock().expect("uncontested");
        let unsub = self.subscriber.subscribe(Self::SUBSCRIPTION_ID, handler_fn);
        guard.replace(unsub);
    }

    /// Unsubscribe stopping the auction subscription task
    pub fn unsubscribe(self) -> SdkResult<()> {
        let mut guard = self.unsub.lock().expect("acquired");
        if let Some(unsub) = guard.take() {
            if unsub.send(()).is_err() {
                log::error!("unsub failed");
                return Err(SdkError::CouldntUnsubscribe);
            }
        }

        Ok(())
    }
}

#[cfg(feature = "rpc_tests")]
mod tests {
    use super::*;
    use crate::utils::test_envs::mainnet_endpoint;

    #[tokio::test]
    async fn test_auction_subscriber() {
        env_logger::init();

        let config = AuctionSubscriberConfig {
            commitment: CommitmentConfig::confirmed(),
            resub_timeout_ms: None,
            url: mainnet_endpoint(),
        };

        let mut auction_subscriber = AuctionSubscriber::new(config);

        let emitter = auction_subscriber.event_emitter.clone();

        emitter.subscribe(move |event| {
            log::info!("{:?}", event.now.elapsed());
        });

        let _ = auction_subscriber.subscribe().await;

        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;

        let _ = auction_subscriber.unsubscribe().await;

        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    }
}
