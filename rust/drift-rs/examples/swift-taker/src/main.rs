//! Example place swift taker order
use argh::FromArgs;
use base64::Engine;
use drift_rs::{
    swift_order_subscriber::{SignedOrderInfo, SignedOrderType},
    types::{MarketType, OrderParams, OrderType, PositionDirection, SignedMsgOrderParamsMessage},
    Context, DriftClient, RpcClient, TransactionBuilder, Wallet,
};
use nanoid::nanoid;
use reqwest::header;

/// Swift taker client example
#[derive(FromArgs)]
struct SwiftTakerArgs {
    /// make a depositTrade request
    #[argh(switch)]
    deposit_trade: bool,
    /// isolated position deposit amount
    #[argh(option)]
    isolated_position: Option<u64>,
}

#[tokio::main]
async fn main() {
    let _ = env_logger::init();
    let _ = dotenv::dotenv();
    let wallet: Wallet = drift_rs::utils::load_keypair_multi_format(
        &std::env::var("PRIVATE_KEY").expect("base58 PRIVATE_KEY set"),
    )
    .unwrap()
    .into();
    let args: SwiftTakerArgs = argh::from_env();

    let use_mainnet = std::env::var("MAINNET").is_ok();
    let context = if use_mainnet {
        drift_rs::types::Context::MainNet
    } else {
        drift_rs::types::Context::DevNet
    };
    let rpc_url =
        std::env::var("RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".to_string());
    let drift = DriftClient::new(context, RpcClient::new(rpc_url), wallet.clone())
        .await
        .expect("initialized client");

    let latest_slot = drift.rpc().get_slot().await.expect("get slot") + 200;

    let order_params = OrderParams {
        market_index: 0,
        market_type: MarketType::Perp,
        order_type: OrderType::Oracle,
        base_asset_amount: 100_000_000,
        direction: PositionDirection::Long,
        auction_start_price: Some(1_00),
        auction_end_price: Some(1_000),
        auction_duration: Some(20),
        ..Default::default()
    };
    let signed_order_params = SignedMsgOrderParamsMessage {
        sub_account_id: 0,
        signed_msg_order_params: order_params,
        slot: latest_slot,
        uuid: nanoid!(8).as_bytes().try_into().unwrap(),
        take_profit_order_params: None,
        stop_loss_order_params: None,
        max_margin_ratio: None,
        builder_idx: None,
        builder_fee_tenth_bps: None,
        isolated_position_deposit: args.isolated_position,
    };
    let swift_order_type = SignedOrderType::authority(signed_order_params);
    let signed_msg = hex::encode(swift_order_type.to_borsh());
    let signature = drift.wallet.sign_message(signed_msg.as_bytes()).unwrap();

    let swift_order_request = serde_json::json!({
        "message": signed_msg,
        "taker_authority": wallet.authority().to_string(),
        "taker_pubkey": wallet.default_sub_account().to_string(),
        "signature": base64::prelude::BASE64_STANDARD.encode(signature.as_ref()),
    });
    dbg!(&swift_order_request.to_string());

    if args.deposit_trade {
        let signed_order_info =
            SignedOrderInfo::authority(*drift.wallet.authority(), signed_order_params, signature);
        // SOL deposit, 0 = usdc, 1 = sol
        swift_deposit_trade(
            &drift,
            100_000_000,
            0,
            swift_order_request,
            signed_order_info,
        )
        .await;
    } else {
        swift_place_order(&drift, swift_order_request).await;
    }
}

async fn swift_place_order(drift: &DriftClient, swift_order_request: serde_json::Value) {
    println!("sending swift order: {swift_order_request:?}");
    let swift_url = if drift.context == Context::MainNet {
        "https://swift.drift.trade/orders"
    } else {
        "https://master.swift.drift.trade/orders"
    };
    let swift_cli = reqwest::Client::new();
    let req = swift_cli
        .post(swift_url)
        .header(header::CONTENT_TYPE, "application/json")
        .json(&swift_order_request)
        .build();
    dbg!(&req);
    let res = swift_cli.execute(req.unwrap()).await;
    dbg!(&res);
    let response = res.unwrap().text().await.unwrap();
    dbg!(response);
}

async fn swift_deposit_trade(
    drift: &DriftClient,
    deposit_amount: u64,
    deposit_market_index: u16,
    swift_order_request: serde_json::Value,
    signed_order_info: SignedOrderInfo,
) {
    println!("sending swift depositTrade order: {swift_order_request:?}, deposit amount: {deposit_amount}, market: {deposit_market_index}");
    let taker_subaccount = drift.wallet().default_sub_account();
    let taker_account_data = drift
        .get_user_account(&taker_subaccount)
        .await
        .expect("user account exists");

    let spot_market_config = drift
        .program_data()
        .spot_market_config_by_index(deposit_market_index)
        .unwrap();
    let create_ata_ix =
        spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            drift.wallet().authority(),
            drift.wallet().authority(),
            &spot_market_config.mint,
            &spot_market_config.token_program(),
        );

    let unsigned_tx = TransactionBuilder::new(
        drift.program_data(),
        taker_subaccount,
        std::borrow::Cow::Borrowed(&taker_account_data),
        false,
    )
    // .add_ix(additional_setup_ixs)
    .add_ix(create_ata_ix)
    .deposit(deposit_amount, deposit_market_index, None, None)
    .place_swift_order(&signed_order_info, &taker_account_data)
    // .add_ix(additional_clean_up_ixs)
    .build();
    let signed_tx = drift
        .wallet()
        .sign_tx(
            unsigned_tx.clone(),
            drift.get_latest_blockhash().await.unwrap(),
        )
        .unwrap();
    dbg!(&signed_tx.verify_with_results());
    dbg!(&signed_tx);

    let sim_res = drift.simulate_tx(unsigned_tx).await;
    dbg!(sim_res);

    let req = serde_json::json!({
        "deposit_tx": base64::prelude::BASE64_STANDARD.encode(
            bincode::serialize(&signed_tx).unwrap()
        ),
        "swift_order": swift_order_request,
    });

    let swift_url = if drift.context == Context::MainNet {
        "https://swift.drift.trade/depositTrade"
    } else {
        "https://master.swift.drift.trade/depositTrade"
    };
    let swift_cli = reqwest::Client::new();
    let req = swift_cli
        .post(swift_url)
        .header(header::CONTENT_TYPE, "application/json")
        .json(&req)
        .build();
    dbg!(&req);
    let res = swift_cli.execute(req.unwrap()).await;
    dbg!(&res);
    let response = res.unwrap().text().await.unwrap();
    dbg!(response);
}
