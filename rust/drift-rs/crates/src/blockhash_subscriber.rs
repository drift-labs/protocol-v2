use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use crate::solana_sdk::message::Hash;
use log::warn;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use tokio::sync::oneshot;

use crate::UnsubHandle;

/// Subscribes to latest network blockhashes
pub struct BlockhashSubscriber {
    refresh_frequency: Duration,
    last_twenty_hashes: Arc<RwLock<VecDeque<Hash>>>,
    rpc_client: Arc<RpcClient>,
    unsub: Mutex<Option<UnsubHandle>>,
}

impl BlockhashSubscriber {
    /// Create a new blockhash subscriber
    /// It must be started by calling `subscribe()`
    pub fn new(refresh_frequency: Duration, rpc_client: Arc<RpcClient>) -> Self {
        BlockhashSubscriber {
            last_twenty_hashes: Arc::new(RwLock::new(VecDeque::with_capacity(20))),
            rpc_client: Arc::clone(&rpc_client),
            refresh_frequency,
            unsub: Mutex::default(),
        }
    }

    /// Start the blockhash subscriber task
    pub fn subscribe(&self) {
        let (unsub_tx, mut unsub_rx) = oneshot::channel();
        {
            let mut guard = self.unsub.try_lock().expect("uncontested");
            if guard.is_some() {
                return;
            }
            guard.replace(unsub_tx);
        }

        tokio::spawn({
            let rpc_client = Arc::clone(&self.rpc_client);
            let last_twenty_hashes = Arc::clone(&self.last_twenty_hashes);
            let mut refresh = tokio::time::interval(self.refresh_frequency);

            let max_attempts = 3;
            let mut attempts = 0;
            async move {
                loop {
                    let _ = refresh.tick().await;
                    match rpc_client.get_latest_blockhash().await {
                        Ok(blockhash) => {
                            attempts = 0;
                            let mut hashes = last_twenty_hashes.write().expect("acquired");
                            hashes.push_back(blockhash);
                            if hashes.len() > 20 {
                                let _ = hashes.pop_front();
                            }
                        }
                        Err(err) => {
                            warn!("blockhash subscriber missed update: {err:?}");
                            attempts += 1;
                            if attempts > max_attempts {
                                panic!("unable to fetch blockhash");
                            }
                        }
                    }

                    if unsub_rx.try_recv().is_ok() {
                        warn!("unsubscribing from blockhashes");
                        break;
                    }
                }

                let mut lock = last_twenty_hashes.write().expect("acquired");
                lock.clear();
            }
        });
    }

    /// Return most recent polled blockhash
    pub fn get_latest_blockhash(&self) -> Option<Hash> {
        let lock = self.last_twenty_hashes.read().expect("acquired");
        lock.back().copied()
    }

    /// Return oldest valid blockhash (more likely finalized)
    pub fn get_valid_blockhash(&self) -> Option<Hash> {
        let lock = self.last_twenty_hashes.read().expect("acquired");
        lock.front().copied()
    }

    /// Stop the blockhash subscriber task, if it exists    ``
    pub fn unsubscribe(&self) {
        let mut guard = self.unsub.lock().expect("uncontested");
        if let Some(unsub) = guard.take() {
            if unsub.send(()).is_err() {
                log::error!("couldn't unsubscribe");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use solana_rpc_client::rpc_client::Mocks;
    use solana_rpc_client_api::request::RpcRequest;

    use super::*;

    #[tokio::test]
    async fn blockhash_subscriber_updates() {
        let _ = env_logger::try_init();
        let mut response_mocks = Mocks::default();
        let latest_block_hash = Hash::new_unique();
        let oldest_block_hash = Hash::new_unique();

        response_mocks.insert(
            RpcRequest::GetLatestBlockhash,
            json!({
                "context": {
                    "slot": 12345,
                },
                "value": {
                    "blockhash": latest_block_hash.to_string(),
                    "lastValidBlockHeight": 1,
                }
            }),
        );

        let mock_rpc = RpcClient::new_mock_with_mocks(
            "https://api.mainnet-beta.solana.com".into(),
            response_mocks,
        );

        let blockhash_subscriber = BlockhashSubscriber {
            last_twenty_hashes: Arc::new(RwLock::new(VecDeque::from_iter(
                [oldest_block_hash]
                    .into_iter()
                    .chain(std::iter::repeat(Hash::new_unique()).take(20)),
            ))),
            unsub: Mutex::default(),
            rpc_client: Arc::new(mock_rpc),
            refresh_frequency: Duration::from_secs(4),
        };

        // valid hash is oldest (most finalized)
        assert_eq!(
            blockhash_subscriber.get_valid_blockhash().unwrap(),
            oldest_block_hash
        );
        assert!(blockhash_subscriber.get_latest_blockhash().unwrap() != latest_block_hash);

        // after subscribe blockhashes, next update is observable
        blockhash_subscriber.subscribe();
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(
            blockhash_subscriber.get_latest_blockhash().unwrap(),
            latest_block_hash
        );

        // oldest hash updated as buffer updates
        assert!(blockhash_subscriber.get_valid_blockhash().unwrap() != oldest_block_hash);

        // after unsub, returns none
        blockhash_subscriber.unsubscribe();
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert!(blockhash_subscriber.get_latest_blockhash().is_none());
    }
}
