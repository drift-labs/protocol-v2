use drift_program::math::constants::{LAMPORTS_PER_SOL_I64, QUOTE_PRECISION_U64};
use drift_sdk::{
    types::{Context, MarketId, NewOrder},
    DriftClient, TransactionBuilder, Wallet,
};

#[tokio::test]
async fn do_the_thing() {
    let client = DriftClient::new("https://api.devnet.solana.com")
        .await
        .expect("connects");
    let wallet = Wallet::from_seed_bs58(
        Context::Dev,
        "4ZT38mSeFhzzDRCMTMbwDp7VYWDqNfkvDR42Wv4Hu9cKzbZPJoVapQSrjLbs9aMPrpAMmN1cQinztnP2PzKVjzwX",
    );
    let orders = client.all_orders(&wallet).await.expect("ok");
    dbg!(orders);
    let positions = client.all_positions(&wallet).await.expect("ok");
    dbg!(positions);

    let user_data = client.get_account_data(&wallet).await.expect("ok");

    let sol = MarketId::lookup(Context::Dev, "sol-perp").expect("exists");
    let sol_spot = MarketId::lookup(Context::Dev, "sol").expect("exists");

    let tx = TransactionBuilder::new(&wallet, &user_data)
        .place_orders(vec![
            NewOrder::limit(sol)
                .amount(-1 * LAMPORTS_PER_SOL_I64)
                .price(100 * QUOTE_PRECISION_U64)
                .post_only(true)
                .build(),
            NewOrder::limit(sol_spot)
                .amount(1 * LAMPORTS_PER_SOL_I64)
                .price(22 * QUOTE_PRECISION_U64)
                .post_only(true)
                .build(),
        ])
        .cancel_all_orders()
        .build();
    let signature = client.sign_and_send(&wallet, tx).await;
    dbg!(signature);
}
