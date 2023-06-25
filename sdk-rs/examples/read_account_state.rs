/// Example of using drift_client to read current state of an account
///
/// Set environment variables:
///     * `RPC_HTTP_URL`: RPC node http url
///     * `RPC_WS_URL`: RPC node ws url (will be derived from http url if not set)
///     * `AUTHORITY`: authority of account to print data for
///
/// Run example with:
///     cargo run --example read_account_state
///
use anchor_client::solana_sdk::commitment_config::CommitmentLevel;
use anchor_lang::prelude::Pubkey;
use dotenv::dotenv;
use drift::math::constants::{BASE_PRECISION, PRICE_PRECISION, QUOTE_PRECISION};
use std::env;
use std::str::FromStr;

use anchor_client::solana_sdk::signer::Signer;
use drift_sdk::drift_client::DriftClient;
use drift_sdk::types::DisplayUser;
use drift_sdk::utils::read_keypair_file_multi_format;

// use drift::state::user::User;
// use drift::state::state::State;
// use drift::state::perp_market::PerpMarket;
// use drift::state::spot_market::{SpotMarket};

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<(), anchor_client::ClientError> {
    env_logger::init();
    dotenv().ok();

    let mut drift_client_builder = DriftClient::builder();

    let mut auth: Option<Pubkey> = None;
    drift_client_builder = match env::var("AUTHORITY") {
        Ok(authority) => {
            auth = Some(Pubkey::from_str(authority.as_str()).unwrap());
            drift_client_builder.readonly_authority(auth.unwrap())
        }
        Err(_) => drift_client_builder,
    };

    drift_client_builder = match env::var("RPC_HTTP_URL") {
        Ok(rpc_http_url) => drift_client_builder.rpc_http_url(rpc_http_url),
        Err(_) => drift_client_builder,
    };

    drift_client_builder = match env::var("RPC_WS_URL") {
        Ok(rpc_ws_url) => drift_client_builder.rpc_ws_url(rpc_ws_url),
        Err(_) => drift_client_builder,
    };
    drift_client_builder = drift_client_builder.commitment(CommitmentLevel::Processed);

    let mut drift_client = drift_client_builder.build().unwrap();

    match drift_client.rpc_client.get_slot() {
        Ok(slot) => println!("Current slot: {:?}", slot),
        Err(err) => println!("Error: {:?}", err),
    }

    println!("rpc http url: {:?}", drift_client.cluster.url());
    println!("rpc ws url: {:?}", drift_client.cluster.ws_url());

    println!("loading drift client accounts...");
    let start = std::time::Instant::now();
    drift_client.load().unwrap_or_else(|err| {
        println!("Failed to load drift accounts: {:?}", err);
        std::process::exit(1);
    });
    println!("accounts loaded in {} ms", start.elapsed().as_millis());

    println!(
        "user_stats: {}",
        Pubkey::find_program_address(
            &[b"user_stats", auth.unwrap().to_bytes().as_ref()],
            &drift_client.program.id(),
        )
        .0
    );

    let user_stats = drift_client
        .account_subscriber
        .get_user_stats(&auth.unwrap())
        .unwrap();
    // println!("user_stats: {:?}", user_stats);

    for subaccount_id in 0..user_stats.number_of_sub_accounts_created {
        match drift_client
            .account_subscriber
            .get_user_with_slot(&auth.unwrap(), subaccount_id)
        {
            Some(account) => {
                let user = account.data;
                println!("{}\n", DisplayUser(&user));
            }
            None => {
                println!("nothing at subaccount_id: {}", subaccount_id);
            }
        };
    }

    Ok(())
}
