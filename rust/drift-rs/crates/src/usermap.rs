use std::{
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use crate::solana_sdk::{commitment_config::CommitmentConfig, pubkey::Pubkey};
use anchor_lang::{AccountDeserialize, AnchorDeserialize};
use dashmap::DashMap;
use serde_json::json;
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::{
    config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    filter::RpcFilterType,
    request::RpcRequest,
    response::{OptionalContext, RpcKeyedAccount},
};

use crate::{
    constants,
    drift_idl::accounts::User,
    memcmp::{get_non_idle_user_filter, get_user_filter},
    utils::get_ws_url,
    websocket_program_account_subscriber::{
        WebsocketProgramAccountOptions, WebsocketProgramAccountSubscriber,
    },
    SdkResult, UnsubHandle,
};

/// Subscribes to the _all_ Drift users' account updates via Ws program subscribe
pub struct GlobalUserMap {
    subscribed: bool,
    subscription: WebsocketProgramAccountSubscriber,
    pub usermap: Arc<DashMap<String, User>>,
    sync_lock: Option<Mutex<()>>,
    latest_slot: Arc<AtomicU64>,
    commitment: CommitmentConfig,
    rpc: RpcClient,
}

impl GlobalUserMap {
    pub const SUBSCRIPTION_ID: &'static str = "usermap";

    pub fn new(
        commitment: CommitmentConfig,
        endpoint: String,
        sync: bool,
        additional_filters: Option<Vec<RpcFilterType>>,
    ) -> Self {
        let mut filters = vec![get_user_filter(), get_non_idle_user_filter()];
        filters.extend(additional_filters.unwrap_or_default());
        let options = WebsocketProgramAccountOptions {
            filters,
            commitment,
            encoding: UiAccountEncoding::Base64Zstd,
        };
        let url = get_ws_url(&endpoint).unwrap();

        let subscription = WebsocketProgramAccountSubscriber::new(url, options);

        let usermap = Arc::new(DashMap::new());
        let rpc = RpcClient::new_with_commitment(endpoint.clone(), commitment);
        let sync_lock = if sync { Some(Mutex::new(())) } else { None };

        Self {
            subscribed: false,
            subscription,
            usermap,
            sync_lock,
            latest_slot: Arc::new(AtomicU64::new(0)),
            commitment,
            rpc,
        }
    }

    pub async fn subscribe(&self) -> SdkResult<UnsubHandle> {
        if self.sync_lock.is_some() {
            self.sync().await?;
        }

        let unsub = self
            .subscription
            .subscribe::<User, _>(Self::SUBSCRIPTION_ID, {
                let latest_slot = self.latest_slot.clone();
                let user_map = self.usermap.clone();
                move |update| {
                    if update.data_and_slot.slot > latest_slot.load(Ordering::Relaxed) {
                        latest_slot.store(update.data_and_slot.slot, Ordering::Relaxed);
                    }
                    user_map.insert(update.pubkey.clone(), update.data_and_slot.data);
                }
            });

        Ok(unsub)
    }

    pub fn unsubscribe(self) -> SdkResult<()> {
        if self.subscribed {
            self.usermap.clear();
            self.latest_slot.store(0, Ordering::Relaxed);
        }
        Ok(())
    }

    pub fn size(&self) -> usize {
        self.usermap.len()
    }

    pub fn contains(&self, pubkey: &str) -> bool {
        self.usermap.contains_key(pubkey)
    }

    pub fn get(&self, pubkey: &str) -> Option<User> {
        self.usermap.get(pubkey).map(|user| *user.value())
    }

    pub async fn must_get(&self, pubkey: &str) -> SdkResult<User> {
        if let Some(user) = self.get(pubkey) {
            Ok(user)
        } else {
            let user_data = self
                .rpc
                .get_account_data(&Pubkey::from_str(pubkey).unwrap())
                .await?;
            let user = User::deserialize(&mut user_data.as_slice()).unwrap();
            self.usermap.insert(pubkey.to_string(), user);
            Ok(self.get(pubkey).unwrap())
        }
    }

    #[allow(clippy::await_holding_lock)]
    pub async fn sync(&self) -> SdkResult<()> {
        let sync_lock = self.sync_lock.as_ref().expect("expected sync lock");

        let _lock = match sync_lock.try_lock() {
            Ok(lock) => lock,
            Err(_) => return Ok(()),
        };

        let account_config = RpcAccountInfoConfig {
            commitment: Some(self.commitment),
            encoding: Some(self.subscription.options.encoding),
            ..RpcAccountInfoConfig::default()
        };

        let gpa_config = RpcProgramAccountsConfig {
            filters: Some(self.subscription.options.filters.clone()),
            account_config,
            with_context: Some(true),
            sort_results: None,
        };

        let response = self
            .rpc
            .send::<OptionalContext<Vec<RpcKeyedAccount>>>(
                RpcRequest::GetProgramAccounts,
                json!([constants::PROGRAM_ID.to_string(), gpa_config]),
            )
            .await?;

        if let OptionalContext::Context(accounts) = response {
            for account in accounts.value {
                let pubkey = account.pubkey;
                let user_data = account.account.data.decode().expect("User data");
                let data = User::try_deserialize_unchecked(&mut user_data.as_slice())
                    .expect("User deserializes");
                self.usermap.insert(pubkey, data);
            }

            self.latest_slot
                .store(accounts.context.slot, Ordering::Relaxed);
        }

        Ok(())
    }

    pub fn get_latest_slot(&self) -> u64 {
        self.latest_slot.load(Ordering::Relaxed)
    }
}

#[cfg(feature = "rpc_tests")]
mod tests {
    use crate::utils::test_envs::mainnet_endpoint;

    #[tokio::test]
    async fn test_usermap() {
        use crate::solana_sdk::commitment_config::{CommitmentConfig, CommitmentLevel};

        use crate::usermap::GlobalUserMap;

        let commitment = CommitmentConfig {
            commitment: CommitmentLevel::Processed,
        };

        let mut usermap = GlobalUserMap::new(commitment, mainnet_endpoint(), true);
        usermap.subscribe().await.unwrap();

        tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;

        dbg!(usermap.size());
        assert!(usermap.size() > 50000);

        dbg!(usermap.get_latest_slot());

        usermap.unsubscribe().await.unwrap();

        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;

        assert_eq!(usermap.size(), 0);
        assert_eq!(usermap.subscribed, false);
    }
}
