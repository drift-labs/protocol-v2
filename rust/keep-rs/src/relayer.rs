//! Pyth Lazer oracle relayer
//!
//! Subscribes to Lazer price feeds for the configured perp (and optionally
//! spot) markets, and posts each price update on-chain via Drift's
//! `post_pyth_lazer_oracle_update` instruction.
use std::{
    borrow::Cow,
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use drift_rs::{
    types::{accounts::User, MarketId, RpcSendTransactionConfig},
    DriftClient, TransactionBuilder,
};

use crate::{Config, UseMarkets};

const TARGET: &str = "relayer";
const CU_LIMIT: u32 = 80_000;
const SUMMARY_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Stats {
    sent: AtomicU64,
    failed: AtomicU64,
    skipped_throttle: AtomicU64,
}

pub async fn run(config: Config, drift: DriftClient) {
    let perp_market_ids = match config.use_markets() {
        UseMarkets::All => drift.get_all_perp_market_ids(),
        UseMarkets::Subset(m) => m,
    };
    let spot_market_ids: Vec<MarketId> = if config.use_spot_liquidation {
        drift
            .program_data()
            .spot_market_configs()
            .iter()
            .map(|m| MarketId::spot(m.market_index))
            .collect()
    } else {
        Vec::new()
    };

    let min_interval = Duration::from_millis(config.relayer_min_interval_ms);
    let extra_feeds: Vec<u32> = config
        .relayer_extra_feeds
        .split(',')
        .filter_map(|s| s.trim().parse::<u32>().ok())
        .collect();
    log::info!(
        target: TARGET,
        "starting: perp_markets={} spot_markets={} extra_feeds={:?} min_interval={:?} dry={}",
        perp_market_ids.len(),
        spot_market_ids.len(),
        extra_feeds,
        min_interval,
        config.dry,
    );

    let pyth_access_token = std::env::var("PYTH_LAZER_TOKEN").expect("PYTH_LAZER_TOKEN set");
    let pyth_feed_cli = pyth_lazer_client::LazerClient::new(
        "wss://pyth-lazer.dourolabs.app/v1/stream",
        pyth_access_token.as_str(),
    )
    .expect("pyth lazer client connects");
    let mut feed = crate::util::subscribe_price_feeds(
        pyth_feed_cli,
        &perp_market_ids,
        &spot_market_ids,
        &extra_feeds,
    );

    drift
        .subscribe_blockhashes()
        .await
        .expect("subscribed blockhashes");

    let subaccount = drift.wallet.sub_account(config.sub_account_id);
    let user = drift
        .get_user_account(&subaccount)
        .await
        .expect("bot subaccount exists (run --init-user first)");

    let drift: &'static DriftClient = Box::leak(Box::new(drift));
    let user: &'static User = Box::leak(Box::new(user));
    let stats = Arc::new(Stats::default());

    log::info!(target: TARGET, "subaccount={subaccount} authority={}", drift.wallet.authority());

    {
        let stats = Arc::clone(&stats);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(SUMMARY_INTERVAL);
            interval.tick().await; // skip the immediate tick
            loop {
                interval.tick().await;
                log::info!(
                    target: TARGET,
                    "stats: sent={} failed={} throttled={}",
                    stats.sent.load(Ordering::Relaxed),
                    stats.failed.load(Ordering::Relaxed),
                    stats.skipped_throttle.load(Ordering::Relaxed),
                );
            }
        });
    }

    // Dedup + throttle: each pyth message can fan out to multiple market events,
    // and Lazer can stream sub-millisecond ticks. Cap to one tx per feed per
    // `min_interval`, and never re-send the same payload timestamp.
    let mut last_sent_ts: HashMap<u32, u64> = HashMap::new();
    let mut last_sent_at: HashMap<u32, Instant> = HashMap::new();

    while let Some(update) = feed.recv().await {
        let ts_us = update.ts.0;
        if last_sent_ts.get(&update.feed_id).copied() == Some(ts_us) {
            continue;
        }
        if let Some(prev) = last_sent_at.get(&update.feed_id) {
            if prev.elapsed() < min_interval {
                stats.skipped_throttle.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        }
        last_sent_ts.insert(update.feed_id, ts_us);
        last_sent_at.insert(update.feed_id, Instant::now());

        if config.dry {
            log::info!(
                target: TARGET,
                "[dry] feed={} mid={} type={:?} price={}",
                update.feed_id,
                update.market_id,
                update.market_type,
                update.price,
            );
            continue;
        }

        let tx =
            TransactionBuilder::new(drift.program_data(), subaccount, Cow::Borrowed(user), false)
                .with_priority_fee(config.priority_fee, Some(CU_LIMIT))
                .post_pyth_lazer_oracle_update(&[update.feed_id], &update.message)
                .build();

        let stats = Arc::clone(&stats);
        tokio::spawn(async move {
            let blockhash = match drift.get_latest_blockhash().await {
                Ok(b) => b,
                Err(e) => {
                    stats.failed.fetch_add(1, Ordering::Relaxed);
                    log::warn!(target: TARGET, "feed={} blockhash error: {e}", update.feed_id);
                    return;
                }
            };
            let signed = match drift.wallet().sign_tx(tx, blockhash) {
                Ok(t) => t,
                Err(e) => {
                    stats.failed.fetch_add(1, Ordering::Relaxed);
                    log::warn!(target: TARGET, "feed={} sign error: {e}", update.feed_id);
                    return;
                }
            };
            let cfg = RpcSendTransactionConfig {
                skip_preflight: true,
                max_retries: Some(0),
                ..Default::default()
            };
            match drift.rpc().send_transaction_with_config(&signed, cfg).await {
                Ok(sig) => {
                    stats.sent.fetch_add(1, Ordering::Relaxed);
                    log::info!(
                        target: TARGET,
                        "sent feed={} mid={} price={} sig={}",
                        update.feed_id,
                        update.market_id,
                        update.price,
                        sig,
                    );
                }
                Err(e) => {
                    stats.failed.fetch_add(1, Ordering::Relaxed);
                    log::warn!(target: TARGET, "send failed feed={}: {e}", update.feed_id);
                }
            }
        });
    }

    log::warn!(target: TARGET, "pyth feed channel closed; exiting relayer");
}

/// One-shot: initialize the bot's drift sub-account, then exit.
pub async fn init_user(config: Config, drift: DriftClient) {
    let subaccount = drift.wallet.sub_account(config.sub_account_id);
    if drift.get_user_account(&subaccount).await.is_ok() {
        log::info!(target: TARGET, "subaccount {subaccount} already exists; nothing to do");
        return;
    }

    log::info!(
        target: TARGET,
        "initializing subaccount id={} pubkey={}",
        config.sub_account_id,
        subaccount,
    );

    // TransactionBuilder reads authority from the User; set it to our wallet
    // so signing matches.
    let placeholder = User {
        authority: *drift.wallet.authority(),
        ..User::default()
    };
    let tx = TransactionBuilder::new(
        drift.program_data(),
        subaccount,
        Cow::Owned(placeholder),
        false,
    )
    .with_priority_fee(config.priority_fee, Some(200_000))
    .initialize_user_account(config.sub_account_id, None, None)
    .build();

    let blockhash = drift
        .get_latest_blockhash()
        .await
        .expect("fetched blockhash");
    let signed = drift.wallet().sign_tx(tx, blockhash).expect("signed tx");
    let cfg = RpcSendTransactionConfig {
        skip_preflight: false,
        ..Default::default()
    };
    match drift.rpc().send_transaction_with_config(&signed, cfg).await {
        Ok(sig) => log::info!(target: TARGET, "init user submitted: sig={sig}"),
        Err(e) => log::error!(target: TARGET, "init user failed: {e}"),
    }
}
