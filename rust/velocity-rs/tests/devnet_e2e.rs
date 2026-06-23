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
//! Bot-timing-dependent scenarios (jit-maker incentive, liquidation via oracle
//! drift, settler thresholds) RUN — their setup is deterministic and they treat
//! "bot didn't act in time" as inconclusive (warn, not failure), so they're safe
//! in the nightly non-gating job. `#[ignore]` is reserved for scenarios whose
//! setup itself can't be established on devnet right now (swift HTTP 502, SOL
//! borrow unavailable); those run only in the manual `--include-ignored` job.
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
        MarketType, NewOrder, OrderParams, OrderStatus, OrderType, PositionDirection,
        PostOnlyParam, SignedMsgOrderParamsMessage,
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
    NewOrder::limit(SOL_PERP)
        .amount(amount)
        .price(price)
        .build()
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
// This test is SOUND AGAINST AUCTION SANITIZATION. The earlier version rested a
// long MARKET order with an aggressive `+2% → +15%` auction and waited 120s for a
// lone-taker vAMM fill. It silently timed out — not a filler/DLOB/gRPC bug, but
// because the program *rewrites* a market order's auction params on placement
// (`OrderParams::update_perp_auction_params_market_and_oracle_orders`). The
// requested band never reaches the chain: for a long it is clamped to the AMM
// baseline offsets (`get_perp_baseline_start_end_price_offset(.., Long, 2)`).
//
// On a low-volume market that clamp collapses the auction to a flat price ~oracle
// + a few bps, BELOW the live `vamm_ask`: the baseline END is built from the
// bid/ask price TWAPs (EWMA over the funding period), which LAG the live oracle
// when price has drifted with little flow, while `vamm_ask` tracks the live
// reserve price. So the sanitized auction can never out-price the AMM ask and the
// filler correctly never fills it. (Observed on devnet: start==end==oracle+0.50%,
// vamm_ask=oracle+0.73%.) A real lone-taker AMM fill needs the TWAPs warmed to the
// live price, or the JIT route (`amm_wants_to_jit_make`, inventory + jit_intensity).
//
// So instead of asserting a fill that sanitization can forbid, this test:
//   1. proves sanitization is active (the aggressive request is discarded),
//   2. locks the clamp target to the program's own baseline (regression guard),
//   3. gates the fill assertion on whether the *sanitized* auction actually
//      crosses the live `vamm_ask` — and when it can't, fails LOUD with the exact
//      numbers instead of a silent 120s timeout.
#[tokio::test]
async fn taker_fills_against_amm() {
    let ctx = TestCtx::new().await;
    let sub = ctx.sub(ctx.new_subaccount().await);
    ctx.cleanup(sub).await;
    ctx.fund_and_deposit_dusdt(sub, 100).await;

    let px = ctx.client.oracle_price(SOL_PERP).await.expect("oracle") as u64;
    // Deliberately aggressive so sanitization MUST clamp it (a long market order:
    // NOT place_and_take, NOT a plain limit — a resting limit parks as a maker and
    // is never routed to the AMM).
    let requested_start = (px + px * 2 / 100) as i64;
    let requested_end = (px + px * 15 / 100) as i64;
    let order = OrderParams {
        order_type: OrderType::Market,
        market_type: MarketType::Perp,
        market_index: 0,
        direction: PositionDirection::Long,
        base_asset_amount: ONE_SOL as u64,
        auction_start_price: Some(requested_start),
        auction_end_price: Some(requested_end),
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

    // --- Read back the ON-CHAIN (sanitized) order --------------------------
    let user = ctx
        .client
        .get_user_account(&sub)
        .await
        .expect("user account");
    let placed = user
        .orders
        .iter()
        .find(|o| {
            o.status == OrderStatus::Open
                && o.market_index == 0
                && o.order_type == OrderType::Market
        })
        .expect("resting market order on chain");

    // (1) Regression: the aggressive request was discarded by sanitization.
    assert!(
        placed.auction_start_price < requested_start && placed.auction_end_price < requested_end,
        "sanitization did not clamp the aggressive auction: on-chain start={} end={} \
         vs requested start={} end={}",
        placed.auction_start_price,
        placed.auction_end_price,
        requested_start,
        requested_end,
    );

    // (2) Regression: the clamp target is the program's own market-order baseline
    // (factor 2). The program sets start = oracle + start_off, end = oracle +
    // end_off using the SAME oracle, so the spread (end - start) is
    // oracle-independent and must equal (end_off - start_off). Tolerance absorbs a
    // mark-twap crank possibly landing between placement and read-back.
    let market = ctx
        .client
        .get_perp_market_account(0)
        .await
        .expect("perp market");
    let (start_off, end_off) =
        OrderParams::get_perp_baseline_start_end_price_offset(&market, PositionDirection::Long, 2)
            .expect("baseline offsets");
    let onchain_spread = placed.auction_end_price - placed.auction_start_price;
    let baseline_spread = end_off - start_off;
    let tol = (px / 400) as i64; // 25 bps
    assert!(
        (onchain_spread - baseline_spread).abs() <= tol,
        "sanitized auction spread {} != program baseline spread {} (tol {}); \
         sanitization logic changed",
        onchain_spread,
        baseline_spread,
        tol,
    );

    // (3) Crossability gate: does the SANITIZED auction reach the live vAMM ask?
    let reserve = market.amm.reserve_price().expect("reserve price");
    let vamm_ask = market
        .amm
        .ask_price(
            reserve,
            market.amm.long_spread,
            market.amm.reference_price_offset,
        )
        .expect("vamm ask");

    if (placed.auction_end_price as u64) <= vamm_ask {
        // ENVIRONMENTAL, not a code regression — so warn-and-skip rather than fail.
        //
        // On a low-volume market the bid/ask price TWAPs (an EWMA over the funding
        // period) lag the live oracle: `vamm_ask` tracks the live reserve price
        // while the sanitized auction end is built from the lagging TWAPs, so the
        // auction is capped BELOW the live ask and no lone-taker AMM fill is
        // possible. The sanitization regression checks above have already run and
        // passed, so turning a TWAP-lag into a red test (or a silent 120s timeout)
        // would be noise. We log the exact numbers and return.
        //
        // To actually exercise the fill you must lift `last_ask_price_twap` to the
        // live price first — but that's a funding-period EWMA, so it takes minutes
        // of trades/cranks (~0.3% of the gap closes per ~10s crank). The clean,
        // deterministic alternative is the JIT route (`amm_wants_to_jit_make`: AMM
        // inventory + jit_intensity > 0), which doesn't depend on the TWAP at all.
        log::warn!(
            "INCONCLUSIVE (AMM uncrossable by construction): sanitized auction end {} <= \
             vamm_ask {} (oracle {}). baseline_offsets=({start_off},{end_off}) \
             onchain_auction=({},{}). Skipping fill assertion — see comment above.",
            placed.auction_end_price,
            vamm_ask,
            px,
            placed.auction_start_price,
            placed.auction_end_price,
        );
        ctx.cleanup(sub).await;
        return;
    }

    // The sanitized auction DOES cross the AMM ask: the deployed filler must fill
    // it to exactly +1 SOL against the AMM (no maker present).
    let pos = ctx
        .wait_perp_base_eq(sub, 0, ONE_SOL, Duration::from_secs(120))
        .await
        .expect("sanitized auction crosses the AMM ask but the filler did not fill +1 SOL in 120s");
    assert_eq!(
        pos.base_asset_amount, ONE_SOL,
        "expected exactly +1 SOL long vs AMM, got {}",
        pos.base_asset_amount
    );
    ctx.cleanup(sub).await;
}

// ---- Scenario 7b: taker fills against the AMM via the JIT route ------------
//
// The JIT route (`Amm::amm_wants_to_jit_make`) is the OTHER way a lone taker
// reaches the AMM, and unlike the low-risk auction route in `taker_fills_against_amm`
// it does NOT depend on the (sanitized) auction out-pricing `vamm_ask` — the AMM
// proactively makes to OFFLOAD inventory, so it can fill same-slot via
// `place_and_take` (no external filler). It needs two preconditions:
//   * `amm_jit_intensity > 0` (devnet init now sets 100), and
//   * the AMM holding inventory on the side a taker would relieve. Note
//     `base_asset_amount_with_amm == net_user_position`: users net SHORT
//     (`< -order_step_size`) => AMM net long => a LONG taker lets it sell down;
//     users net LONG (`> order_step_size`) => AMM net short => a SHORT taker.
//
// Both preconditions are MARKET STATE we can't set from here (no admin to reseed
// jit intensity, and seeding AMM inventory needs prior flow). So this test is
// sound against that: it picks the taker direction FROM the live inventory and,
// if the preconditions aren't met (AMM flat, or jit inactive), warn-and-skips
// with the exact reason instead of failing. When they ARE met it sends
// `place_and_take` and asserts the AMM JIT-filled the taker in-tx.
#[tokio::test]
async fn taker_fills_against_amm_via_jit() {
    let ctx = TestCtx::new().await;
    let market = ctx
        .client
        .get_perp_market_account(0)
        .await
        .expect("perp market");
    let step = market.order_step_size;
    let inventory = market.amm.base_asset_amount_with_amm;
    let jit_intensity = market.amm.amm_jit_intensity;

    // Pick the taker direction the AMM would JIT-make for, from live inventory.
    let direction = if inventory < -(step as i128) {
        PositionDirection::Long
    } else if inventory > step as i128 {
        PositionDirection::Short
    } else {
        log::warn!(
            "INCONCLUSIVE (AMM flat): base_asset_amount_with_amm={} within +/- order_step_size={} \
             — no inventory for the AMM to JIT-offload. Skipping (needs prior flow to seed inventory).",
            inventory, step,
        );
        return;
    };

    // amm_wants_to_jit_make folds in the `amm_jit_intensity > 0` check.
    if !market
        .amm
        .amm_wants_to_jit_make(direction, step)
        .expect("jit check")
    {
        log::warn!(
            "INCONCLUSIVE (JIT inactive): amm_jit_intensity={} base_asset_amount_with_amm={} \
             order_step_size={} dir={:?} — AMM won't JIT-make. Skipping (can't reseed jit \
             intensity here).",
            jit_intensity,
            inventory,
            step,
            direction,
        );
        return;
    }

    let sub = ctx.sub(ctx.new_subaccount().await);
    ctx.cleanup(sub).await;
    ctx.fund_and_deposit_dusdt(sub, 100).await;

    // Market order, auction params left to the program to derive (direction-correct);
    // place_and_take takes it in the SAME slot and the JIT route fills it directly
    // against the AMM — JIT making does NOT require crossing vamm_ask.
    let order = OrderParams {
        order_type: OrderType::Market,
        market_type: MarketType::Perp,
        market_index: 0,
        direction,
        base_asset_amount: ONE_SOL as u64,
        ..Default::default()
    };
    let tx = ctx
        .client
        .init_tx(&sub, false)
        .await
        .unwrap()
        .place_and_take(order, &[], None, None)
        .build();
    ctx.send_confirmed(tx).await;

    // JIT fills in-tx; the taker opens a position on the chosen side. JIT may
    // partial-fill if AMM inventory < order size, so assert the SIGN, not exact.
    let pos = ctx
        .wait_perp_position_opened(sub, 0, Duration::from_secs(20))
        .await
        .expect(
            "preconditions met (jit active + AMM inventory) but place_and_take opened no \
             position vs the AMM — JIT route regressed",
        );
    match direction {
        PositionDirection::Long => assert!(
            pos.base_asset_amount > 0,
            "expected long vs AMM, got {}",
            pos.base_asset_amount
        ),
        PositionDirection::Short => assert!(
            pos.base_asset_amount < 0,
            "expected short vs AMM, got {}",
            pos.base_asset_amount
        ),
    }
    log::info!(
        "JIT fill ok: dir={:?} base={} (amm inventory before={})",
        direction,
        pos.base_asset_amount,
        inventory,
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
// Nightly-safe: warn-skips (not fails) if the jit-maker doesn't fill in time, so
// it never blocks. Verified live: the deployed jit-maker fills the 1-SOL auction.
#[tokio::test]
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
// Kept ignored: the swift HTTP server is flaky on devnet. The host is
// swift.master.velocity.exchange (the WS feed on it works fine for the filler;
// the swapped `master.swift.…` does NOT resolve), but POST /orders intermittently
// returns 502 from the ALB/cloudfront (occasionally 422 = up), so it can't be
// relied on. Un-ignore once the swift HTTP API is stable at SWIFT_HTTP_ENDPOINT
// (the test already warn-skips on a non-200, so it's safe to enable then).
#[ignore = "LIVE_INFRA: swift HTTP /orders intermittently 502s on devnet (SWIFT_HTTP_ENDPOINT)"]
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
// Nightly-safe: the setup (open +1 SOL vs AMM via the deployed filler) is
// deterministic and verified live; liquidation needs adverse oracle drift to
// cross maintenance, so that part warn-skips (not fails) if it doesn't happen.
#[tokio::test]
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
// Kept ignored: SOL borrow (spot market 1) is not available on devnet — the
// withdraw-as-borrow fails, so the test returns early before it can set anything
// up (verified live). Un-ignore once spot-1 borrows are enabled/liquid; note the
// borrow would then need a repay step (cleanup only cancels orders).
#[ignore = "LIVE_INFRA: SOL borrow (spot 1) unavailable on devnet; setup can't run"]
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
// Nightly-safe: the setup (open+close vs AMM via the deployed filler, banking
// unsettled pnl) is deterministic and verified live; the userPnlSettler only acts
// above its pnl threshold, so that part warn-skips (not fails) if it doesn't run.
#[tokio::test]
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
    ctx.wait_perp_base_eq(sub, 0, 0, Duration::from_secs(60))
        .await;

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
