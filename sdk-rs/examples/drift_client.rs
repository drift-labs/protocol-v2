use anchor_client::solana_sdk::signer::Signer;
/// Example of using drift_client to connect to on chain drift program:
/// cargo run --example drift_client
// use anchor_client::solana_sdk::{signature::read_keypair_file, signer::Signer};
use drift_sdk::drift_client::DriftClient;
use drift_sdk::utils::read_keypair_file_multi_format;

#[tokio::main]
async fn main() {
    let keypair_path =
        "/path/to/keypair.json";

    let keypair = read_keypair_file_multi_format(keypair_path).unwrap();

    println!("keypairl loaded: {:?}", keypair.pubkey().to_string());

    let drift_client = DriftClient::builder()
        .signing_authority(keypair)
        .build()
        .unwrap();
    match drift_client.rpc_client.get_slot() {
        Ok(slot) => println!("Current slot: {:?}", slot),
        Err(err) => println!("Error: {:?}", err),
    }

    println!("rpc http url: {:?}", drift_client.rpc_http_url);
    println!("rpc ws url: {:?}", drift_client.rpc_ws_url);
}
