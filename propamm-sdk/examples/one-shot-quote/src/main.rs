use std::sync::Arc;

use propamm_sdk::{
    OrderEntry, PropAmmClient, DRIFT_PROGRAM_ID, MIDPRICE_PINO_PROGRAM_ID, PRICE_PRECISION,
};
use solana_keypair::read_keypair_file;

/// Minimal example: send a single quote (update_mid_price + set_orders) and exit.
///
/// Usage:
///   RPC_URL=http://127.0.0.1:8899 \
///   KEYPAIR_PATH=~/.config/solana/id.json \
///   cargo run --example one-shot-quote
#[tokio::main]
async fn main() {
    env_logger::init();

    let rpc_url = std::env::var("RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8899".into());
    let keypair_path =
        std::env::var("KEYPAIR_PATH").expect("set KEYPAIR_PATH to your maker keypair JSON");
    let market_index: u16 = std::env::var("MARKET_INDEX")
        .unwrap_or_else(|_| "0".into())
        .parse()
        .expect("MARKET_INDEX must be u16");

    let payer = Arc::new(
        read_keypair_file(&keypair_path).unwrap_or_else(|e| panic!("failed to read keypair: {e}")),
    );

    let client = PropAmmClient::new(
        &rpc_url,
        payer,
        market_index,
        0, // subaccount_index
        MIDPRICE_PINO_PROGRAM_ID,
        DRIFT_PROGRAM_ID,
    );

    println!("midprice account: {}", client.midprice_address());

    // Get current slot for ref_slot.
    let slot = client.get_slot().await.expect("failed to get slot");

    // Quote at $50,000 with 10bps spread, 1 level each side, 1 SOL size.
    let mid_price = 50_000 * PRICE_PRECISION; // $50,000 in PRICE_PRECISION
    let spread = mid_price / 1000; // 10bps = 0.1%

    let asks = vec![OrderEntry {
        offset: spread as i64,
        size: 1_000_000_000, // 1 unit in BASE_PRECISION
    }];
    let bids = vec![OrderEntry {
        offset: -(spread as i64),
        size: 1_000_000_000,
    }];

    match client.quote(mid_price, slot, &asks, &bids).await {
        Ok(sig) => println!("quote sent: {sig}"),
        Err(e) => eprintln!("quote failed: {e}"),
    }
}
