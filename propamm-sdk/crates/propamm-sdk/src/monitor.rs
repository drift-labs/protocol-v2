use std::sync::Arc;
use std::time::Duration;

use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use solana_pubsub_client::nonblocking::pubsub_client::PubsubClient;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;

use crate::constants::SEQUENCE_NUMBER_OFFSET;

/// Read the 8-byte sequence number from a midprice account's raw data.
///
/// * `data` - Raw account data bytes (must be at least [`SEQUENCE_NUMBER_OFFSET`] + 8 bytes).
///
/// Returns `None` if the data is too short.
pub fn read_sequence_number(data: &[u8]) -> Option<u64> {
    if data.len() < SEQUENCE_NUMBER_OFFSET + 8 {
        return None;
    }
    Some(u64::from_le_bytes(
        data[SEQUENCE_NUMBER_OFFSET..SEQUENCE_NUMBER_OFFSET + 8]
            .try_into()
            .unwrap(),
    ))
}

/// Poll the midprice account's sequence number at a fixed interval.
///
/// Calls `on_change` whenever the sequence number changes (i.e. a fill occurred).
/// Returns a [`JoinHandle`](tokio::task::JoinHandle) — abort to stop polling.
///
/// * `rpc` - Shared RPC client.
/// * `midprice_address` - Midprice account PDA to monitor.
/// * `interval` - Polling interval between RPC calls.
/// * `on_change` - Callback invoked with the new sequence number on each change.
pub fn poll_sequence_number<F>(
    rpc: Arc<RpcClient>,
    midprice_address: Pubkey,
    interval: Duration,
    on_change: F,
) -> tokio::task::JoinHandle<()>
where
    F: Fn(u64) + Send + 'static,
{
    tokio::spawn(async move {
        let mut last_seq: Option<u64> = None;
        loop {
            match rpc
                .get_account_with_commitment(&midprice_address, CommitmentConfig::confirmed())
                .await
            {
                Ok(resp) => {
                    if let Some(account) = resp.value {
                        if let Some(seq) = read_sequence_number(&account.data) {
                            if last_seq != Some(seq) {
                                last_seq = Some(seq);
                                on_change(seq);
                            }
                        }
                    }
                }
                Err(e) => {
                    log::warn!("poll_sequence_number error: {e}");
                }
            }
            tokio::time::sleep(interval).await;
        }
    })
}

/// Subscribe to midprice account changes via WebSocket.
///
/// Calls `on_change` with the new sequence number whenever the account data updates.
/// Automatically reconnects on connection loss.
/// Returns a [`JoinHandle`](tokio::task::JoinHandle) — abort to unsubscribe.
///
/// * `ws_url` - Solana WebSocket endpoint URL (e.g. `wss://api.devnet.solana.com`).
/// * `midprice_address` - Midprice account PDA to monitor.
/// * `on_change` - Callback invoked with the new sequence number on each update.
pub fn subscribe_midprice<F>(
    ws_url: String,
    midprice_address: Pubkey,
    on_change: F,
) -> tokio::task::JoinHandle<()>
where
    F: Fn(u64) + Send + 'static,
{
    use futures_util::StreamExt;
    use solana_account_decoder::UiAccountEncoding;
    use solana_rpc_client_api::config::RpcAccountInfoConfig;

    tokio::spawn(async move {
        let config = RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            commitment: Some(CommitmentConfig::confirmed()),
            ..Default::default()
        };

        loop {
            match PubsubClient::new(&ws_url).await {
                Ok(client) => {
                    match client
                        .account_subscribe(&midprice_address, Some(config.clone()))
                        .await
                    {
                        Ok((mut stream, _unsub)) => {
                            while let Some(response) = stream.next().await {
                                if let Some(data_bytes) = response.value.data.decode() {
                                    if let Some(seq) = read_sequence_number(&data_bytes) {
                                        on_change(seq);
                                    }
                                }
                            }
                            log::warn!("subscribe_midprice: stream ended, reconnecting...");
                        }
                        Err(e) => {
                            log::warn!("subscribe_midprice: subscribe error: {e}");
                        }
                    }
                }
                Err(e) => {
                    log::warn!("subscribe_midprice: connect error: {e}");
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    })
}
