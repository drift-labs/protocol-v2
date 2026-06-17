use anchor_lang::AccountDeserialize;
use clap::Parser;
use dotenv;
use drift_rs::math::constants::BASE_PRECISION_I128;
use drift_rs::types::{accounts::PerpMarket, AccountUpdate, Context};
use drift_rs::{DriftClient, RpcClient, Wallet};
use env_logger;
use futures_util::future::FutureExt;
use rust_decimal::Decimal;
use std::env;
use std::time::{Duration, Instant};
use tokio::time::timeout;

#[derive(Parser, Debug)]
#[clap(author, version, about, long_about = None)]
struct Args {
    #[clap(
        long,
        default_value = "https://api.mainnet-beta.solana.com",
        help = "RPC endpoint URL (auto-converts to WebSocket for subscriptions)"
    )]
    rpc_url: String,

    #[clap(long, action, help = "Use devnet instead of mainnet")]
    devnet: bool,

    #[clap(long, default_value = "30", help = "Duration to run in seconds")]
    duration: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = env_logger::init();
    let _ = dotenv::dotenv().ok();
    let args = Args::parse();

    println!("🚀 Drift Market Update Monitor");
    println!("===============================\n");

    // Allow RPC_URL override from environment
    let rpc_url = env::var("RPC_URL").unwrap_or(args.rpc_url);
    let context = if args.devnet {
        Context::DevNet
    } else {
        Context::MainNet
    };

    println!("📡 Connecting to {} ({})", rpc_url, context.name());

    // Create RPC client and wallet (dummy wallet for read-only operations)
    let rpc_client = RpcClient::new(rpc_url);
    // Create a read-only wallet for client creation (we don't need signing for subscriptions)
    let dummy_wallet =
        Wallet::read_only(solana_pubkey::pubkey!("11111111111111111111111111111111")); // System program as dummy

    // Initialize Drift client
    let client = DriftClient::new(context, rpc_client, dummy_wallet).await?;
    println!("✅ Connected to Drift protocol\n");

    monitor_markets(&client, args.duration).await?;

    println!("\n✅ Market monitoring complete!");

    Ok(())
}

/// Deserialize PerpMarket from account data
fn deserialize_perp_market(data: &[u8]) -> Result<PerpMarket, Box<dyn std::error::Error>> {
    let market = PerpMarket::try_deserialize(&mut &data[..])?;
    Ok(market)
}

/// Monitor markets and print market_index and base_asset_amount_with_amm
async fn monitor_markets(
    client: &DriftClient,
    duration_secs: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    // Get available markets
    let perp_markets = client.get_all_perp_market_ids();

    println!("📈 Available markets:");
    println!("  • Perp markets: {} active", perp_markets.len());

    let start_time = Instant::now();

    let market_callback = move |update: &AccountUpdate| {
        // Deserialize market data
        match deserialize_perp_market(&update.data) {
            Ok(market) => {
                let elapsed = start_time.elapsed().as_secs();
                println!(
                    "[{}s] Market {}: base_asset_amount_with_amm = {}",
                    elapsed,
                    market.market_index,
                    (market.amm.base_asset_amount_with_amm.as_i128() * -1) as f64
                        / BASE_PRECISION_I128 as f64
                );
            }
            Err(e) => {
                eprintln!("Failed to deserialize market: {}", e);
            }
        }
    };

    // Subscribe to markets
    client
        .subscribe_markets_with_callback(&perp_markets, market_callback)
        .await?;

    // client.subscribe_all_oracles_with_callback(on_account)

    println!(
        "⏰ Running for {} seconds... (Press Ctrl+C to stop early)\n",
        duration_secs
    );

    // Run for specified duration
    match timeout(
        Duration::from_secs(duration_secs),
        tokio::signal::ctrl_c().fuse(),
    )
    .await
    {
        Ok(_) => println!("\n🛑 Interrupted by user"),
        Err(_) => println!("\n⏰ Time limit reached"),
    }

    // Unsubscribe (cleanup)
    client.unsubscribe().await?;
    println!("\n✅ Unsubscribed from all market data");

    Ok(())
}
