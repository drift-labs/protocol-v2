use std::{str::FromStr, sync::Arc, time::Duration};

use log::error;
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_pubkey::Pubkey;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::config::RpcAccountInfoConfig;
use tokio::sync::oneshot;

use crate::{AccountUpdate, UnsubHandle};

/// Subscribes to account updates at regular polled intervals
pub struct PolledAccountSubscriber {
    pubkey: Pubkey,
    interval: Duration,
    rpc_client: Arc<RpcClient>,
}

impl PolledAccountSubscriber {
    /// Create a new polling account subscriber
    ///
    /// `poll_interval` configurable polling interval
    /// `pubkey` the account to poll
    /// `rpc_client` Provides account fetching implementation
    pub fn new(
        pubkey: Pubkey,
        poll_interval: Duration,
        rpc_client: Arc<RpcClient>,
    ) -> PolledAccountSubscriber {
        Self {
            pubkey,
            interval: poll_interval,
            rpc_client: Arc::clone(&rpc_client),
        }
    }

    /// Start the account subscriber
    ///
    /// `on_update` callback to receive new account values
    ///
    /// Returns channel for unsubscribing
    pub fn subscribe<F>(&self, on_update: F) -> UnsubHandle
    where
        F: 'static + Send + Fn(&AccountUpdate),
    {
        let (unsub_tx, mut unsub_rx) = oneshot::channel();

        tokio::spawn({
            let mut interval = tokio::time::interval(self.interval);
            let pubkey = self.pubkey;
            let rpc_client = Arc::clone(&self.rpc_client);

            let config = RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::Base64Zstd),
                commitment: Some(rpc_client.commitment()),
                ..Default::default()
            };
            async move {
                loop {
                    tokio::select! {
                        biased;
                        _ = interval.tick() => {
                            match rpc_client.get_ui_account_with_config(&pubkey, config.clone()).await {
                                Ok(response) => {
                                    if let Some(new_account) = response.value {
                                        on_update(
                                            &AccountUpdate {
                                                owner: Pubkey::from_str(&new_account.owner).unwrap(),
                                                lamports: new_account.lamports,
                                                pubkey,
                                                data: new_account.data.decode().unwrap_or_default(),
                                                slot: response.context.slot,
                                            }
                                        );
                                    }
                                }
                                Err(err) => error!("{err:?}"),
                            }
                        }
                        _ = &mut unsub_rx => {
                            break;
                        }
                    }
                }
            }
        });

        unsub_tx
    }
}

#[cfg(test)]
mod tests {
    use crate::solana_sdk::account::Account;
    use anchor_lang::AccountSerialize;
    use serde_json::json;
    use solana_account_decoder::encode_ui_account;
    use solana_account_decoder_client_types::UiAccountEncoding;
    use solana_rpc_client::rpc_client::Mocks;
    use solana_rpc_client_api::request::RpcRequest;

    use super::*;
    use crate::{accounts::User, SpotPosition};

    #[tokio::test]
    async fn polled_account_subscriber_updates() {
        // mock account response
        let owner = Pubkey::new_unique();
        let sub_account = Pubkey::new_unique();

        let mut mock_user = User {
            authority: owner,
            ..Default::default()
        };
        mock_user.spot_positions[1] = SpotPosition {
            scaled_balance: 12_345,
            market_index: 1,
            ..Default::default()
        };

        let mut buf = Vec::<u8>::with_capacity(8 + std::mem::size_of::<User>());
        buf.extend_from_slice(&<User as anchor_lang::Discriminator>::DISCRIMINATOR);
        buf.extend_from_slice(bytemuck::bytes_of(&mock_user));

        let mock_account = Account {
            data: buf,
            ..Default::default()
        };

        let mut response_mocks = Mocks::default();
        let account_response = json!({
            "context": {
                "slot": 12_345,
            },
            "value": encode_ui_account(&sub_account, &mock_account, UiAccountEncoding::Base64Zstd, None, None),
        });
        response_mocks.insert(RpcRequest::GetAccountInfo, account_response);

        let mock_rpc = RpcClient::new_mock_with_mocks(
            "https://api.mainnet-beta.solana.com".into(),
            response_mocks,
        );

        // test
        let subscriber =
            PolledAccountSubscriber::new(sub_account, Duration::from_secs(1), Arc::new(mock_rpc));
        let _unsub = subscriber.subscribe(move |user| {
            assert_eq!(user.data, mock_account.data,);
        });
        let _ = tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
