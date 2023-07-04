/// Example of loading dlob from all user orders, using websocket account subscriber
///
/// Set environment variables:
///     * `RPC_HTTP_URL`: RPC node http url
///     * `RPC_WS_URL`: RPC node ws url (will be derived from http url if not set)
///
/// Run example with:
///     cargo run --example load_dlob_from_users
///
use anchor_client::solana_client::rpc_client::RpcClient;
use anchor_client::solana_sdk::commitment_config::{CommitmentConfig, CommitmentLevel};
use anchor_client::solana_sdk::signature::Keypair;
use anchor_client::{Client, Cluster};
use anchor_lang::prelude::Pubkey;
use dotenv::dotenv;
use drift::state::user::MarketType;
use drift_sdk::dlob::DlobBuilder;
use drift_sdk::websocket_drift_client_account_subscriber::WebsocketAccountSubscriber;
use std::env;
use std::rc::Rc;
use std::str::FromStr;
use tokio::select;

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

    let rpc_client = RpcClient::new_with_commitment(cluster.url(), CommitmentConfig { commitment });
    let mut curr_slot = rpc_client.get_slot().unwrap();
    println!("curr_slot: {}", curr_slot);

    let start = std::time::Instant::now();
    println!("Loading dlob...");
    let mut dlob = DlobBuilder::default()
        .account_subscriber(account_subscriber)
        .build()
        .unwrap();
    dlob.init(curr_slot).unwrap();
    println!("Loaded dlob in {} seconds", start.elapsed().as_secs_f32());

    let mut poll = tokio::time::interval(tokio::time::Duration::from_secs(1));
    loop {
        select! {
            _ = poll.tick() => {

                curr_slot = rpc_client.get_slot().unwrap();

                let start = std::time::Instant::now();
                println!("{} Loading dlob...", curr_slot);
                dlob.init(curr_slot).unwrap();
                println!(
                    "Loaded dlob in {} seconds",
                    start.elapsed().as_secs_f32()
                );

                // TODO: doenst seem to be pulling taker orders from latest user data..
                let bids = dlob.get_taking_bids(0, MarketType::Perp, curr_slot);
                let mut bid_count = 0;
                for bid in bids {
                    bid_count+=1;
                    let o = bid.order();
                    let u = bid.user();
                    println!("bid: {:?} {:?} {:?} {:?} {:?} {:?}", u.to_string(), o.direction, o.order_type, o.order_id, o.price, o.base_asset_amount);
                }
                println!("{} bids", bid_count);
                println!("");
            }
        }
    }

    Ok(())
}
