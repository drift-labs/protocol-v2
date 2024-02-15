use std::str::FromStr;

use drift_program::math::constants::{
    BASE_PRECISION_I64, LAMPORTS_PER_SOL_I64, PRICE_PRECISION_U64,
};
use drift_sdk::{
    types::{ComputeUnitParams, Context, MarketId, NewOrder},
    DriftClient, Pubkey, RpcAccountProvider, TransactionBuilder, Wallet,
};
use solana_sdk::{signature::Keypair, signer::Signer};
use spl_associated_token_account::get_associated_token_address;

#[tokio::test]
async fn get_oracle_prices() {
    let client = DriftClient::new(
        Context::DevNet,
        RpcAccountProvider::new("https://api.devnet.solana.com"),
        Keypair::new(),
        None,
        None,
        None
    )
    .await
    .expect("connects");
    let price = client.oracle_price(MarketId::perp(0)).await.expect("ok");
    assert!(price > 0);
    dbg!(price);
    let price = client.oracle_price(MarketId::spot(1)).await.expect("ok");
    assert!(price > 0);
    dbg!(price);
}

#[tokio::test]
async fn place_and_cancel_orders() {
    let client = DriftClient::new(
        Context::DevNet,
        RpcAccountProvider::new("https://api.devnet.solana.com"),
        Keypair::new(),
        None,
        None,
        None
    )
    .await
    .expect("connects");

    let wallet = Wallet::from_seed_bs58(
        "4ZT38mSeFhzzDRCMTMbwDp7VYWDqNfkvDR42Wv4Hu9cKzbZPJoVapQSrjLbs9aMPrpAMmN1cQinztnP2PzKVjzwX",
    );

    let sol_perp = client.market_lookup("sol-perp").expect("exists");
    let sol_spot = client.market_lookup("sol").expect("exists");

    let tx = client
        .init_tx(&wallet.default_sub_account(), false)
        .await
        .unwrap()
        .cancel_all_orders()
        .place_orders(vec![
            NewOrder::limit(sol_perp)
                .amount(-1 * BASE_PRECISION_I64)
                .price(200 * PRICE_PRECISION_U64)
                .post_only(drift_sdk::types::PostOnlyParam::MustPostOnly)
                .build(),
            NewOrder::limit(sol_spot)
                .amount(1 * LAMPORTS_PER_SOL_I64)
                .price(44 * PRICE_PRECISION_U64)
                .post_only(drift_sdk::types::PostOnlyParam::MustPostOnly)
                .build(),
        ])
        .cancel_all_orders()
        .build();

    dbg!(tx.clone());

    let result = client.sign_and_send(tx).await;
    dbg!(&result);
    assert!(result.is_ok());
}


// TransactionBuilder::delegated is not a function anywhere that I can find on GitHub or in here.
// #[tokio::test]
// async fn cancel_delegated() {
//     let client = DriftClient::new(
//         Context::DevNet,
//         RpcAccountProvider::new("https://api.devnet.solana.com"),
//         Keypair::new()
//     )
//     .await
//     .expect("connects");

//     let mut wallet = Wallet::from_seed_bs58(
//         "4ZT38mSeFhzzDRCMTMbwDp7VYWDqNfkvDR42Wv4Hu9cKzbZPJoVapQSrjLbs9aMPrpAMmN1cQinztnP2PzKVjzwX",
//     );
//     wallet.to_delegated(Pubkey::from_str("GiMXQkJXLVjScmQDkoLJShBJpTh9SDPvT2AZQq8NyEBf").unwrap());

//     let account_data = client
//         .get_user_account(&wallet.default_sub_account())
//         .await
//         .expect("ok");
//     let tx = TransactionBuilder::delegated(
//         client.program_data(),
//         wallet.default_sub_account(),
//         std::borrow::Cow::Borrowed(&account_data),
//     )
//     .cancel_all_orders()
//     .build();

//     let result = client.sign_and_send(&wallet, tx).await;
//     dbg!(&result);
//     assert!(result.is_ok());
// }
