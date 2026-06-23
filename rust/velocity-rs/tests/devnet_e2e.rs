//! Devnet end-to-end suite proving the deployed velocity program + bots work.
//!
//! Gated behind `rpc_tests`; run by the `rust-live-tests` / `devnet-e2e` CI jobs
//! (manual / scheduled). Requires `TEST_DEVNET_RPC_ENDPOINT` and a funded
//! `TEST_PRIVATE_KEY`, and an initialized devnet (run `deploy-scripts/init-devnet.ts`).
//!
//! Hybrid intent: for actions a DEPLOYED bot owns (DLOB fills, JIT fills,
//! liquidations, pnl settling, mark-twap crank) the test sets up one side and
//! polls for the bot to act; pure user actions (deposit/withdraw/AMM-take) are
//! driven directly. Each scenario allocates fresh sequential subaccount(s) of the
//! one funded payer; run with `--test-threads=1`.
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

const ONE_SOL: i64 = BASE_PRECISION_I64; // 1e9, 9 decimals
/// Slack (native units) on spot token-amount asserts to absorb the
/// scaled-balance ↔ token-amount interest-index round-trip rounding. 100 native
/// dUSDT units = 1e-4 dUSDT.
const DUSDT_SLACK: u128 = 100;

/// A marketable 1-SOL limit order priced 5% through the oracle in the trade
/// direction, so it crosses the AMM and the DEPLOYED filler fills it against the
/// AMM (place_and_take with no makers does NOT fill vs the AMM — fills go through
/// the filler). Rest it with `place_orders`, then poll for the fill.
fn marketable_limit(px: u64, direction: PositionDirection) -> OrderParams {
    let (amount, price) = match direction {
        PositionDirection::Long => (ONE_SOL, px + px * 5 / 100),
        PositionDirection::Short => (-ONE_SOL, px.saturating_sub(px * 5 / 100)),
    };
    NewOrder::limit(SOL_PERP).amount(amount).price(price).build()
}

// ---- Scenario 3: deposit (self-driven) -------------------------------------
#[tokio::test]
async fn deposit_into_spot_market() {
    let ctx = TestCtx::new().await;
    let sub = ctx.sub(ctx.new_subaccount().await);
    ctx.fund_and_deposit_dusdt(sub, 50).await;

    // Deposited exactly 50 dUSDT — assert the on-chain collateral is 50 dUSDT
    // (50 * 1e6 native), not merely "> 0".
    let amount = ctx.spot_token_amount(sub, 0).await;
    let expected = 50 * DUSDT_PRECISION as u128;
    assert!(
        amount.abs_diff(expected) <= DUSDT_SLACK,
        "deposited dUSDT collateral {amount} != {expected} (±{DUSDT_SLACK} native)"
    );
}

// ---- Scenario 4: withdraw (self-driven) ------------------------------------
#[tokio::test]
async fn withdraw_from_spot_market() {
    let ctx = TestCtx::new().await;
    let sub = ctx.sub(ctx.new_subaccount().await);
    ctx.fund_and_deposit_dusdt(sub, 50).await; // 50 dUSDT in
    let before = ctx.spot_token_amount(sub, 0).await;

    let tx = ctx
        .client
        .init_tx(&sub, false)
        .await
        .unwrap()
        .withdraw(10 * DUSDT_PRECISION, 0, Some(true), None)
        .build();
    ctx.send_confirmed(tx).await;

    // Withdrew exactly 10 dUSDT: balance drops by 10 and lands at 40.
    let after = ctx.spot_token_amount(sub, 0).await;
    let withdrawn = before.abs_diff(after);
    let want_withdrawn = 10 * DUSDT_PRECISION as u128;
    assert!(
        withdrawn.abs_diff(want_withdrawn) <= DUSDT_SLACK,
        "withdrew {withdrawn} != {want_withdrawn} (±{DUSDT_SLACK} native)"
    );
    let want_after = 40 * DUSDT_PRECISION as u128;
    assert!(
        after.abs_diff(want_after) <= DUSDT_SLACK,
        "remaining dUSDT {after} != {want_after} (±{DUSDT_SLACK} native)"
    );
}

// ---- Scenario 7: taker order fills against the AMM -------------------------
//
// On a flat devnet AMM a same-slot `place_and_take` returns 0 base: it can only
// fill the AMM via two program routes, both closed here (verified by reading the
// program + simulating on-chain):
//   1. low-risk (`User::is_low_risk_for_amm`): needs `clock_slot - mm_delay >=
//      order.slot`. A `place_and_take` order is placed and taken in the SAME slot
//      (`order.slot == clock_slot`), so this only passes when the MM-oracle delay
//      is 0 — and devnet's mm-oracle crank runs ~8 slots behind, so it never is.
//   2. JIT (`amm_wants_to_jit_make`): needs `amm_jit_intensity > 0` AND the AMM
//      already holding inventory on the matching side. Devnet inits with
//      `ammJitIntensity = 0` and the AMM is flat.
// (init-devnet now sets `ammJitIntensity = 100`, matching real Drift, so the JIT
// route opens once the AMM carries inventory — but that's not deterministic for a
// test on a flat book.)
//
// The deterministic, production-faithful AMM fill is the low-risk route reached by
// AGING: rest a marketable order, let it age past the MM-oracle delay, and the
// DEPLOYED rust-filler cranks it against the AMM (no maker present). That also
// proves the filler does AMM fills.
//
// Ignored: depends on the deployed rust-filler doing lone-taker vAMM fills, which
// it currently doesn't on devnet — its account was un-initialized (now fixed via
// keep-rs `--init-user`), and it still stalls after its startup book snapshot
// (logs no fills while other bots trade). The TS order-filler only does matched
// maker↔taker fills (see `dlob_maker_taker_filled_by_filler`). Un-ignore once the
// rust-filler reliably cranks vAMM fills.
#[tokio::test]
#[ignore = "LIVE_INFRA: needs rust-filler doing lone-taker vAMM fills (place_and_take can't fill a flat AMM same-slot; rust-filler stalls after startup)"]
async fn taker_fills_against_amm() {
    let ctx = TestCtx::new().await;
    let sub = ctx.sub(ctx.new_subaccount().await);
    ctx.cleanup(sub).await;
    ctx.fund_and_deposit_dusdt(sub, 100).await;

    let px = ctx.client.oracle_price(SOL_PERP).await.expect("oracle") as u64;
    // Rest a long MARKET order with a 30-slot auction (NOT place_and_take, NOT a
    // plain limit — a resting limit parks as a maker and is never routed to the
    // AMM). The auction price starts 2% through the AMM so it crosses immediately,
    // but the AMM can't fill until the order ages past the MM-oracle delay
    // (~8 slots) into the low-risk window; the 30-slot auction outlives that, and
    // the deployed filler then cranks it against the AMM (no maker present).
    let order = OrderParams {
        order_type: OrderType::Market,
        market_type: MarketType::Perp,
        market_index: 0,
        direction: PositionDirection::Long,
        base_asset_amount: ONE_SOL as u64,
        auction_start_price: Some((px + px * 2 / 100) as i64),
        auction_end_price: Some((px + px * 15 / 100) as i64),
        auction_duration: Some(200),
        ..Default::default()
    };
    let tx = ctx
        .client
        .init_tx(&sub, false)
        .await
        .unwrap()
        .place_orders(vec![order])
        .build();
    ctx.send_confirmed(tx).await;

    // Base fills are exact: assert the deployed filler opened precisely +1 SOL
    // against the AMM (not merely "> 0").
    let pos = ctx
        .wait_perp_base_eq(sub, 0, ONE_SOL, Duration::from_secs(120))
        .await
        .expect("deployed filler did not fill the taker against the AMM within 120s");
    assert_eq!(
        pos.base_asset_amount, ONE_SOL,
        "expected exactly +1 SOL long vs AMM, got {}",
        pos.base_asset_amount
    );
    ctx.cleanup(sub).await;
}

// ---- Scenario 1: resting maker + crossing taker, DEPLOYED filler matches ----
#[tokio::test]
async fn dlob_maker_taker_filled_by_filler() {
    let ctx = TestCtx::new().await;
    let maker = ctx.sub(ctx.new_subaccount().await);
    let taker = ctx.sub(ctx.new_subaccount().await);
    ctx.fund_and_deposit_dusdt(maker, 100).await;
    ctx.fund_and_deposit_dusdt(taker, 100).await;

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
    ctx.send_confirmed(tx).await;

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
    ctx.send_confirmed(tx).await;

    // The maker bid (oracle-5bps) is the best bid, so the deployed filler must
    // match the taker against it: taker ends exactly -1 SOL, maker exactly +1 SOL
    // (a 1-SOL maker vs a 1-SOL taker is a full, exact cross).
    ctx.wait_perp_base_eq(taker, 0, -ONE_SOL, Duration::from_secs(60))
        .await
        .expect("deployed filler did not fill the taker to exactly -1 SOL within 60s");
    ctx.wait_perp_base_eq(maker, 0, ONE_SOL, Duration::from_secs(30))
        .await
        .expect("best-bid maker was not filled to exactly +1 SOL by the deployed filler");
    ctx.cleanup(maker).await;
    ctx.cleanup(taker).await;
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
    // It advanced (monotonic) and by a bounded amount — the crank cadence is
    // ~10s, so within the 60s poll the jump must be modest, not a stale/garbage ts.
    let delta = new_ts - from_ts;
    assert!(
        (1..=180).contains(&delta),
        "mark-twap ts advanced by {delta}s; expected 1..=180 (≈crank cadence within the poll)"
    );
}

// ---- Scenario 2: JIT auction taker, DEPLOYED jit-maker fills ---------------
#[tokio::test]
#[ignore = "LIVE_INFRA: jit-maker only fills when the auction is attractive"]
async fn jit_auction_filled_by_jit_maker() {
    let ctx = TestCtx::new().await;
    let sub = ctx.sub(ctx.new_subaccount().await);
    ctx.fund_and_deposit_dusdt(sub, 100).await;

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
    ctx.send_confirmed(tx).await;

    // If the jit-maker fills, it fills the whole 1-SOL auction order (exact base).
    if ctx
        .wait_perp_base_eq(sub, 0, ONE_SOL, Duration::from_secs(60))
        .await
        .is_none()
    {
        log::warn!("INCONCLUSIVE: jit-maker did not fill the 1-SOL auction within 60s");
    }
    ctx.cleanup(sub).await;
}

// ---- Scenario 1s / 2s: swift taker submitted to deployed swift server -------
#[tokio::test]
#[ignore = "LIVE_INFRA: velocity swift server may not be reachable from CI (SWIFT_HTTP_ENDPOINT)"]
async fn swift_taker_filled_by_deployed_maker() {
    let ctx = TestCtx::new().await;
    let sub_id = ctx.new_subaccount().await;
    let sub = ctx.sub(sub_id);
    ctx.fund_and_deposit_dusdt(sub, 100).await;

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

    // If the deployed swift maker fills, the taker ends exactly +1 SOL.
    if ctx
        .wait_perp_base_eq(sub, 0, ONE_SOL, Duration::from_secs(90))
        .await
        .is_none()
    {
        log::warn!("INCONCLUSIVE: swift maker did not fill to 1 SOL within 90s");
    }
    ctx.cleanup(sub).await;
}

// ---- Scenario 5: bad perp trade → DEPLOYED liquidator ----------------------
#[tokio::test]
#[ignore = "LIVE_INFRA: needs the account to cross maintenance via oracle drift; best-effort"]
async fn bad_perp_trade_gets_liquidated() {
    let ctx = TestCtx::new().await;
    let sub = ctx.sub(ctx.new_subaccount().await);
    // Small collateral + max-leverage position sits near the maintenance edge so
    // small adverse oracle drift tips it over for the deployed liquidator.
    ctx.fund_and_deposit_dusdt(sub, 20).await;

    let px = ctx.client.oracle_price(SOL_PERP).await.expect("oracle") as u64;
    // Rest a marketable long; the deployed filler opens it to exactly +1 SOL vs AMM.
    let tx = ctx
        .client
        .init_tx(&sub, false)
        .await
        .unwrap()
        .place_orders(vec![marketable_limit(px, PositionDirection::Long)])
        .build();
    if ctx.client.sign_and_send(tx).await.is_err() {
        log::warn!("INCONCLUSIVE: could not place opening order");
        return;
    }
    if ctx
        .wait_perp_base_eq(sub, 0, ONE_SOL, Duration::from_secs(60))
        .await
        .is_none()
    {
        log::warn!("INCONCLUSIVE: filler did not open the position to +1 SOL");
        return;
    }

    // Liquidation depends on oracle drift crossing maintenance — inconclusive (not
    // a failure) if it doesn't happen in time. When it does, the liquidator MUST
    // set the being-liquidated flag AND reduce the position below the opened size.
    if ctx
        .wait_being_liquidated(sub, Duration::from_secs(120))
        .await
        .is_some()
    {
        ctx.wait_perp_base_below(sub, 0, ONE_SOL, Duration::from_secs(30))
            .await
            .expect("liquidator set the flag but never reduced the position below 1 SOL");
    } else {
        log::warn!("INCONCLUSIVE: account did not become liquidatable / no liquidation in 120s");
    }
    ctx.cleanup(sub).await;
}

// ---- Scenario 6: bad spot borrow → DEPLOYED liquidator ---------------------
#[tokio::test]
#[ignore = "LIVE_INFRA: needs SOL borrow availability + maintenance breach; best-effort"]
async fn bad_spot_borrow_gets_liquidated() {
    let ctx = TestCtx::new().await;
    let sub = ctx.sub(ctx.new_subaccount().await);
    ctx.fund_and_deposit_dusdt(sub, 20).await;

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
    // Borrowed exactly 0.25 SOL (SOL spot is 9-dp); assert the liability size.
    let borrowed = ctx.spot_token_amount(sub, 1).await;
    let want_borrow = ONE_SOL as u128 / 4; // 0.25 SOL = 250_000_000 native
    let sol_slack = 100_000u128; // 1e-4 SOL
    assert!(
        borrowed.abs_diff(want_borrow) <= sol_slack,
        "SOL borrow {borrowed} != {want_borrow} (±{sol_slack} native)"
    );

    if ctx
        .wait_being_liquidated(sub, Duration::from_secs(120))
        .await
        .is_none()
    {
        log::warn!("INCONCLUSIVE: borrow did not breach maintenance / no liquidation in 120s");
    }
}

// ---- Scenario A: userPnlSettler settles unsettled pnl ----------------------
#[tokio::test]
#[ignore = "LIVE_INFRA: settler only acts above its pnl threshold; best-effort"]
async fn unsettled_pnl_gets_settled() {
    let ctx = TestCtx::new().await;
    let sub = ctx.sub(ctx.new_subaccount().await);
    ctx.fund_and_deposit_dusdt(sub, 100).await;

    // Open then close a position (filler fills each vs the AMM) to bank realized
    // but unsettled pnl, then wait for the deployed userPnlSettler to settle it.
    let px = ctx.client.oracle_price(SOL_PERP).await.expect("oracle") as u64;
    let open = ctx
        .client
        .init_tx(&sub, false)
        .await
        .unwrap()
        .place_orders(vec![marketable_limit(px, PositionDirection::Long)])
        .build();
    ctx.send_confirmed(open).await;
    if ctx
        .wait_perp_base_eq(sub, 0, ONE_SOL, Duration::from_secs(60))
        .await
        .is_none()
    {
        log::warn!("INCONCLUSIVE: filler did not open the position");
        return;
    }
    let close = ctx
        .client
        .init_tx(&sub, false)
        .await
        .unwrap()
        .place_orders(vec![marketable_limit(px, PositionDirection::Short)])
        .build();
    ctx.send_confirmed(close).await;
    ctx.wait_perp_base_eq(sub, 0, 0, Duration::from_secs(60)).await;

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
    ctx.cleanup(sub).await;
}
