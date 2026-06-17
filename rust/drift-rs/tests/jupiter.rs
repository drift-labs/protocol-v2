use solana_transaction::{InstructionError, TransactionError};

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
use drift_rs::{
    event_subscriber::RpcClient,
    jupiter::{JupiterSwapApi, SwapMode},
    types::{accounts::User, Context, MarketId},
    utils::test_envs::{mainnet_endpoint, mainnet_test_keypair},
    DriftClient, TransactionBuilder, Wallet,
};
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
async fn jupiter_swap_exact_in_udsc_to_sol() {
    let _ = env_logger::try_init();
    let client = drift_client().await;
    let wallet = client.wallet();

    let token_in = MarketId::QUOTE_SPOT;
    let token_out = MarketId::spot(1);

    let user: User = client
        .get_user_account(&wallet.default_sub_account())
        .await
        .expect("exists");

    let jupiter_swap_info = client
        .jupiter_swap_query(
            wallet.authority(),
            10_000_000,
            SwapMode::ExactIn,
            10,
            token_in.index(),
            token_out.index(),
            Some(true),
            None,
            None,
        )
        .await
        .expect("got jup swap ixs");

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
    .jupiter_swap(
        jupiter_swap_info,
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
                TransactionError::InstructionError(4, InstructionError::Custom(6157)).into()
            )
        }
        None => assert!(true),
    }
}

#[tokio::test]
async fn jupiter_swap_exact_out_udsc_to_sol() {
    let _ = env_logger::try_init();
    let client = drift_client().await;
    let wallet = client.wallet();

    let token_in = MarketId::QUOTE_SPOT;
    let token_out = MarketId::spot(1);

    let user: User = client
        .get_user_account(&wallet.default_sub_account())
        .await
        .expect("exists");

    let jupiter_swap_info = client
        .jupiter_swap_query(
            wallet.authority(),
            LAMPORTS_PER_SOL / 10,
            SwapMode::ExactOut,
            10,
            token_in.index(),
            token_out.index(),
            Some(true),
            None,
            None,
        )
        .await
        .expect("got jup swap ixs");

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
    .jupiter_swap(
        jupiter_swap_info,
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
    // either swap OK or it would incur borrow which is fine (test account missing 'token in' amount)
    let err = result.expect("sim ok").err;
    match err {
        Some(err) => {
            assert_eq!(
                err,
                TransactionError::InstructionError(2, InstructionError::Custom(6157)).into()
            )
        }
        None => assert!(true),
    }
}

#[tokio::test]
async fn jupiter_swap_exact_out_udsc_jto() {
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

    let jupiter_swap_info = client
        .jupiter_swap_query(
            wallet.authority(),
            5 * 10_u64.pow(out_market.decimals),
            SwapMode::ExactOut,
            10,
            token_in.index(),
            token_out.index(),
            Some(true),
            None,
            None,
        )
        .await
        .expect("got jup swap ixs");

    let in_token_account = Wallet::derive_associated_token_address(&wallet.authority(), &in_market);
    let out_token_account =
        Wallet::derive_associated_token_address(&wallet.authority(), &out_market);

    let tx = TransactionBuilder::new(
        client.program_data(),
        wallet.default_sub_account(),
        std::borrow::Cow::Borrowed(&user),
        false,
    )
    .jupiter_swap(
        jupiter_swap_info,
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
    // either swap OK or it would incur borrow which is fine (test account missing 'token in' amount)
    match err {
        Some(err) => {
            assert_eq!(
                err,
                TransactionError::InstructionError(4, InstructionError::Custom(6157)).into()
            )
        }
        None => assert!(true),
    }
}

#[tokio::test]
async fn jupiter_swap_sol_unwrap() {
    let _ = env_logger::try_init();
    let client = drift_client().await;
    let wallet = client.wallet();

    let token_in = client.market_lookup("SOL").unwrap();
    let token_out = client.market_lookup("mSOL").unwrap();

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

    let jupiter_swap_info = client
        .jupiter_swap_query(
            wallet.authority(),
            LAMPORTS_PER_SOL / 10,
            SwapMode::ExactIn,
            10,
            token_in.index(),
            token_out.index(),
            Some(true),
            None,
            None,
        )
        .await
        .expect("got jup swap ixs");

    let in_token_account = Wallet::derive_associated_token_address(&wallet.authority(), &in_market);
    let out_token_account =
        Wallet::derive_associated_token_address(&wallet.authority(), &out_market);

    let tx = TransactionBuilder::new(
        client.program_data(),
        wallet.default_sub_account(),
        std::borrow::Cow::Borrowed(&user),
        false,
    )
    .jupiter_swap(
        jupiter_swap_info,
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
    // either swap OK or it would incur borrow which is fine (test account missing 'token in' amount)
    match err {
        Some(err) => {
            assert_eq!(
                err,
                TransactionError::InstructionError(4, InstructionError::Custom(6157)).into()
            )
        }
        None => assert!(true),
    }
}
