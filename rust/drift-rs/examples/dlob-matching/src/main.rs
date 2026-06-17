//! Example demonstrating DLOB L3 methods and the importance of oracle price
//!
//! This example demonstrates how to use the 4 main L3 order retrieval methods:
//! - get_taker_bids_l3
//! - get_maker_bids_l3
//! - get_taker_asks_l3
//! - get_maker_asks_l3
//!
//! **Key Concept: Oracle Price Importance**
//!
//! The oracle price is essential for rendering DLOB orders because:
//! 1. Floating limit orders have prices defined as offsets from the oracle price
//! 2. Oracle orders dynamically adjust based on the current oracle price
//! 3. Trigger orders evaluate whether they should trigger based on oracle price
//!
//! Example:
//! - A floating limit order with oracle_offset = -100 will be priced at (oracle_price - 100)
//! - If the oracle is $50,000, the order appears at $49,900
//! - If you provide the wrong oracle price (e.g., $51,000), the order will appear at $50,900 (wrong!)

use drift_rs::{
    dlob::builder::DLOBBuilder,
    types::{MarketId, MarketType},
    Context, DriftClient, GrpcSubscribeOpts, RpcClient,
};
use solana_commitment_config::CommitmentLevel;
use solana_keypair::Keypair;

#[tokio::main]
async fn main() {
    let _ = dotenv::dotenv();
    let _ = env_logger::init();

    // Initialize drift client
    let rpc_url = std::env::var("RPC_URL")
        .unwrap_or_else(|_| "https://api.mainnet-beta.solana.com".to_string());
    let drift = DriftClient::new(
        Context::MainNet,
        RpcClient::new(rpc_url),
        Keypair::new().into(),
    )
    .await
    .expect("initialized client");

    // Sync initial user accounts to populate DLOB
    let account_map = drift.backend().account_map();
    account_map
        .sync_user_accounts(vec![drift_rs::memcmp::get_user_with_order_filter()])
        .await
        .expect("synced user accounts");

    // Build DLOB with initial state
    let dlob_builder = DLOBBuilder::new(account_map);
    let dlob = dlob_builder.dlob();

    // Start gRPC subscription for live updates
    let grpc_url = std::env::var("GRPC_URL").expect("GRPC_URL must be set in .env");
    let grpc_x_token = std::env::var("GRPC_X_TOKEN").expect("GRPC_X_TOKEN must be set in .env");

    let grpc_handle = tokio::spawn(async move {
        drift
            .grpc_subscribe(
                grpc_url,
                grpc_x_token,
                GrpcSubscribeOpts::default()
                    .commitment(CommitmentLevel::Processed)
                    .usermap_on()
                    .on_user_account(dlob_builder.account_update_handler(account_map))
                    .on_slot(dlob_builder.slot_update_handler()),
                true,
            )
            .await
    });

    // Wait for initial sync
    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

    // Fetch fresh oracle price - critical for accurate order pricing
    // Fresh oracle prices are essential because:
    // - Floating limit orders price = oracle_price + offset
    // - Oracle orders dynamically adjust with oracle price
    // - Trigger orders evaluate based on oracle price
    // Without fresh prices, you'll see stale/incorrect order prices and miss opportunities
    let market_index = 0u16;
    let market_type = MarketType::Perp;
    
    // this is the most update to date oracle price from gRPC
    // however more advanced setups may query from pyth price feeds directly
    let oracle_data = drift
        .try_get_oracle_price_data_and_slot(MarketId::perp(market_index))
        .expect("oracle data exists");
    let oracle_price = oracle_data.data.price as u64;

    println!("Oracle Price: ${}.{:08}", oracle_price / 100_000_000, oracle_price % 100_000_000);
    println!("Slot: {}", oracle_data.slot);
    println!();

    let perp_market = drift
        .backend()
        .perp_market(market_index)
        .map(|m| m.clone());
    // this is typically the oracle_price but can also be a median price based on funding
    let trigger_price = oracle_price;

    // Demonstrate the 4 L3 methods
    
    // 1. Maker bids - resting limit buy orders
    let maker_bids = dlob.get_maker_bids_l3(market_index, market_type, oracle_price);
    println!("Maker Bids (top 5):");
    for (i, order) in maker_bids.iter().take(5).enumerate() {
        let price_usd = (order.price as f64) / 100_000_000.0;
        println!(
            "  {}. ${:.2} @ {} (user: {}, kind: {:?})",
            i + 1, price_usd, order.size, &order.user.to_string()[..8], order.kind
        );
    }

    // 2. Maker asks - resting limit sell orders
    let maker_asks = dlob.get_maker_asks_l3(market_index, market_type, oracle_price);
    println!("\nMaker Asks (top 5):");
    for (i, order) in maker_asks.iter().take(5).enumerate() {
        let price_usd = (order.price as f64) / 100_000_000.0;
        println!(
            "  {}. ${:.2} @ {} (user: {}, kind: {:?})",
            i + 1, price_usd, order.size, &order.user.to_string()[..8], order.kind
        );
    }

    // 3. Taker bids - aggressive market buy orders
    let taker_bids = dlob.get_taker_bids_l3(
        market_index,
        market_type,
        oracle_price,
        trigger_price,
        perp_market.as_ref(),
    );
    println!("\nTaker Bids (top 5):");
    for (i, order) in taker_bids.iter().take(5).enumerate() {
        let price_usd = (order.price as f64) / 100_000_000.0;
        println!(
            "  {}. ${:.2} @ {} (user: {}, kind: {:?})",
            i + 1, price_usd, order.size, &order.user.to_string()[..8], order.kind
        );
    }

    // 4. Taker asks - aggressive market sell orders
    let taker_asks = dlob.get_taker_asks_l3(
        market_index,
        market_type,
        oracle_price,
        trigger_price,
        perp_market.as_ref(),
    );
    println!("\nTaker Asks (top 5):");
    for (i, order) in taker_asks.iter().take(5).enumerate() {
        let price_usd = (order.price as f64) / 100_000_000.0;
        println!(
            "  {}. ${:.2} @ {} (user: {}, kind: {:?})",
            i + 1, price_usd, order.size, &order.user.to_string()[..8], order.kind
        );
    }

    println!("\nTotal: {} maker bids, {} maker asks, {} taker bids, {} taker asks",
        maker_bids.len(), maker_asks.len(), taker_bids.len(), taker_asks.len());

    println!("\nKeeping gRPC subscription running. Press Ctrl+C to exit...");
    let _ = grpc_handle.await;
}
