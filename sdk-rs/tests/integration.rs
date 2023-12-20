use std::borrow::Cow;

use drift_program::math::constants::{LAMPORTS_PER_SOL_I64, QUOTE_PRECISION_U64};
use drift_sdk::{
    types::{Context, MarketId, NewOrder},
    DriftClient, RpcAccountProvider, TransactionBuilder, Wallet,
};

#[ignore]
#[tokio::test]
async fn do_the_thing() {
    let client = DriftClient::new(
        "https://api.devnet.solana.com",
        RpcAccountProvider::new("https://api.devnet.solana.com"),
    )
    .await
    .expect("connects");
    let wallet = Wallet::from_seed_bs58(
        "4ZT38mSeFhzzDRCMTMbwDp7VYWDqNfkvDR42Wv4Hu9cKzbZPJoVapQSrjLbs9aMPrpAMmN1cQinztnP2PzKVjzwX",
    );

    let context = Context::DevNet;
    let user_data = client
        .get_user_account(&wallet.default_sub_account())
        .await
        .expect("ok");

    let sol = MarketId::lookup(context, "sol-perp").expect("exists");
    let sol_spot = MarketId::lookup(context, "sol").expect("exists");

    let tx = TransactionBuilder::new(
        context,
        wallet.default_sub_account(),
        Cow::Borrowed(&user_data),
    )
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
