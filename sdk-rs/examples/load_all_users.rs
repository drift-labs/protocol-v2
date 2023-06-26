/// Example of using drift_client and AccountSubscriber to load all users on the exchange to load all users
///
/// Set environment variables:
///     * `RPC_HTTP_URL`: RPC node http url
///     * `RPC_WS_URL`: RPC node ws url (will be derived from http url if not set)
///
/// Run example with:
///     cargo run --example load_all_users
///
use anchor_client::solana_sdk::commitment_config::{CommitmentConfig, CommitmentLevel};
use anchor_client::solana_sdk::signature::Keypair;
use anchor_client::{Client, Cluster};
use anchor_lang::prelude::Pubkey;
use dotenv::dotenv;
use drift_sdk::websocket_drift_client_account_subscriber::WebsocketAccountSubscriber;
use std::env;
use std::rc::Rc;
use std::str::FromStr;

use drift_sdk::types::DriftClientAccountSubscriber;
use drift_sdk::utils::http_to_ws_url;

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<(), anchor_client::ClientError> {
    env_logger::init();
    dotenv().ok();

    let rpc_http_url = env::var("RPC_HTTP_URL").unwrap();
    let rpc_ws_url = env::var("RPC_WS_URL");

    let cluster = Cluster::Custom(
        rpc_http_url.clone(),
        rpc_ws_url.unwrap_or(http_to_ws_url(rpc_http_url.as_str())),
    );

    let commitment = CommitmentLevel::Processed;
    let provider = Client::new_with_options(
        cluster.clone(),
        Rc::new(Keypair::new()), // throwaway
        CommitmentConfig { commitment },
    );
    let program_id = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let program = provider.program(program_id);

    let mut account_subscriber = Box::new(WebsocketAccountSubscriber::new(
        cluster.ws_url().to_string(),
        commitment,
        program,
        None,         // dont want perp markets
        None,         // dont want spot markets
        Some(vec![]), // load ALL users
    )) as Box<dyn DriftClientAccountSubscriber>;

    let start = std::time::Instant::now();
    account_subscriber.load().unwrap();
    println!(
        "Loaded all users in {} seconds",
        start.elapsed().as_secs_f32()
    );

    println!("Getting all users...");
    let start_get_users = std::time::Instant::now();
    let users = account_subscriber.get_all_users();
    println!(
        "Get all users ({}) in {} seconds",
        users.len(),
        start_get_users.elapsed().as_secs_f32()
    );

    Ok(())
}
