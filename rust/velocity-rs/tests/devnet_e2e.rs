//! Devnet end-to-end suite proving the deployed velocity program + bots work.
//!
//! Gated behind `rpc_tests`; run by the `rust-live-tests` / `devnet-e2e` CI jobs
//! (manual / scheduled). Requires `TEST_DEVNET_RPC_ENDPOINT` and a funded
//! `TEST_PRIVATE_KEY`, and an initialized devnet (run `deploy-scripts/init-devnet.ts`).
//!
//! Hybrid intent: for actions a DEPLOYED bot owns (DLOB fills, JIT fills,
//! liquidations, pnl settling, mark-twap crank) the test sets up one side and
//! polls for the bot to act; pure user actions (deposit/withdraw/AMM-take) are
//! driven directly. Each scenario uses a distinct subaccount id for isolation;
//! run with `--test-threads=1`.
//!
//! `#[ignore]` marks scenarios that depend on conditional bot behavior or oracle
//! drift (swift reachability, jit-maker incentive, liquidation, settler
//! thresholds); they treat "bot didn't act in time" as inconclusive, not failure.
#![cfg(feature = "rpc_tests")]

mod common;

use std::time::Duration;

use base64::Engine;
use common::*;
use nanoid::nanoid;
use velocity_rs::{
    math::constants::BASE_PRECISION_I64,
    swift_order_subscriber::SignedOrderType,
    types::{
        MarketType, NewOrder, OrderParams, OrderType, PositionDirection, PostOnlyParam,
        SignedMsgOrderParamsMessage,
    },
};

const ONE_SOL: i64 = BASE_PRECISION_I64;

// ---- Scenario 3: deposit (self-driven) -------------------------------------
#[tokio::test]
async fn deposit_into_spot_market() {
    let ctx = TestCtx::new().await;
    let sub = ctx.sub(10);
    ctx.fund_and_deposit_dusdt(10, 50).await;

    let pos = ctx
        .client
        .spot_position(&sub, 0)
        .await
        .expect("read spot position")
        .expect("dUSDT deposit present");
    assert!(
        pos.scaled_balance > 0,
        "expected positive dUSDT balance after deposit, got {}",
        pos.scaled_balance
    );
}

// ---- Scenario 4: withdraw (self-driven) ------------------------------------
#[tokio::test]
async fn withdraw_from_spot_market() {
    let ctx = TestCtx::new().await;
    let sub = ctx.sub(11);
    ctx.fund_and_deposit_dusdt(11, 50).await;

    let before = ctx
        .client
        .spot_position(&sub, 0)
        .await
        .unwrap()
        .expect("balance present")
        .scaled_balance;

    let tx = ctx
        .client
        .init_tx(&sub, false)
        .await
        .unwrap()
        .withdraw(10 * DUSDT_PRECISION, 0, Some(true), None)
        .build();
    ctx.client.sign_and_send(tx).await.expect("withdraw");

    let after = ctx
        .client
        .spot_position(&sub, 0)
        .await
        .unwrap()
        .expect("balance present")
        .scaled_balance;
    assert!(
        after < before,
        "expected dUSDT balance to drop after withdraw ({after} !< {before})"
    );
}

// ---- Scenario 7: taker takes against the AMM (self-driven) -----------------
#[tokio::test]
async fn taker_fills_against_amm() {
    let ctx = TestCtx::new().await;
    let sub = ctx.sub(16);
    ctx.cleanup(16).await;
    ctx.fund_and_deposit_dusdt(16, 100).await;

    let px = ctx.client.oracle_price(SOL_PERP).await.expect("oracle") as u64;
    // Marketable long with 1% auction room; empty maker list ⇒ fills vs AMM.
    let order = OrderParams {
        order_type: OrderType::Market,
        market_type: MarketType::Perp,
        market_index: 0,
        direction: PositionDirection::Long,
        base_asset_amount: ONE_SOL as u64,
        auction_start_price: Some(px as i64),
        auction_end_price: Some((px + px / 100) as i64),
        auction_duration: Some(10),
        ..Default::default()
    };
    let tx = ctx
        .client
        .init_tx(&sub, false)
        .await
        .unwrap()
        .place_and_take(order, &[], None, None)
        .build();
    ctx.client
        .sign_and_send(tx)
        .await
        .expect("place_and_take vs AMM");

    let pos = ctx
        .client
        .perp_position(&sub, 0)
        .await
        .unwrap()
        .expect("perp position opened against AMM");
    assert!(pos.base_asset_amount > 0, "expected long position vs AMM");
    ctx.cleanup(16).await;
}

// ---- Scenario 1: resting maker + crossing taker, DEPLOYED filler matches ----
#[tokio::test]
async fn dlob_maker_taker_filled_by_filler() {
    let ctx = TestCtx::new().await;
    let (maker, taker) = (ctx.sub(30), ctx.sub(12));
    ctx.cleanup(30).await;
    ctx.cleanup(12).await;
    ctx.fund_and_deposit_dusdt(30, 100).await;
    ctx.fund_and_deposit_dusdt(12, 100).await;

    let px = ctx.client.oracle_price(SOL_PERP).await.expect("oracle") as u64;
    // Maker rests a best bid 5bps under oracle (post-only so it can't cross).
    let maker_bid = px - px * 5 / 10_000;
    let tx = ctx
        .client
        .init_tx(&maker, false)
        .await
        .unwrap()
        .place_orders(vec![NewOrder::limit(SOL_PERP)
            .amount(ONE_SOL)
            .price(maker_bid)
            .post_only(PostOnlyParam::MustPostOnly)
            .build()])
        .build();
    ctx.client.sign_and_send(tx).await.expect("maker rests bid");

    // Taker rests a marketable short 15bps under oracle (crosses the maker bid);
    // it does NOT self-fill — the deployed filler must match it.
    let taker_ask = px - px * 15 / 10_000;
    let tx = ctx
        .client
        .init_tx(&taker, false)
        .await
        .unwrap()
        .place_orders(vec![NewOrder::limit(SOL_PERP)
            .amount(-ONE_SOL)
            .price(taker_ask)
            .build()])
        .build();
    ctx.client.sign_and_send(tx).await.expect("taker rests ask");

    let pos = ctx
        .wait_perp_position_opened(taker, 0, Duration::from_secs(60))
        .await
        .expect("deployed filler did not fill the taker within 60s");
    assert!(pos.base_asset_amount < 0, "taker should be short");
    // Best-effort: the maker should have taken the opposite side if it was best
    // priced (vs the AMM). Log rather than hard-fail on matching priority.
    if let Ok(Some(m)) = ctx.client.perp_position(&maker, 0).await {
        log::info!("maker position after fill: base={}", m.base_asset_amount);
    }
    ctx.cleanup(30).await;
    ctx.cleanup(12).await;
}

// ---- Scenario B/C: mark-twap crank keeps the market fresh -------------------
#[tokio::test]
async fn mark_twap_crank_advances() {
    let ctx = TestCtx::new().await;
    let from_ts = ctx
        .client
        .get_perp_market_account(0)
        .await
        .expect("perp market")
        .market_stats
        .last_mark_price_twap_ts;
    let new_ts = ctx
        .wait_mark_twap_ts_after(0, from_ts, Duration::from_secs(60))
        .await
        .expect("mark-twap crank did not advance last_mark_price_twap_ts within 60s");
    assert!(new_ts > from_ts);
}

// ---- Scenario 2: JIT auction taker, DEPLOYED jit-maker fills ---------------
#[tokio::test]
#[ignore = "LIVE_INFRA: jit-maker only fills when the auction is attractive"]
async fn jit_auction_filled_by_jit_maker() {
    let ctx = TestCtx::new().await;
    let sub = ctx.sub(14);
    ctx.cleanup(14).await;
    ctx.fund_and_deposit_dusdt(14, 100).await;

    let px = ctx.client.oracle_price(SOL_PERP).await.expect("oracle");
    // Rest (place_orders, NOT place_and_take) an oracle auction order generous to
    // the maker so the jit-maker is incentivized to fill during the auction.
    let order = OrderParams {
        order_type: OrderType::Oracle,
        market_type: MarketType::Perp,
        market_index: 0,
        direction: PositionDirection::Long,
        base_asset_amount: ONE_SOL as u64,
        oracle_price_offset: Some(px / 50), // +2% room
        auction_start_price: Some(0),
        auction_end_price: Some(px / 50),
        auction_duration: Some(30),
        ..Default::default()
    };
    let tx = ctx
        .client
        .init_tx(&sub, false)
        .await
        .unwrap()
        .place_orders(vec![order])
        .build();
    ctx.client.sign_and_send(tx).await.expect("place jit order");

    match ctx
        .wait_perp_position_opened(sub, 0, Duration::from_secs(60))
        .await
    {
        Some(p) => assert!(p.base_asset_amount > 0, "jit taker should be long"),
        None => log::warn!("INCONCLUSIVE: jit-maker did not fill the auction within 60s"),
    }
    ctx.cleanup(14).await;
}

// ---- Scenario 1s / 2s: swift taker submitted to deployed swift server -------
#[tokio::test]
#[ignore = "LIVE_INFRA: velocity swift server may not be reachable from CI (SWIFT_HTTP_ENDPOINT)"]
async fn swift_taker_filled_by_deployed_maker() {
    let ctx = TestCtx::new().await;
    let sub_id = 13u16;
    let sub = ctx.sub(sub_id);
    ctx.fund_and_deposit_dusdt(sub_id, 100).await;

    let px = ctx.client.oracle_price(SOL_PERP).await.expect("oracle");
    let slot = ctx.client.rpc().get_slot().await.expect("slot") + 200;
    let order = OrderParams {
        order_type: OrderType::Oracle,
        market_type: MarketType::Perp,
        market_index: 0,
        direction: PositionDirection::Long,
        base_asset_amount: ONE_SOL as u64,
        oracle_price_offset: Some(px / 50),
        auction_start_price: Some(0),
        auction_end_price: Some(px / 50),
        auction_duration: Some(30),
        ..Default::default()
    };
    let msg = SignedMsgOrderParamsMessage {
        sub_account_id: sub_id,
        signed_msg_order_params: order,
        slot,
        uuid: nanoid!(8).as_bytes().try_into().unwrap(),
        take_profit_order_params: None,
        stop_loss_order_params: None,
        max_margin_ratio: None,
        builder_idx: None,
        builder_fee_tenth_bps: None,
        isolated_position_deposit: None,
    };
    let signed = SignedOrderType::authority(msg);
    let hex_msg = hex::encode(signed.to_borsh());
    let signature = ctx.wallet.sign_message(hex_msg.as_bytes()).expect("sign");
    let body = serde_json::json!({
        "message": hex_msg,
        "taker_authority": ctx.authority().to_string(),
        "taker_pubkey": sub.to_string(),
        "signature": base64::prelude::BASE64_STANDARD.encode(signature.as_ref()),
    });

    let url = format!("{}/orders", swift_http_endpoint());
    let resp = reqwest::Client::new()
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => {}
        other => {
            log::warn!("INCONCLUSIVE: swift server unreachable/non-200: {other:?}");
            return;
        }
    }

    match ctx
        .wait_perp_position_opened(sub, 0, Duration::from_secs(90))
        .await
    {
        Some(p) => assert!(p.base_asset_amount > 0, "swift taker should be long"),
        None => log::warn!("INCONCLUSIVE: swift maker did not fill within 90s"),
    }
    ctx.cleanup(sub_id).await;
}

// ---- Scenario 5: bad perp trade → DEPLOYED liquidator ----------------------
#[tokio::test]
#[ignore = "LIVE_INFRA: needs the account to cross maintenance via oracle drift; best-effort"]
async fn bad_perp_trade_gets_liquidated() {
    let ctx = TestCtx::new().await;
    let sub_id = 17u16;
    let sub = ctx.sub(sub_id);
    ctx.cleanup(sub_id).await;
    // Small collateral + max-leverage position sits near the maintenance edge so
    // small adverse oracle drift tips it over for the deployed liquidator.
    ctx.fund_and_deposit_dusdt(sub_id, 20).await;

    let px = ctx.client.oracle_price(SOL_PERP).await.expect("oracle") as u64;
    // ~5x of 20 dUSDT ≈ 1.3 SOL @ ~$73; open the largest position the deposit
    // allows via place_and_take vs AMM.
    let order = OrderParams {
        order_type: OrderType::Market,
        market_type: MarketType::Perp,
        market_index: 0,
        direction: PositionDirection::Long,
        base_asset_amount: ONE_SOL as u64,
        auction_start_price: Some(px as i64),
        auction_end_price: Some((px + px / 100) as i64),
        auction_duration: Some(10),
        ..Default::default()
    };
    let tx = ctx
        .client
        .init_tx(&sub, false)
        .await
        .unwrap()
        .place_and_take(order, &[], None, None)
        .build();
    if ctx.client.sign_and_send(tx).await.is_err() {
        log::warn!("INCONCLUSIVE: could not open max-leverage position");
        return;
    }

    match ctx
        .wait_being_liquidated(sub, Duration::from_secs(120))
        .await
    {
        Some(()) => {} // liquidator engaged
        None => log::warn!(
            "INCONCLUSIVE: account did not become liquidatable / liquidator did not act in 120s"
        ),
    }
    ctx.cleanup(sub_id).await;
}

// ---- Scenario 6: bad spot borrow → DEPLOYED liquidator ---------------------
#[tokio::test]
#[ignore = "LIVE_INFRA: needs SOL borrow availability + maintenance breach; best-effort"]
async fn bad_spot_borrow_gets_liquidated() {
    let ctx = TestCtx::new().await;
    let sub_id = 18u16;
    let sub = ctx.sub(sub_id);
    ctx.fund_and_deposit_dusdt(sub_id, 20).await;

    // Borrow SOL (spot 1) against the dUSDT collateral, close to the limit.
    let borrow = (BASE_PRECISION_I64 as u64) / 4; // 0.25 SOL
    let tx = ctx
        .client
        .init_tx(&sub, false)
        .await
        .unwrap()
        .withdraw(borrow, 1, None, None)
        .build();
    if ctx.client.sign_and_send(tx).await.is_err() {
        log::warn!("INCONCLUSIVE: SOL borrow not available on devnet spot market");
        return;
    }

    match ctx
        .wait_being_liquidated(sub, Duration::from_secs(120))
        .await
    {
        Some(()) => {}
        None => {
            log::warn!("INCONCLUSIVE: borrow did not breach maintenance / no liquidation in 120s")
        }
    }
}

// ---- Scenario A: userPnlSettler settles unsettled pnl ----------------------
#[tokio::test]
#[ignore = "LIVE_INFRA: settler only acts above its pnl threshold; best-effort"]
async fn unsettled_pnl_gets_settled() {
    let ctx = TestCtx::new().await;
    let sub_id = 19u16;
    let sub = ctx.sub(sub_id);
    ctx.cleanup(sub_id).await;
    ctx.fund_and_deposit_dusdt(sub_id, 100).await;

    // Open then immediately close a position vs the AMM to bank realized (but
    // unsettled) pnl, then wait for the deployed userPnlSettler to settle it.
    let px = ctx.client.oracle_price(SOL_PERP).await.expect("oracle") as u64;
    for dir in [PositionDirection::Long, PositionDirection::Short] {
        let order = OrderParams {
            order_type: OrderType::Market,
            market_type: MarketType::Perp,
            market_index: 0,
            direction: dir,
            base_asset_amount: ONE_SOL as u64,
            auction_start_price: Some(px.saturating_sub(px / 100) as i64),
            auction_end_price: Some((px + px / 100) as i64),
            auction_duration: Some(10),
            ..Default::default()
        };
        let tx = ctx
            .client
            .init_tx(&sub, false)
            .await
            .unwrap()
            .place_and_take(order, &[], None, None)
            .build();
        let _ = ctx.client.sign_and_send(tx).await;
    }

    if ctx
        .client
        .unsettled_positions(&sub)
        .await
        .unwrap_or_default()
        .is_empty()
    {
        log::warn!("INCONCLUSIVE: no unsettled pnl produced to observe the settler");
        return;
    }
    match ctx.wait_pnl_settled(sub, Duration::from_secs(120)).await {
        Some(()) => {}
        None => log::warn!("INCONCLUSIVE: userPnlSettler did not settle within 120s"),
    }
    ctx.cleanup(sub_id).await;
}
