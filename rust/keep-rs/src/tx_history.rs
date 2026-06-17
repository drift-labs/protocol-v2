use std::sync::Arc;

use clap::Parser;
use drift_rs::event_subscriber::DriftEvent;
use futures_util::stream::FuturesUnordered;
use futures_util::StreamExt;
use solana_commitment_config::CommitmentConfig;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::config::RpcTransactionConfig;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signature;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// The pubkey to query
    pub pubkey: String,
    /// RPC URL (optional)
    #[arg(long, default_value = "https://api.mainnet-beta.solana.com")]
    pub rpc_url: String,
}

#[tokio::main]
async fn main() {
    env_logger::init();
    let args = Args::parse();
    let pubkey = match args.pubkey.parse::<Pubkey>() {
        Ok(pk) => pk,
        Err(_) => {
            log::error!("Invalid pubkey: {}", args.pubkey);
            std::process::exit(1);
        }
    };
    let client = RpcClient::new_with_commitment(args.rpc_url, CommitmentConfig::confirmed());
    let signatures = match client
        .get_signatures_for_address_with_config(
            &pubkey,
            solana_rpc_client::rpc_client::GetConfirmedSignaturesForAddress2Config {
                limit: Some(256),
                ..Default::default()
            },
        )
        .await
    {
        Ok(sigs) => sigs,
        Err(e) => {
            log::error!("Failed to fetch signatures: {e}");
            std::process::exit(1);
        }
    };

    // Fetch transactions concurrently
    let futs = FuturesUnordered::new();
    let rpc = Arc::new(client);
    for sig_info in &signatures {
        let sig = sig_info.signature.clone();
        let client = Arc::clone(&rpc);
        let signature = match sig.parse::<Signature>() {
            Ok(s) => s,
            Err(_) => continue,
        };
        log::debug!("fetch tx: {sig:?}");
        futs.push(async move {
            let tx = client
                .get_transaction_with_config(
                    &signature,
                    RpcTransactionConfig {
                        encoding: Some(solana_transaction_status::UiTransactionEncoding::Base64),
                        max_supported_transaction_version: Some(0),
                        ..Default::default()
                    },
                )
                .await;
            (sig, tx)
        });
    }
    log::info!("fetching txs...");
    let tx_results: Vec<_> = futs.collect().await;

    // Now process all results serially
    let mut success_count = 0;
    let mut trigger_count = 0;
    let mut fail_count = 0;
    let mut order_dne_count = 0;
    let mut no_fill_count = 0;
    let mut empty_events_count = 0;

    for (i, (sig, tx_result)) in tx_results.into_iter().enumerate() {
        let sig_info = &signatures[i];
        let err = sig_info.err.as_ref();
        let mut had_fill = false;
        let mut had_order_dne = false;
        let mut had_trigger = false;
        match tx_result {
            Ok(tx_data) => {
                if let Some(meta) = tx_data.transaction.meta {
                    if !meta.log_messages.is_some() {
                        empty_events_count += 1;
                        continue;
                    }
                    let logs = meta.log_messages.unwrap();
                    for (tx_idx, log) in logs.iter().enumerate() {
                        if log.contains("Order does not exist") {
                            had_order_dne = true;
                        }
                        if let Some(event) =
                            drift_rs::event_subscriber::try_parse_log(log.as_str(), &sig, tx_idx)
                        {
                            if let DriftEvent::OrderFill { .. } = event {
                                had_fill = true;
                            }
                            if let DriftEvent::OrderTrigger { .. } = event {
                                had_trigger = true;
                            }
                        }
                    }
                }
            }
            Err(e) => {
                log::warn!("Failed to fetch tx {}: {e}", sig);
            }
        }
        if err.is_some() {
            fail_count += 1;
        } else {
            success_count += 1;
        }
        if had_order_dne {
            order_dne_count += 1;
        }
        // tx must be successful
        if !had_fill && err.is_none() {
            no_fill_count += 1;
        }
        if had_trigger && err.is_none() {
            trigger_count += 1;
        }
    }

    log::info!("\nSummary for {}:", pubkey);
    log::info!("  Success: {}", success_count);
    log::info!("  Failed: {}", fail_count);
    log::info!("  'Order does not exist' logs: {}", order_dne_count);
    log::info!("  'OrderTrigger' events: {}", trigger_count);
    log::info!("  No OrderFill events: {}", no_fill_count);
    log::info!("  No events: {}", empty_events_count);
}
