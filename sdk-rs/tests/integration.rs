use drift_program::math::constants::{
    BASE_PRECISION_I64, LAMPORTS_PER_SOL_I64, PRICE_PRECISION_U64, QUOTE_PRECISION_U64,
};
use drift_sdk::{
    types::{Context, NewOrder},
    DriftClient, RpcAccountProvider, Wallet,
};

#[tokio::test]
async fn place_and_cancel_orders() {
    let client = DriftClient::new(
        Context::DevNet,
        "https://api.devnet.solana.com",
        RpcAccountProvider::new("https://api.devnet.solana.com"),
    )
    .await
    .expect("connects");

    let wallet = Wallet::from_seed_bs58(
        "4ZT38mSeFhzzDRCMTMbwDp7VYWDqNfkvDR42Wv4Hu9cKzbZPJoVapQSrjLbs9aMPrpAMmN1cQinztnP2PzKVjzwX",
    );

    let sol_perp = client.market_lookup("sol-perp").expect("exists");
    let sol_spot = client.market_lookup("sol").expect("exists");

    let tx = client
        .init_tx(&wallet.default_sub_account())
        .await
        .unwrap()
        .cancel_all_orders()
        .place_orders(vec![
            NewOrder::limit(sol_perp)
                .amount(-1 * BASE_PRECISION_I64)
                .price(200 * PRICE_PRECISION_U64)
                .post_only(true)
                .build(),
            NewOrder::limit(sol_spot)
                .amount(1 * LAMPORTS_PER_SOL_I64)
                .price(44 * PRICE_PRECISION_U64)
                .post_only(true)
                .build(),
        ])
        .cancel_all_orders()
        .build();

    let result = client.sign_and_send(&wallet, tx).await;
    dbg!(&result);
    assert!(result.is_ok());
}
