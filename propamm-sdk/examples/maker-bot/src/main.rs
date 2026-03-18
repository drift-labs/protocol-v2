use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
use log::{error, info};
use propamm_sdk::{OrderEntry, PropAmmClient, DRIFT_PROGRAM_ID, MIDPRICE_PINO_PROGRAM_ID};
use solana_keypair::read_keypair_file;
use solana_pubkey::Pubkey;
use tokio::signal;

#[derive(Parser, Debug)]
#[command(name = "maker-bot", about = "PropAMM market maker bot")]
struct Args {
    /// Solana RPC URL.
    #[arg(long, env = "RPC_URL", default_value = "http://127.0.0.1:8899")]
    rpc_url: String,

    /// Path to the maker keypair JSON file.
    #[arg(long, env = "KEYPAIR_PATH")]
    keypair_path: String,

    /// Perp market index to quote on.
    #[arg(long, env = "MARKET_INDEX", default_value_t = 0)]
    market_index: u16,

    /// Pyth oracle account pubkey (base58).
    #[arg(long, env = "ORACLE_PUBKEY")]
    oracle_pubkey: String,

    /// Spread in basis points (each side).
    #[arg(long, env = "SPREAD_BPS", default_value_t = 10)]
    spread_bps: u64,

    /// Size per level in base precision (10^9 = 1 unit).
    #[arg(long, env = "SIZE_BASE", default_value_t = 1_000_000_000)]
    size_base: u64,

    /// Number of price levels on each side.
    #[arg(long, env = "NUM_LEVELS", default_value_t = 3)]
    num_levels: usize,

    /// Quote interval in milliseconds.
    #[arg(long, env = "QUOTE_INTERVAL_MS", default_value_t = 2000)]
    quote_interval_ms: u64,

    /// Quote TTL in slots (0 = no expiry).
    #[arg(long, env = "QUOTE_TTL_SLOTS", default_value_t = 30)]
    quote_ttl_slots: u64,

    /// Midprice pino program ID (base58). Override for non-default deployments.
    #[arg(long, env = "MIDPRICE_PROGRAM_ID")]
    midprice_program_id: Option<String>,

    /// Drift program ID (base58). Override for non-default deployments.
    #[arg(long, env = "DRIFT_PROGRAM_ID")]
    drift_program_id: Option<String>,

    /// Subaccount index for the midprice PDA.
    #[arg(long, env = "SUBACCOUNT_INDEX", default_value_t = 0)]
    subaccount_index: u16,
}

#[tokio::main]
async fn main() {
    env_logger::init();
    let args = Args::parse();

    let payer = Arc::new(
        read_keypair_file(&args.keypair_path)
            .unwrap_or_else(|e| panic!("failed to read keypair from {}: {e}", args.keypair_path)),
    );

    let oracle_pubkey: Pubkey = args.oracle_pubkey.parse().expect("invalid ORACLE_PUBKEY");

    let midprice_program_id = args
        .midprice_program_id
        .as_deref()
        .map(|s| s.parse().expect("invalid MIDPRICE_PROGRAM_ID"))
        .unwrap_or(MIDPRICE_PINO_PROGRAM_ID);

    let drift_program_id = args
        .drift_program_id
        .as_deref()
        .map(|s| s.parse().expect("invalid DRIFT_PROGRAM_ID"))
        .unwrap_or(DRIFT_PROGRAM_ID);

    let client = PropAmmClient::new(
        &args.rpc_url,
        payer,
        args.market_index,
        args.subaccount_index,
        midprice_program_id,
        drift_program_id,
    );

    info!(
        "maker-bot starting: market={} midprice_account={} spread={}bps levels={} interval={}ms",
        args.market_index,
        client.midprice_address(),
        args.spread_bps,
        args.num_levels,
        args.quote_interval_ms,
    );

    // Check if midprice account exists; if not, try to initialize.
    match client.fetch_midprice_account().await {
        Ok(_) => info!("midprice account exists"),
        Err(_) => {
            info!("midprice account not found, initializing via Drift CPI...");
            match client.initialize_midprice().await {
                Ok(sig) => info!("initialized midprice account: {sig}"),
                Err(e) => {
                    error!("failed to initialize midprice account: {e}");
                    error!("ensure the midprice PDA is pre-allocated and the matcher PDA exists");
                    return;
                }
            }
        }
    }

    // Set quote TTL.
    if args.quote_ttl_slots > 0 {
        let ttl_ix = client.set_quote_ttl_ix(args.quote_ttl_slots);
        match client.send_tx(&[ttl_ix]).await {
            Ok(sig) => info!("set quote TTL to {} slots: {sig}", args.quote_ttl_slots),
            Err(e) => error!("failed to set quote TTL: {e}"),
        }
    }

    let interval = Duration::from_millis(args.quote_interval_ms);

    loop {
        tokio::select! {
            _ = signal::ctrl_c() => {
                info!("shutting down...");
                break;
            }
            _ = async {
                // Fetch oracle price + current slot concurrently.
                let (oracle_result, slot_result) = tokio::join!(
                    client.fetch_oracle_price(&oracle_pubkey),
                    client.get_slot(),
                );

                let oracle_price = match oracle_result {
                    Ok(p) => p,
                    Err(e) => {
                        error!("oracle fetch error: {e}");
                        tokio::time::sleep(interval).await;
                        return;
                    }
                };

                let slot = match slot_result {
                    Ok(s) => s,
                    Err(e) => {
                        error!("slot fetch error: {e}");
                        tokio::time::sleep(interval).await;
                        return;
                    }
                };

                // Convert oracle price to PRICE_PRECISION (10^6).
                // Pyth prices have a negative exponent; for simplicity we take abs(price) as the
                // mid price in PRICE_PRECISION. Real bots should apply the exponent properly.
                let mid_price = oracle_price.price.unsigned_abs();

                // Compute spread offset per level.
                let base_offset = (args.spread_bps * mid_price) / 10_000;

                let mut asks = Vec::with_capacity(args.num_levels);
                let mut bids = Vec::with_capacity(args.num_levels);

                for i in 0..args.num_levels {
                    let level_offset = base_offset * (i as u64 + 1);
                    asks.push(OrderEntry {
                        offset: level_offset as i64,
                        size: args.size_base,
                    });
                    bids.push(OrderEntry {
                        offset: -(level_offset as i64),
                        size: args.size_base,
                    });
                }

                match client.quote(mid_price, slot, &asks, &bids).await {
                    Ok(sig) => {
                        info!(
                            "quoted: mid_price={} oracle={} slot={} levels={} sig={sig}",
                            mid_price,
                            oracle_price.price,
                            slot,
                            args.num_levels,
                        );
                    }
                    Err(e) => {
                        error!("quote tx error: {e}");
                    }
                }

                tokio::time::sleep(interval).await;
            } => {}
        }
    }

    info!("maker-bot stopped");
}
