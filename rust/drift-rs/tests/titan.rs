#![cfg(feature = "titan")]

use drift_rs::{
    event_subscriber::RpcClient,
    titan::{Provider, SwapMode, TitanSwapApi},
    types::{accounts::User, Context, MarketId},
    utils::test_envs::{mainnet_endpoint, mainnet_test_keypair},
    DriftClient, TransactionBuilder, Wallet,
};
use solana_transaction::{InstructionError, TransactionError};
use tokio::sync::OnceCell;

const DRIFT_CLIENT: OnceCell<DriftClient> = OnceCell::const_new();

async fn drift_client() -> DriftClient {
    DRIFT_CLIENT
        .get_or_init(|| async move {
            let wallet: Wallet = mainnet_test_keypair().into();
            DriftClient::new(
                Context::MainNet,
                RpcClient::new(mainnet_endpoint()),
                wallet.clone(),
            )
            .await
            .unwrap()
        })
        .await
        .clone()
}

#[tokio::test]
async fn titan_swap_exact_in_usdc_to_sol() {
    let _ = env_logger::try_init();
    let client = drift_client().await;
    let wallet = client.wallet();

    let token_in = MarketId::QUOTE_SPOT;
    let token_out = MarketId::spot(1);

    let user: User = client
        .get_user_account(&wallet.default_sub_account())
        .await
        .expect("exists");

    let titan_swap_info = client
        .titan_swap_query(
            wallet.authority(),
            10_000_000,
            None,
            SwapMode::ExactIn,
            100,
            token_in.index(),
            token_out.index(),
            Some(true),
            None,
            None,
        )
        .await
        .expect("got titan swap ixs");

    let in_market = client
        .program_data()
        .spot_market_config_by_index(token_in.index())
        .unwrap();
    let out_market = client
        .program_data()
        .spot_market_config_by_index(token_out.index())
        .unwrap();

    let in_token_account = Wallet::derive_associated_token_address(&wallet.authority(), &in_market);
    let out_token_account =
        Wallet::derive_associated_token_address(&wallet.authority(), &out_market);

    let tx = TransactionBuilder::new(
        client.program_data(),
        wallet.default_sub_account(),
        std::borrow::Cow::Borrowed(&user),
        false,
    )
    .titan_swap(
        titan_swap_info,
        &in_market,
        &out_market,
        &in_token_account,
        &out_token_account,
        None,
        None,
    )
    .build();

    let result = client.simulate_tx(tx).await;
    dbg!(&result);
    let err = result.expect("sim ok").err;
    match err {
        Some(err) => {
            assert_eq!(
                err,
                TransactionError::InstructionError(4, InstructionError::Custom(6157))
            )
        }
        None => assert!(true),
    }
}

#[tokio::test]
async fn titan_swap_exact_in_usdc_jto() {
    let _ = env_logger::try_init();
    let client = drift_client().await;
    let wallet = client.wallet();

    let token_in = MarketId::QUOTE_SPOT;
    let token_out = client.market_lookup("JTO").unwrap();

    let in_market = client
        .program_data()
        .spot_market_config_by_index(token_in.index())
        .unwrap();
    let out_market = client
        .program_data()
        .spot_market_config_by_index(token_out.index())
        .unwrap();

    let user: User = client
        .get_user_account(&wallet.default_sub_account())
        .await
        .expect("exists");

    let titan_swap_info = client
        .titan_swap_query(
            wallet.authority(),
            5 * 10_u64.pow(out_market.decimals),
            Some(50),
            SwapMode::ExactIn,
            100,
            token_in.index(),
            token_out.index(),
            Some(true),
            None,
            Some(Provider::Titan),
        )
        .await
        .expect("got titan swap ixs");

    let in_token_account = Wallet::derive_associated_token_address(&wallet.authority(), &in_market);
    let out_token_account =
        Wallet::derive_associated_token_address(&wallet.authority(), &out_market);

    let tx = TransactionBuilder::new(
        client.program_data(),
        wallet.default_sub_account(),
        std::borrow::Cow::Borrowed(&user),
        false,
    )
    .titan_swap(
        titan_swap_info,
        &in_market,
        &out_market,
        &in_token_account,
        &out_token_account,
        None,
        None,
    )
    .build();

    let result = client.simulate_tx(tx).await;
    dbg!(&result);
    let err = result.expect("sim ok").err;
    match err {
        Some(err) => {
            assert_eq!(
                err,
                TransactionError::InstructionError(4, InstructionError::Custom(6157))
            )
        }
        None => assert!(true),
    }
}
