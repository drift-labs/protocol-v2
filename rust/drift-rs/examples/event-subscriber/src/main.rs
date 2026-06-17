use clap::Parser;
use dotenv;
use drift_rs::event_subscriber::{DriftEvent, EventSubscriber};
use drift_rs::{PubsubClient, constants::PROGRAM_ID};
use env_logger;
use futures_util::StreamExt;
use std::env;
use std::sync::Arc;
use tokio;

#[derive(Parser, Debug)]
#[clap(author, version, about, long_about = None)]
struct Args {
    #[clap(long, action, help = "Use gRPC for event subscription")]
    grpc: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = env_logger::init();
    let _ = dotenv::dotenv().ok();
    let args = Args::parse();

    let mut event_subscriber = if args.grpc {
        let grpc_endpoint = env::var("GRPC_ENDPOINT").expect("GRPC_ENDPOINT must be set");
        let grpc_x_token = env::var("GRPC_X_TOKEN").expect("GRPC_X_TOKEN must be set");
        EventSubscriber::subscribe_grpc(grpc_endpoint, grpc_x_token, PROGRAM_ID)
            .await
            .expect("error subscribing to grpc events")
    } else {
        let ws_rpc_endpoint = env::var("WS_RPC_ENDPOINT").expect("WS_RPC_ENDPOINT must be set");
        let client = PubsubClient::new(&ws_rpc_endpoint).await.unwrap();
        EventSubscriber::subscribe(Arc::new(client), PROGRAM_ID)
            .await
            .expect("error subscribing to ws events")
    };

    println!("subscribed to events");
    let mut count = 0;
    while let Some(event) = event_subscriber.next().await {
        match event {
            DriftEvent::OrderFill {
                maker,
                // maker_fee,
                maker_order_id,
                maker_side,
                taker,
                // taker_fee,
                taker_order_id,
                taker_side,
                // base_asset_amount_filled,
                // quote_asset_amount_filled,
                market_index,
                market_type,
                // oracle_price,
                signature,
                // tx_idx,
                // ts,
                bit_flags,
                ..
            } => {
                println!(
                    "order fill: market: {}-{} maker: {}-{}-{} taker: {}-{}-{} signature: {} bit_flags: {}",
                    market_type.as_str(),
                    market_index,
                    maker.unwrap_or_default().to_string().as_str(),
                    maker_order_id,
                    format!("{:?}", maker_side.unwrap_or_default()),
                    taker.unwrap_or_default().to_string().as_str(),
                    taker_order_id,
                    format!("{:?}", taker_side.unwrap_or_default()),
                    signature,
                    bit_flags
                );
                count += 1;
                if count > 100 {
                    break;
                }
            }
            _ => {}
        }
    }

    event_subscriber.unsubscribe();
    Ok(())
}
