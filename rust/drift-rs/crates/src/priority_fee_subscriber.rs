use std::{
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use crate::solana_sdk::{clock::Slot, pubkey::Pubkey};
use log::warn;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use tokio::sync::oneshot;

pub const DEFAULT_REFRESH_FREQUENCY: Duration = Duration::from_millis(5 * 400);
pub const DEFAULT_SLOT_WINDOW: Slot = 30;

/// Subscribes to network priority fees given some accounts.
///
/// This subscriber periodically fetches recent prioritization fees for a set of Solana accounts in a background task.
/// If fetching fails, it will retry up to 3 times before stopping the background task and marking itself as unsubscribed.
/// After unsubscribing (either manually or due to repeated failures), queries for the priority fee can be checked safely using `priority_fee_safe()`.
///
/// # Example
/// ```rust
/// # use drift_rs::PriorityFeeSubscriber;
/// # use solana_pubkey::Pubkey;
/// let endpoint = "https://api.mainnet-beta.solana.com".to_string();
/// let accounts = vec![Pubkey::new_unique()];
/// let subscriber = PriorityFeeSubscriber::new(endpoint, &accounts);
/// let subscriber = subscriber.subscribe();
/// // ... later, after the background task has populated fees ...
/// if subscriber.is_subscribed() {
///     let fee = subscriber.priority_fee(); // may panic if not yet populated
///     // use fee
/// } else {
///     // handle unsubscribed or stopped state
/// }
/// // Or, use the safe method:
/// if let Some(fee) = subscriber.priority_fee_safe() {
///     // use fee
/// } else {
///     // handle unsubscribed or stopped state
/// }
/// ```
pub struct PriorityFeeSubscriber {
    config: PriorityFeeSubscriberConfig,
    /// Accounts to lock for the priority fee calculation
    writeable_accounts: Vec<Pubkey>,
    rpc_client: RpcClient,
    latest_fees: RwLock<Vec<u64>>,
    /// unsubscriber handler
    unsub: Mutex<Option<oneshot::Sender<()>>>,
}

/// Options for `PriorityFeeSubscriber`
pub struct PriorityFeeSubscriberConfig {
    /// how frequently to re-poll the priority fee
    pub refresh_frequency: Option<Duration>,
    /// # of historic slots to consider in the fee calculation
    /// max: 150
    pub window: Option<Slot>,
}

impl PriorityFeeSubscriber {
    /// Create new `PriorityFeeSubscriber` assuming a tx will lock `writeable_accounts`
    pub fn new(endpoint: String, writeable_accounts: &[Pubkey]) -> Self {
        Self::with_config(
            RpcClient::new(endpoint),
            writeable_accounts,
            PriorityFeeSubscriberConfig {
                refresh_frequency: Some(DEFAULT_REFRESH_FREQUENCY),
                window: Some(DEFAULT_SLOT_WINDOW),
            },
        )
    }

    /// Create new `PriorityFeeSubscriber` assuming a tx will lock `writeable_accounts`
    pub fn with_config(
        rpc_client: RpcClient,
        writeable_accounts: &[Pubkey],
        config: PriorityFeeSubscriberConfig,
    ) -> Self {
        Self {
            config,
            writeable_accounts: writeable_accounts.to_vec(),
            rpc_client,
            latest_fees: RwLock::new(Default::default()),
            unsub: Mutex::default(),
        }
    }

    /// Start the priority fee subscriber task
    ///
    /// Returns a handle to the subscriber for querying results
    pub fn subscribe(self) -> Arc<PriorityFeeSubscriber> {
        let (unsub_tx, mut unsub_rx) = oneshot::channel();
        {
            let mut guard = self.unsub.try_lock().expect("uncontested");
            guard.replace(unsub_tx);
        }

        let arc = Arc::new(self);

        tokio::spawn({
            let this = Arc::clone(&arc);
            async move {
                let mut refresh = tokio::time::interval(
                    this.config
                        .refresh_frequency
                        .unwrap_or(DEFAULT_REFRESH_FREQUENCY),
                );
                let window = this
                    .config
                    .window
                    .unwrap_or(DEFAULT_SLOT_WINDOW)
                    .clamp(5, 150) as usize; // 150 max slots from node cache

                let max_attempts = 3;
                let mut attempts = 0;
                loop {
                    let _ = refresh.tick().await;
                    let response = this
                        .rpc_client
                        .get_recent_prioritization_fees(this.writeable_accounts.as_slice())
                        .await;

                    match response {
                        Ok(response) => {
                            attempts = 0;
                            let mut latest_fees: Vec<u64> = response
                                .iter()
                                .take(window)
                                .map(|x| x.prioritization_fee)
                                .collect();
                            latest_fees.sort_unstable();
                            let mut current_fees = this.latest_fees.write().expect("acquired");
                            *current_fees = latest_fees;
                        }
                        Err(err) => {
                            warn!("failed to fetch priority fee: {err:?}");
                            attempts += 1;
                            if attempts > max_attempts {
                                log::error!("unable to fetch priority fees: reached retry limit");
                                break;
                            }
                        }
                    }

                    if unsub_rx.try_recv().is_ok() {
                        warn!("unsubscribing priority fees");
                        break;
                    }
                }
            }
        });

        arc
    }

    /// Stop the associated network subscription task
    pub fn unsubscribe(&self) {
        let mut guard = self.unsub.lock().expect("acquired");
        if let Some(unsub) = guard.take() {
            if unsub.send(()).is_err() {
                log::error!("couldn't unsubscribe");
            }
        }
    }

    /// Returns true if the subscriber is still active (subscribed).
    pub fn is_subscribed(&self) -> bool {
        self.unsub.lock().expect("acquired").is_some()
    }

    /// Returns the median priority fee in micro-lamports over the look-back window, or None if unsubscribed.
    pub fn priority_fee_safe(&self) -> Option<u64> {
        if self.is_subscribed() {
            Some(self.priority_fee())
        } else {
            None
        }
    }

    /// Returns the median priority fee in micro-lamports over the look-back window.
    ///
    /// # Panics
    ///
    /// Panics if called before the subscriber has populated any fees (i.e., if no data is available yet).
    pub fn priority_fee(&self) -> u64 {
        self.priority_fee_nth(0.5)
    }

    /// Returns the n-th percentile priority fee in micro-lamports over the look-back window.
    /// `percentile` given as decimal 0.0 < n <= 1.0
    ///
    /// # Panics
    ///
    /// Panics if called before the subscriber has populated any fees (i.e., if no data is available yet).
    pub fn priority_fee_nth(&self, percentile: f32) -> u64 {
        let lock = self.latest_fees.read().expect("acquired");
        if lock.is_empty() {
            panic!("PriorityFeeSubscriber is not subscribed");
        }
        let n = lock.len();
        if n == 1 {
            return lock[0];
        }
        let rank = percentile * (n as f32 - 1.0);
        let lower = rank.floor() as usize;
        let upper = rank.ceil() as usize;
        if lower == upper {
            lock[lower]
        } else {
            let weight = rank - lower as f32;
            (lock[lower] as f32 * (1.0 - weight) + lock[upper] as f32 * weight).round() as u64
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use solana_rpc_client::rpc_client::Mocks;
    use solana_rpc_client_api::{request::RpcRequest, response::RpcPrioritizationFee};

    use super::*;

    #[tokio::test]
    async fn priority_fee_subscribe() {
        let _ = env_logger::try_init();
        let account_one = Pubkey::new_unique();
        let account_two = Pubkey::new_unique();

        let mut response_mocks = Mocks::default();
        let recent_fees: Vec<RpcPrioritizationFee> = [1, 3, 5, 6, 4, 7, 2, 9, 8]
            .into_iter()
            .enumerate()
            .map(|(i, f)| RpcPrioritizationFee {
                slot: i as u64,
                prioritization_fee: f,
            })
            .collect();

        response_mocks.insert(RpcRequest::GetRecentPrioritizationFees, json!(recent_fees));

        let mock_rpc = RpcClient::new_mock_with_mocks(
            "https://api.mainnet-beta.solana.com".into(),
            response_mocks,
        );
        let writeable_accounts = &[account_one, account_two];

        let pf = PriorityFeeSubscriber::with_config(
            mock_rpc,
            writeable_accounts,
            PriorityFeeSubscriberConfig {
                refresh_frequency: Some(Duration::from_secs(5)),
                window: Some(100),
            },
        );

        // test
        let pf = pf.subscribe();
        tokio::time::sleep(Duration::from_millis(100)).await; // wait for subscriber to populate

        let pf_median = pf.priority_fee();
        assert_eq!(pf_median, 5);
        let pf_99 = pf.priority_fee_nth(0.99);
        assert_eq!(pf_99, 9);
        let pf_05 = pf.priority_fee_nth(0.05);
        assert_eq!(pf_05, 1);
    }
}
