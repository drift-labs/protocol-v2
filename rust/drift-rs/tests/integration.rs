use std::{str::FromStr, time::Duration};

use anchor_lang::Discriminator;
use drift_rs::{
    constants::DEFAULT_PUBKEY,
    event_subscriber::RpcClient,
    grpc::grpc_subscriber::AccountFilter,
    math::constants::{BASE_PRECISION_I64, LAMPORTS_PER_SOL_I64, PRICE_PRECISION_U64},
    types::{
        accounts::User, solana_sdk::clock::Slot, Context, MarketId, MarketType, NewOrder,
        OrderParams, OrderType, PositionDirection, PostOnlyParam, SettlePnlMode,
    },
    utils::test_envs::{devnet_endpoint, mainnet_endpoint, test_keypair},
    DriftClient, GrpcSubscribeOpts, Pubkey, TransactionBuilder, Wallet,
};
use futures_util::StreamExt;
use solana_keypair::Keypair;
use solana_rpc_client_api::config::RpcSimulateTransactionConfig;
use solana_signature::Signature;

#[tokio::test]
async fn client_sync_subscribe_all_devnet() {
    let client = DriftClient::new(
        Context::DevNet,
        RpcClient::new(devnet_endpoint()),
        Keypair::new().into(),
    )
    .await
    .expect("connects");

    tokio::try_join!(
        client.subscribe_all_markets(),
        client.subscribe_all_oracles(),
    )
    .expect("subscribes");
    let all_markets = client.get_all_market_ids();
    for market in all_markets {
        let price = client.oracle_price(market).await.expect("ok");
        assert!(price > 0);
        dbg!(market, price);
    }
}

#[tokio::test]
async fn client_sync_subscribe_devnet() {
    let _ = env_logger::try_init();
    let client = DriftClient::new(
        Context::DevNet,
        RpcClient::new(devnet_endpoint()),
        Keypair::new().into(),
    )
    .await
    .expect("connects");
    let markets = [
        MarketId::spot(1),
        MarketId::spot(2),
        MarketId::perp(0),
        MarketId::perp(1),
        MarketId::perp(2),
    ];
    tokio::try_join!(
        client.subscribe_markets(&markets),
        client.subscribe_oracles(&markets),
    )
    .expect("subscribes");

    let price = client.oracle_price(MarketId::perp(1)).await.expect("ok");
    assert!(price > 0);
    dbg!(price);
    let price = client.oracle_price(MarketId::spot(2)).await.expect("ok");
    assert!(price > 0);
    dbg!(price);
}

#[tokio::test]
async fn client_sync_subscribe_mainnet() {
    let _ = env_logger::try_init();
    let client = DriftClient::new(
        Context::MainNet,
        RpcClient::new(mainnet_endpoint()),
        Keypair::new().into(),
    )
    .await
    .expect("connects");
    let markets = [
        MarketId::spot(1),
        MarketId::spot(2),
        MarketId::perp(0),
        MarketId::perp(1),
        MarketId::perp(2),
        MarketId::perp(4),
        MarketId::spot(32),
    ];
    tokio::try_join!(
        client.subscribe_markets(&markets),
        client.subscribe_oracles(&markets),
    )
    .expect("subscribes");

    let price = client.oracle_price(MarketId::perp(1)).await.expect("ok");
    assert!(price > 0);
    dbg!(price);
    let price = client.oracle_price(MarketId::perp(4)).await.expect("ok");
    assert!(price > 0);
    dbg!(price);
    let price = client.oracle_price(MarketId::spot(32)).await.expect("ok");
    assert!(price > 0);
    dbg!(price);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 5)]
async fn client_sync_subscribe_mainnet_grpc() {
    let _ = env_logger::try_init();
    let client = DriftClient::new(
        Context::MainNet,
        RpcClient::new(mainnet_endpoint()),
        Keypair::new().into(),
    )
    .await
    .expect("connects");

    let (slot_update_tx, mut slot_update_rx) = tokio::sync::mpsc::channel::<Slot>(1);
    let (user_update_tx, mut user_update_rx) = tokio::sync::mpsc::channel::<Pubkey>(1);

    assert!(client
        .grpc_subscribe(
            "https://api.rpcpool.com".into(),
            std::env::var("TEST_GRPC_X_TOKEN").expect("TEST_GRPC_X_TOKEN set"),
            GrpcSubscribeOpts::default()
                .usermap_on()
                .on_slot(move |new_slot| {
                    println!("slot: {new_slot}");
                    let _ = slot_update_tx.try_send(new_slot);
                })
                .on_account(
                    AccountFilter::partial().with_discriminator(User::DISCRIMINATOR),
                    move |account| {
                        println!("account: {}", account.pubkey);
                        let _ = user_update_tx.try_send(account.pubkey);
                    }
                ),
            true,
        )
        .await
        .is_ok());

    // oracle map subscribed
    for market in client.get_all_spot_market_ids() {
        let rpc_fetched_price = client.oracle_price(market).await.unwrap();
        log::info!("fetching market: {market:?}");
        let x = client.try_get_oracle_price_data_and_slot(market).unwrap();
        assert!(x.data.price == rpc_fetched_price);
    }

    for market in client.get_all_perp_market_ids() {
        let rpc_fetched_price = client.oracle_price(market).await.unwrap();
        log::info!("fetching market: {market:?}");
        let x = client.try_get_oracle_price_data_and_slot(market).unwrap();
        assert!(x.data.price == rpc_fetched_price);
    }

    // wait for updates
    tokio::time::sleep(Duration::from_secs(4)).await;

    // markets available
    assert!(client.try_get_perp_market_account(0).is_ok());
    assert!(client.try_get_spot_market_account(1).is_ok());

    // slot update received
    assert!(slot_update_rx.try_recv().is_ok_and(|s| s > 0));

    // user update received
    assert!(user_update_rx.try_recv().is_ok_and(|u| u != DEFAULT_PUBKEY));

    client.grpc_unsubscribe();
}

#[tokio::test]
async fn place_and_cancel_orders() {
    let _ = env_logger::try_init();
    let btc_perp = MarketId::perp(1);
    let sol_spot = MarketId::spot(1);

    let wallet: Wallet = test_keypair().into();
    let client = DriftClient::new(
        Context::DevNet,
        RpcClient::new(devnet_endpoint()),
        wallet.clone(),
    )
    .await
    .expect("connects");

    let user: User = client
        .get_user_account(&wallet.default_sub_account())
        .await
        .expect("exists");
    let tx = TransactionBuilder::new(
        client.program_data(),
        wallet.default_sub_account(),
        std::borrow::Cow::Borrowed(&user),
        false,
    )
    .cancel_all_orders()
    .place_orders(vec![
        NewOrder::limit(btc_perp)
            .amount(1 * BASE_PRECISION_I64)
            .price(40 * PRICE_PRECISION_U64)
            .post_only(PostOnlyParam::MustPostOnly)
            .build(),
        NewOrder::limit(sol_spot)
            .amount(-1 * LAMPORTS_PER_SOL_I64)
            .price(400 * PRICE_PRECISION_U64)
            .post_only(PostOnlyParam::MustPostOnly)
            .build(),
    ])
    .cancel_orders(btc_perp.to_parts(), None)
    .cancel_orders(sol_spot.to_parts(), None)
    .build();

    dbg!(tx.clone());

    let result = client.sign_and_send(tx).await;
    dbg!(&result);
    assert!(result.is_ok());
}

#[ignore]
#[tokio::test]
async fn place_and_take() {
    let wallet: Wallet = test_keypair().into();
    let client = DriftClient::new(
        Context::DevNet,
        RpcClient::new(devnet_endpoint()),
        wallet.clone(),
    )
    .await
    .expect("connects");

    let sol_perp = client.market_lookup("sol-perp").expect("exists");

    let order = NewOrder::limit(sol_perp)
        .amount(1 * BASE_PRECISION_I64)
        .price(40 * PRICE_PRECISION_U64)
        .build();
    let tx = client
        .init_tx(&wallet.default_sub_account(), false)
        .await
        .unwrap()
        .place_and_take(order, &[], None, None)
        .build();

    let result = client.sign_and_send(tx).await;
    dbg!(&result);
    // TODO: add a place and make to match against
    assert!(result.is_err());
}

#[tokio::test]
async fn client_subscribe_swift_orders() {
    let _ = env_logger::try_init();
    let client = DriftClient::new(
        Context::DevNet,
        RpcClient::new(devnet_endpoint()),
        Keypair::new().into(),
    )
    .await
    .expect("connects");

    let all_markets = client.get_all_perp_market_ids();
    let mut order_stream = client
        .subscribe_swift_orders(all_markets.as_slice(), Some(true), Some(false), None)
        .await
        .unwrap();
    let mut recv_count = 0;
    while let Some(swift_order) = order_stream.next().await {
        if recv_count > 5 {
            break;
        }
        dbg!(swift_order.order_uuid());
        recv_count += 1;
    }
}

#[tokio::test]
async fn oracle_source_mixed_precision() {
    let _ = env_logger::try_init();
    let client = DriftClient::new(
        Context::MainNet,
        RpcClient::new(mainnet_endpoint()),
        Keypair::new().into(),
    )
    .await
    .expect("connects");

    let price = client
        .get_oracle_price_data_and_slot(MarketId::perp(4))
        .await
        .unwrap()
        .data
        .price;
    println!("Bonk: {price}");
    assert!(price % 100_000 > 0);

    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(client.subscribe_oracles(&[MarketId::perp(4)]).await.is_ok());

    let price = client
        .try_get_oracle_price_data_and_slot(MarketId::perp(4))
        .unwrap()
        .data
        .price;

    println!("Bonk: {price}");
    assert!(price % 100_000 > 0);
}

#[tokio::test]
async fn settle_pnl_txs() {
    let wallet = Wallet::read_only(
        "DxoRJ4f5XRMvXU9SGuM4ZziBFUxbhB3ubur5sVZEvue2"
            .parse()
            .unwrap(),
    );
    let client = DriftClient::new(
        Context::MainNet,
        RpcClient::new(mainnet_endpoint()),
        wallet.clone(),
    )
    .await
    .expect("connects");

    let doge_perp = client.market_lookup("doge-perp").expect("exists");

    let tx = client
        .init_tx(&wallet.default_sub_account(), false)
        .await
        .unwrap()
        .place_orders(vec![NewOrder::limit(doge_perp)
            .amount(50 * BASE_PRECISION_I64)
            .price(1000 * PRICE_PRECISION_U64)
            .post_only(PostOnlyParam::None)
            .build()])
        .settle_pnl(doge_perp.index(), None, None)
        .build();

    let result = client.simulate_tx(tx).await;
    dbg!(&result);
    assert!(result.is_ok_and(|x| x.err.is_none()));

    let sol_perp = client.market_lookup("sol-perp").expect("exists");
    let tx = client
        .init_tx(&wallet.default_sub_account(), false)
        .await
        .unwrap()
        .with_priority_fee(1, Some(2 * 200_000))
        .place_orders(vec![
            NewOrder::limit(doge_perp)
                .amount(50 * BASE_PRECISION_I64)
                .price(1000 * PRICE_PRECISION_U64)
                .post_only(PostOnlyParam::None)
                .build(),
            NewOrder::limit(sol_perp)
                .amount(-1 * BASE_PRECISION_I64)
                .price(10 * PRICE_PRECISION_U64)
                .post_only(PostOnlyParam::None)
                .build(),
        ])
        .settle_pnl_multi(
            &[sol_perp.index(), doge_perp.index()],
            SettlePnlMode::MustSettle,
            None,
            None,
        )
        .build();

    let result = client.simulate_tx(tx).await;
    dbg!(&result);
    assert!(result.is_ok_and(|x| x.err.is_none()));
}

#[ignore = "regression test"]
#[tokio::test]
async fn initialize_user_subaccount_0() {
    let _ = env_logger::try_init();
    let wallet: Wallet = test_keypair().into();
    let client = DriftClient::new(
        Context::MainNet,
        RpcClient::new(mainnet_endpoint()),
        wallet.clone(),
    )
    .await
    .expect("connects");

    let mut user = User::default();
    user.authority = *wallet.authority();

    let tx = TransactionBuilder::new(
        client.program_data(),
        wallet.default_sub_account(),
        std::borrow::Cow::Owned(user),
        false,
    )
    .initialize_user_account(0, None, None)
    .build();

    let result = client.simulate_tx(tx).await;
    dbg!(&result);
    assert!(result.is_ok_and(|x| x.err.is_none()));
}

#[tokio::test]
async fn place_order_sim_via_privy_account() {
    use drift_rs::utils::test_envs::mainnet_endpoint;
    use solana_commitment_config::CommitmentConfig;
    use solana_transaction::versioned::VersionedTransaction;

    let authority = Pubkey::from_str("GoHqm1MJ2JY7XoMtvedRNHBzUncY1uPaRJNeB1oAgQbQ").unwrap();
    let sub_account_pubkey = Wallet::derive_user_account(&authority, 0);

    let client = DriftClient::new(
        Context::MainNet,
        RpcClient::new(mainnet_endpoint()),
        Wallet::read_only(authority),
    )
    .await
    .expect("drift client");

    let user = client
        .get_user_account(&sub_account_pubkey)
        .await
        .expect("user account");

    let taker_order_params = OrderParams {
        order_type: drift_rs::types::OrderType::Oracle,
        market_type: drift_rs::types::MarketType::Perp,
        direction: drift_rs::types::PositionDirection::Long,
        base_asset_amount: 100000,
        price: 0,
        market_index: 1,
        post_only: drift_rs::types::PostOnlyParam::None,
        bit_flags: 0,
        oracle_price_offset: Some(62656166),
        auction_duration: Some(20),
        auction_start_price: Some(21469327),
        auction_end_price: Some(62656166),
        ..Default::default()
    };

    let isolated_deposit = Some(379918_u64);
    let market_index = taker_order_params.market_index;

    let message = TransactionBuilder::new(
        client.program_data(),
        sub_account_pubkey,
        std::borrow::Cow::Owned(user),
        false,
    )
    .transfer_isolated_perp_position_deposit(isolated_deposit.unwrap() as i64, market_index)
    .place_orders(vec![taker_order_params])
    .fee_payer(solana_pubkey::pubkey!(
        "4feEEMTPNnzwRiFeCNsogqXzHj3QyYowkYn4Y5BFv3rH" // some privy fee payer
    ))
    .build();

    let slot = client.get_slot().await.unwrap_or(0);
    let rpc = client.rpc();

    let sim_result = rpc
        .simulate_transaction_with_config(
            &VersionedTransaction {
                message,
                // two signers, authority & fee payer
                signatures: vec![Signature::new_unique(), Signature::new_unique()],
            },
            RpcSimulateTransactionConfig {
                sig_verify: false,
                replace_recent_blockhash: true,
                commitment: Some(CommitmentConfig::confirmed()),
                min_context_slot: Some(slot.saturating_sub(30)),
                ..Default::default()
            },
        )
        .await;

    match sim_result {
        Ok(response) => {
            eprintln!("=== Simulation Result ===");
            eprintln!("err: {:?}", response.value.err);
            eprintln!("logs:");
            if let Some(logs) = &response.value.logs {
                for log in logs {
                    eprintln!("  {log}");
                }
            }
            dbg!(&response);
            eprintln!("units consumed: {:?}", response.value.units_consumed);
        }
        Err(e) => {
            eprintln!("=== Simulation Failed ===");
            eprintln!("{e:#?}");
        }
    }
}
