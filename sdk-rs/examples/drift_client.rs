use anchor_lang::prelude::Pubkey;
/// Example of using drift_client to connect to on chain drift program:
/// cargo run --example drift_client
///
/// Set environment variables:
/// * RPC_HTTP_URL
/// * RPC_WS_URL
/// * KEYPAIR_FILE
///
///
use dotenv::dotenv;
use drift::math::constants::{BASE_PRECISION, PRICE_PRECISION, QUOTE_PRECISION};
use std::borrow::Borrow;
use std::env;
use tokio::select;

use anchor_client::solana_sdk::signer::Signer;
use drift_sdk::drift_client::DriftClient;
use drift_sdk::utils::read_keypair_file_multi_format;

// use drift::state::user::User;
// use drift::state::state::State;
// use drift::state::perp_market::PerpMarket;
// use drift::state::spot_market::{SpotMarket};

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<(), anchor_client::ClientError> {
    dotenv().ok();

    let mut drift_client_builder = DriftClient::builder();

    let mut auth: Option<Pubkey> = None;
    drift_client_builder = match env::var("KEYPAIR_FILE") {
        Ok(keypair_path) => {
            let keypair = read_keypair_file_multi_format(keypair_path.as_str()).unwrap();
            println!("keypair loaded: {:?}", keypair.pubkey().to_string());
            auth = Some(keypair.pubkey().clone());
            drift_client_builder.signing_authority(keypair)
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

    let mut drift_client = drift_client_builder.build().unwrap();

    match drift_client.rpc_client.get_slot() {
        Ok(slot) => println!("Current slot: {:?}", slot),
        Err(err) => println!("Error: {:?}", err),
    }

    println!("rpc http url: {:?}", drift_client.cluster.url());
    println!("rpc ws url: {:?}", drift_client.cluster.ws_url());

    println!("loading drift client accounts...");
    drift_client.load().unwrap_or_else(|err| {
        println!("Failed to load drift accounts: {:?}", err);
        std::process::exit(1);
    });

    // let perp_market_0 = drift_client.drift_client_account_subscriber.get_perp_market_by_market_index(0);
    // println!("perp_market_0: {:?}\n{}", perp_market_0, String::from_utf8_lossy(&perp_market_0.unwrap().name));
    // let perp_market_20 = drift_client.drift_client_account_subscriber.get_perp_market_by_market_index(20);
    // println!("perp_market_20: {:?}", perp_market_20);

    let mut poll = tokio::time::interval(tokio::time::Duration::from_secs(1));
    loop {
        select! {
            _ = poll.tick() => {
                let perp_market = drift_client.account_subscriber.get_perp_market_by_market_index(1).unwrap();
                let spot_market = drift_client.account_subscriber.get_spot_market_by_market_index(0).unwrap();
                let spot_market_2 = drift_client.account_subscriber.get_spot_market_by_market_index(1).unwrap();
                println!(
                    "==> BTC-PERP: {}, SOL: {}, USDC: {}",
                    perp_market.amm.historical_oracle_data.last_oracle_price as f64 / PRICE_PRECISION as f64,
                    spot_market_2.historical_oracle_data.last_oracle_price as f64 / PRICE_PRECISION as f64,
                    spot_market.historical_oracle_data.last_oracle_price as f64 / PRICE_PRECISION as f64,
                );

                let user = drift_client.account_subscriber.get_user(&auth.unwrap(), 0).unwrap();
                println!("user bal: {:?}", user.get_quote_spot_position().get_signed_token_amount(&spot_market).unwrap() as f64 / QUOTE_PRECISION as f64);
            }
        }
    }

    /*
    let mut markets_count = 0;
    for perp_market in drift_client.program.accounts_lazy::<PerpMarket>(vec![])? {
        match perp_market {
            Ok((pubkey, perp_market)) => {
                println!("Loaded {:?}: {:?}", pubkey.to_string(), String::from_utf8_lossy(&perp_market.name));
            }
            Err(err) => println!("Error: {:?}", err),
        }
        markets_count += 1;
    }
    println!("size of markets: {:?}", markets_count);


    // async tick every 5s
    let mut poll = tokio::time::interval(tokio::time::Duration::from_secs(5));
    loop {
        select! {
            _ = poll.tick() => {
                println!("");
                for perp_market in drift_client.program.accounts_lazy::<PerpMarket>(vec![])? {
                    match perp_market {
                        Ok((_, perp_market)) => {
                            // println!("{:?}: {:?}", pubkey.to_string(), String::from_utf8_lossy(&perp_market.name));
                            println!("{}", String::from_utf8_lossy(&perp_market.name));
                            println!(" {} @ ${}", perp_market.get_open_interest() as f64 / BASE_PRECISION as f64, perp_market.amm.historical_oracle_data.last_oracle_price as f64 / PRICE_PRECISION as f64);
                        }
                        Err(err) => println!("Error: {:?}", err),
                    }
                    markets_count += 1;
                }
            }
        }
    }
    */

    Ok(())
}
