/// Example of using drift_client to connect to on chain drift program:
/// cargo run --example drift_client
///
///
use anchor_client::solana_sdk::signer::Signer;
use drift_sdk::drift_client::DriftClient;
use drift_sdk::utils::read_keypair_file_multi_format;

// use drift::state::user::User;
// use drift::state::state::State;
use drift::state::perp_market::PerpMarket;
// use drift::state::spot_market::{SpotMarket};

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<(), anchor_client::ClientError> {
    let keypair_path =
        "/path/to/keypair.json";

    let keypair = read_keypair_file_multi_format(keypair_path).unwrap();

    println!("keypairl loaded: {:?}", keypair.pubkey().to_string());

    let drift_client = DriftClient::builder()
        .signing_authority(keypair)
        // .rpc_http_url("https://custom.rpc.url".to_string()) // set custom rpc url
        .build()
        .unwrap();

    match drift_client.rpc_client.get_slot() {
        Ok(slot) => println!("Current slot: {:?}", slot),
        Err(err) => println!("Error: {:?}", err),
    }

    println!("rpc http url: {:?}", drift_client.cluster.url());
    println!("rpc ws url: {:?}", drift_client.cluster.ws_url());

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
    Ok(())
}
