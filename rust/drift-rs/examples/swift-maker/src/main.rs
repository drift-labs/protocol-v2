//! Example swift maker bot
//!
//! The `TODO:` comments should be altered depending on individual maker strategy
//!
use drift_rs::{
    swift_order_subscriber::SignedOrderInfo,
    types::{
        MarketId, OrderParams, OrderParamsBitFlag, OrderType, PositionDirection, PostOnlyParam,
    },
    DriftClient, RpcClient, Wallet,
};
use futures_util::StreamExt;
use solana_pubkey::Pubkey;

#[tokio::main]
async fn main() {
    let _ = env_logger::init();
    let _ = dotenv::dotenv();
    let wallet: Wallet = (drift_rs::utils::load_keypair_multi_format(
        &std::env::var("PRIVATE_KEY").expect("base58 PRIVATE_KEY set"),
    )
    .unwrap())
    .into();

    // choose a sub-account for order placement
    let filler_subaccount = wallet.default_sub_account();

    let use_mainnet = std::env::var("MAINNET").is_ok();
    let context = if use_mainnet {
        drift_rs::types::Context::MainNet
    } else {
        drift_rs::types::Context::DevNet
    };
    let rpc_url =
        std::env::var("RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".to_string());
    let drift = DriftClient::new(context, RpcClient::new(rpc_url), wallet)
        .await
        .expect("initialized client");
    let _ = drift
        .subscribe_blockhashes()
        .await
        .expect("subscribed blockhashes");

    // subscribe to filler account (used when building Txs)
    let _ = drift
        .subscribe_account(&filler_subaccount)
        .await
        .expect("subscribed");

    // choose some markets by symbol
    let market_ids: Vec<MarketId> = ["sol-perp"]
        .iter()
        .map(|m| drift.market_lookup(m).expect("market found"))
        .collect();

    let mut swift_order_stream = drift
        .subscribe_swift_orders(&market_ids, Some(true), None, None)
        .await
        .expect("subscribed swift orders");

    // watch orders
    loop {
        tokio::select! {
            biased;
            _ = tokio::signal::ctrl_c() => {
                println!("swift maker shutting down...");
                break;
            }
            swift_order = swift_order_stream.next() => {
                match swift_order {
                    Some(order) => {
                        let _handle = tokio::spawn(try_fill(drift.clone(), filler_subaccount, order));
                    }
                    None => {
                        println!("swift order stream finished");
                        break;
                    }
                }
            }
        }
    }
}

/// Try to fill a swift order
async fn try_fill(drift: DriftClient, filler_subaccount: Pubkey, swift_order: SignedOrderInfo) {
    // TODO: filter `swift_order.order_params()` depending on strategy params
    println!("new swift order: {swift_order:?}");
    let taker_order = swift_order.order_params();
    let taker_subaccount = swift_order.taker_subaccount();

    // fetching taker accounts inline
    // TODO: for better fills maintain a gRPC map of user accounts
    let (taker_account_data, taker_stats, tx_builder) = tokio::try_join!(
        drift.get_user_account(&taker_subaccount), // always hits RPC
        drift.get_user_stats(&swift_order.taker_authority), // always hits RPC
        drift.init_tx(&filler_subaccount, false)
    )
    .unwrap();

    // built the taker tx
    // It places the swift order for the taker and fills it
    let tx = tx_builder
        .place_and_make_swift_order(
            OrderParams {
                order_type: OrderType::Limit,
                market_index: taker_order.market_index,
                market_type: taker_order.market_type,
                direction: match taker_order.direction {
                    PositionDirection::Long => PositionDirection::Short,
                    PositionDirection::Short => PositionDirection::Long,
                },
                // TODO: fill at price depending on strategy params
                // this always attempts to fill at the best price for the _taker_
                price: taker_order
                    .auction_start_price
                    .expect("start price set")
                    .unsigned_abs(),
                // try fill the whole order amount
                base_asset_amount: taker_order.base_asset_amount,
                post_only: PostOnlyParam::MustPostOnly,
                bit_flags: OrderParams::IMMEDIATE_OR_CANCEL_FLAG,
                ..Default::default()
            },
            &swift_order,
            &taker_account_data,
            &taker_stats.referrer,
        )
        .build();

    match drift.sign_and_send(tx).await {
        Ok(sig) => {
            println!("sent fill: {sig}");
        }
        Err(err) => {
            println!("fill failed: {err}");
        }
    }
}
