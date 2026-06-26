//! Shared harness for the devnet end-to-end suite (`tests/devnet_e2e.rs`).
//!
//! Gated behind `rpc_tests` so the offline PR gate never compiles it. Everything
//! here drives the LIVE velocity devnet deployment and asserts the DEPLOYED bots
//! act (hybrid intent): tests set up one side and poll on-chain state for the bot
//! to do its job; pure user actions (deposit/withdraw) are driven directly.
//!
//! Funding: all test subaccounts belong to the single `TEST_PRIVATE_KEY` payer
//! (devnet airdrop is unreliable); dUSDT comes from the token faucet.
#![cfg(feature = "rpc_tests")]
#![allow(dead_code)] // helpers are shared across test fns; not every binary uses all

use std::{
    borrow::Cow,
    time::{Duration, Instant},
};

use solana_instruction::{AccountMeta, Instruction};
use solana_message::VersionedMessage;
use solana_signature::Signature;
use velocity_rs::{
    event_subscriber::RpcClient,
    types::{
        accounts::User, Context, MarketId, NewOrder, PerpPosition, SpotMarketExt, SpotPosition,
    },
    utils::test_envs::{devnet_endpoint, test_keypair},
    Pubkey, TransactionBuilder, VelocityClient, Wallet,
};

/// Token faucet program that mints devnet dUSDT (`init-devnet.ts` default).
pub const FAUCET_PROGRAM_ID: Pubkey =
    solana_pubkey::pubkey!("V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB");
/// anchor `mint_to_user` discriminator (from token_faucet.json).
const MINT_TO_USER_DISCRIMINATOR: [u8; 8] = [75, 194, 44, 77, 10, 65, 232, 85];

/// Markets created by `init-devnet.ts`.
pub const SOL_PERP: MarketId = MarketId::perp(0);
pub const DUSDT_SPOT: MarketId = MarketId::spot(0); // quote (6 decimals)
pub const SOL_SPOT: MarketId = MarketId::spot(1);

pub const DUSDT_PRECISION: u64 = 1_000_000; // 6 decimals

/// Swift HTTP submission endpoint. Velocity's own swift server is in-cluster and
/// may not be publicly reachable from CI; override with `SWIFT_HTTP_ENDPOINT`.
pub fn swift_http_endpoint() -> String {
    std::env::var("SWIFT_HTTP_ENDPOINT")
        .unwrap_or_else(|_| "https://swift.master.velocity.exchange".to_string())
}

/// Shared devnet client + funded payer.
pub struct TestCtx {
    pub client: VelocityClient,
    pub wallet: Wallet,
}

impl TestCtx {
    /// Connect to devnet, load the funded `TEST_PRIVATE_KEY` payer, subscribe to
    /// the three devnet markets + their oracles.
    ///
    /// Missing/empty live-infra env is a hard failure (NOT a skip): a
    /// misconfigured CI run must be obvious. The explicit check just replaces the
    /// cryptic `test_keypair()` base58 panic with a legible message.
    pub async fn new() -> Self {
        let _ = env_logger::try_init();
        for var in ["TEST_PRIVATE_KEY", "TEST_DEVNET_RPC_ENDPOINT"] {
            assert!(
                std::env::var(var)
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false),
                "{var} must be set for the devnet e2e suite \
                 (funded TEST_PRIVATE_KEY + TEST_DEVNET_RPC_ENDPOINT)"
            );
        }
        let wallet: Wallet = test_keypair().into();
        let client = VelocityClient::new(
            Context::DevNet,
            RpcClient::new(devnet_endpoint()),
            wallet.clone(),
        )
        .await
        .expect("connect to devnet (TEST_DEVNET_RPC_ENDPOINT)");

        let markets = [DUSDT_SPOT, SOL_SPOT, SOL_PERP];
        tokio::try_join!(
            client.subscribe_markets(&markets),
            client.subscribe_oracles(&markets),
        )
        .expect("subscribe markets/oracles — is devnet initialized (run init-devnet.ts)?");

        let ctx = Self { client, wallet };
        ctx.assert_payer_funded().await;
        ctx
    }

    pub fn authority(&self) -> Pubkey {
        *self.wallet.authority()
    }

    /// Derive a subaccount PDA for the payer authority.
    pub fn sub(&self, sub_id: u16) -> Pubkey {
        Wallet::derive_user_account(self.wallet.authority(), sub_id)
    }

    /// Panic if the payer can't pay fees — the single most common LIVE_INFRA gap.
    pub async fn assert_payer_funded(&self) {
        let lamports = self
            .client
            .rpc()
            .get_balance(self.wallet.authority())
            .await
            .expect("get payer balance");
        assert!(
            lamports > 50_000_000, // 0.05 SOL
            "LIVE_INFRA: payer {} has {} lamports (<0.05 SOL); fund TEST_PRIVATE_KEY on devnet",
            self.authority(),
            lamports
        );
    }

    /// sign_and_send returns before the tx is confirmed, so reads (and the bots'
    /// view) can race ahead of it. Send, then wait for confirmation at the
    /// client's commitment so the next step sees a consistent chain.
    pub async fn send_confirmed(&self, tx: VersionedMessage) -> Signature {
        let sig = self.client.sign_and_send(tx).await.expect("send tx");
        for _ in 0..40 {
            if self
                .client
                .rpc()
                .confirm_transaction(&sig)
                .await
                .unwrap_or(false)
            {
                return sig;
            }
            tokio::time::sleep(Duration::from_millis(750)).await;
        }
        panic!("tx {sig} not confirmed in time");
    }

    /// Like [`Self::send_confirmed`] but never panics: returns `false` if the tx
    /// fails to send or isn't confirmed in time. For best-effort teardown where a
    /// reused account in a weird state must not abort the run.
    pub async fn send_confirmed_ok(&self, tx: VersionedMessage) -> bool {
        let Ok(sig) = self.client.sign_and_send(tx).await else {
            return false;
        };
        for _ in 0..40 {
            if self
                .client
                .rpc()
                .confirm_transaction(&sig)
                .await
                .unwrap_or(false)
            {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(750)).await;
        }
        false
    }

    /// Ensure a specific subaccount id exists (idempotent), provisioning sub 0 +
    /// UserStats first. Used by the one-shot `fund_mm_taker_subaccounts` to
    /// provision the deployed bots' subaccounts (MM=1, taker=2) under the filler
    /// authority. Tests use [`Self::acquire`] instead, which also resets state.
    ///
    /// NB: this only works for the next-sequential id after the existing ones (the
    /// program rejects a non-sequential id with `InvalidUserSubAccountId`); it does
    /// not bridge gaps. [`Self::ensure_sub_exists`] handles arbitrary ids.
    pub async fn ensure_subaccount(&self, sub_id: u16) {
        if sub_id != 0 {
            Box::pin(self.ensure_subaccount(0)).await;
        }
        let sub = self.sub(sub_id);
        if self.client.rpc().get_account(&sub).await.is_ok() {
            return;
        }
        let mut user = User::default();
        user.authority = self.authority();
        user.sub_account_id = sub_id;
        let tx = TransactionBuilder::new(self.client.program_data(), sub, Cow::Owned(user), false)
            .initialize_user_account(sub_id, None, None)
            .build();
        self.send_confirmed(tx).await;
    }

    /// Acquire a REUSABLE fixed-id subaccount, returning its PDA.
    ///
    /// Each test owns a stable `sub_id` (see the `SUB_*` constants in the suite)
    /// and reuses the SAME on-chain account every run instead of allocating a
    /// fresh one. Allocating fresh each run leaked ~10 `User` PDAs/run (~0.32 SOL
    /// rent locked) and marched `number_of_sub_accounts_created` (a monotonic u16)
    /// toward its 65_535 ceiling. Reuse bounds both.
    ///
    /// `acquire` (a) bootstraps the account — creating ids `0..=sub_id` in order
    /// if missing, since the program requires a new sub id to equal the live
    /// `number_of_sub_accounts_created` — and (b) resets it to a clean, empty,
    /// flat slate so the caller sees the same starting condition a brand-new
    /// account would give. Serial use only.
    pub async fn acquire(&self, sub_id: u16) -> Pubkey {
        self.ensure_sub_exists(sub_id).await;
        let sub = self.sub(sub_id);
        self.reset(sub).await;
        sub
    }

    /// Bootstrap subaccount `sub_id`, creating every missing id from the live
    /// `number_of_sub_accounts_created` up to `sub_id` in sequence (the program
    /// rejects a non-sequential id with `InvalidUserSubAccountId`). Creating sub 0
    /// also initializes UserStats. Idempotent: a no-op once the id exists.
    async fn ensure_sub_exists(&self, sub_id: u16) {
        if self
            .client
            .rpc()
            .get_account(&self.sub(sub_id))
            .await
            .is_ok()
        {
            return;
        }
        let mut next = match self.client.get_user_stats(&self.authority()).await {
            Ok(stats) => stats.number_of_sub_accounts_created,
            Err(_) => 0, // UserStats not created yet
        };
        while next <= sub_id {
            let id = next;
            if self.client.rpc().get_account(&self.sub(id)).await.is_err() {
                let mut user = User::default();
                user.authority = self.authority();
                user.sub_account_id = id;
                let tx = TransactionBuilder::new(
                    self.client.program_data(),
                    self.sub(id),
                    Cow::Owned(user),
                    false,
                )
                .initialize_user_account(id, None, None)
                .build();
                self.send_confirmed(tx).await;
            }
            next += 1;
        }
    }

    /// Reset a reused subaccount to empty & flat so the next test starts clean:
    /// cancel resting orders, close any perp position against the AMM (via the
    /// deployed filler), then withdraw all spot collateral. Best-effort — a flatten
    /// that can't complete is logged, not fatal (collateral asserts re-deposit from
    /// zero, and the per-test fill pollers re-establish the position they need).
    pub async fn reset(&self, sub: Pubkey) {
        // 1. cancel any resting orders.
        self.cleanup(sub).await;

        // 2. flatten a perp position on market 0: rest a reduce-only marketable
        //    order of the exact opposite size; the deployed filler closes it vs
        //    the AMM. Bounded wait, best-effort.
        if let Ok(Some(p)) = self.client.perp_position(&sub, 0).await {
            let base = p.base_asset_amount;
            if base != 0 {
                let px = self.client.oracle_price(SOL_PERP).await.unwrap_or(0) as u64;
                if px > 0 {
                    // buy (positive amount) to cover a short, sell (negative) to
                    // close a long; price 5% through the oracle so it's marketable.
                    let (amount, price) = if base < 0 {
                        (base.unsigned_abs() as i64, px + px * 5 / 100)
                    } else {
                        (-base, px.saturating_sub(px * 5 / 100))
                    };
                    if let Ok(builder) = self.client.init_tx(&sub, false).await {
                        let tx = builder
                            .place_orders(vec![NewOrder::limit(SOL_PERP)
                                .amount(amount)
                                .price(price)
                                .reduce_only(true)
                                .build()])
                            .build();
                        // Best-effort: submit the close (the deployed filler fills
                        // it vs the AMM) and poll until flat. Never panic — a reused
                        // account in a weird leftover state must not abort the run.
                        match self.client.sign_and_send(tx).await {
                            Ok(_) => {
                                if self
                                    .wait_perp_base_eq(sub, 0, 0, Duration::from_secs(60))
                                    .await
                                    .is_none()
                                {
                                    log::warn!(
                                        "reset: filler did not flatten {sub} (base was {base}) in 60s"
                                    );
                                }
                            }
                            Err(e) => log::warn!(
                                "reset: could not submit flatten order on {sub} (base {base}): {e:?}"
                            ),
                        }
                    }
                }
            }
        }

        // 3. drain spot collateral (dUSDT spot 0, SOL spot 1) as hygiene so a
        //    reused account doesn't accumulate balances run over run. reduce_only
        //    clamps to the available deposit, so it never opens a borrow.
        //    Best-effort — collateral asserts are delta-based, so a small residual
        //    (scaled-balance rounding) is harmless; never panic.
        for market_index in [0u16, 1u16] {
            let amount = self.spot_token_amount(sub, market_index).await;
            if amount > 0 {
                if let Ok(builder) = self.client.init_tx(&sub, false).await {
                    let tx = builder
                        .withdraw(amount as u64, market_index, Some(true), None)
                        .build();
                    // Confirm before returning so the caller's pre-op balance read
                    // sees the settled (drained) state — an unconfirmed drain would
                    // land mid-measurement and skew a delta assert.
                    self.send_confirmed_ok(tx).await;
                }
            }
        }
    }

    /// Mint `ui_amount` whole dUSDT to the payer ATA via the faucet and deposit it
    /// into `sub` — one confirmed tx.
    pub async fn fund_and_deposit_dusdt(&self, sub: Pubkey, ui_amount: u64) {
        let amount = ui_amount * DUSDT_PRECISION;
        let spot0 = self
            .client
            .program_data()
            .spot_market_config_by_index(0)
            .expect("dUSDT spot market");
        let mint = spot0.mint;
        let token_program = spot0.token_program();
        let owner = self.authority();
        let ata = spl_associated_token_account::get_associated_token_address(&owner, &mint);

        let create_ata =
            spl_associated_token_account::instruction::create_associated_token_account_idempotent(
                &owner,
                &owner,
                &mint,
                &token_program,
            );
        let faucet_ix = self.faucet_mint_ix(&mint, &ata, &token_program, amount);

        let tx = self
            .client
            .init_tx(&sub, false)
            .await
            .expect("load subaccount")
            .add_ix(create_ata)
            .add_ix(faucet_ix)
            .deposit(amount, 0, None, None)
            .build();
        self.send_confirmed(tx).await;
    }

    fn faucet_mint_ix(
        &self,
        mint: &Pubkey,
        user_ata: &Pubkey,
        token_program: &Pubkey,
        amount: u64,
    ) -> Instruction {
        let faucet_config =
            Pubkey::find_program_address(&[b"faucet_config", mint.as_ref()], &FAUCET_PROGRAM_ID).0;
        let mint_authority =
            Pubkey::find_program_address(&[b"mint_authority", mint.as_ref()], &FAUCET_PROGRAM_ID).0;
        let mut data = MINT_TO_USER_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        Instruction {
            program_id: FAUCET_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(faucet_config, false),
                AccountMeta::new(*mint, false),
                AccountMeta::new(*user_ata, false),
                AccountMeta::new_readonly(mint_authority, false),
                AccountMeta::new_readonly(*token_program, false),
            ],
            data,
        }
    }

    /// Best-effort: cancel any leftover orders on a subaccount. Call at start and
    /// end of each test so a crashed run doesn't poison the next.
    pub async fn cleanup(&self, sub: Pubkey) {
        if let Ok(builder) = self.client.init_tx(&sub, false).await {
            let tx = builder.cancel_all_orders().build();
            let _ = self.client.sign_and_send(tx).await;
        }
    }

    // ---- bot-liveness pollers (None == timed out) ----------------------------

    pub async fn wait_perp_position_opened(
        &self,
        sub: Pubkey,
        market_index: u16,
        timeout: Duration,
    ) -> Option<PerpPosition> {
        self.poll(timeout, || async {
            self.client
                .perp_position(&sub, market_index)
                .await
                .ok()
                .flatten()
                .filter(|p| p.base_asset_amount != 0)
        })
        .await
    }

    /// Wait until the perp base equals `expected` exactly — the bot filled
    /// precisely the requested size (base fills are exact; only quote varies).
    pub async fn wait_perp_base_eq(
        &self,
        sub: Pubkey,
        market_index: u16,
        expected: i64,
        timeout: Duration,
    ) -> Option<PerpPosition> {
        self.poll(timeout, || async {
            self.client
                .perp_position(&sub, market_index)
                .await
                .ok()
                .flatten()
                .filter(|p| p.base_asset_amount == expected)
        })
        .await
    }

    /// Exact token amount in native units (6-dp dUSDT, 9-dp SOL) held in a spot
    /// market — scaled balance converted via the market's interest index. 0 when
    /// the position is absent.
    pub async fn spot_token_amount(&self, sub: Pubkey, market_index: u16) -> u128 {
        let market = self
            .client
            .get_spot_market_account(market_index)
            .await
            .expect("spot market");
        match self.client.spot_position(&sub, market_index).await {
            Ok(Some(p)) => p.get_token_amount(&market).expect("token amount"),
            _ => 0,
        }
    }

    pub async fn wait_perp_base_below(
        &self,
        sub: Pubkey,
        market_index: u16,
        threshold_abs: i64,
        timeout: Duration,
    ) -> Option<PerpPosition> {
        self.poll(timeout, || async {
            self.client
                .perp_position(&sub, market_index)
                .await
                .ok()
                .flatten()
                .filter(|p| p.base_asset_amount.unsigned_abs() < threshold_abs.unsigned_abs())
        })
        .await
    }

    pub async fn wait_spot_position(
        &self,
        sub: Pubkey,
        market_index: u16,
        timeout: Duration,
    ) -> Option<SpotPosition> {
        self.poll(timeout, || async {
            self.client
                .spot_position(&sub, market_index)
                .await
                .ok()
                .flatten()
        })
        .await
    }

    /// Wait until the user is flagged being-liquidated OR the position shrinks.
    pub async fn wait_being_liquidated(&self, sub: Pubkey, timeout: Duration) -> Option<()> {
        self.poll(timeout, || async {
            self.client
                .get_user_account(&sub)
                .await
                .ok()
                .filter(|u| u.is_being_liquidated() || u.is_bankrupt())
                .map(|_| ())
        })
        .await
    }

    /// Wait until the subaccount has no unsettled perp pnl left (settler ran).
    pub async fn wait_pnl_settled(&self, sub: Pubkey, timeout: Duration) -> Option<()> {
        self.poll(timeout, || async {
            self.client
                .unsettled_positions(&sub)
                .await
                .ok()
                .filter(|v| v.is_empty())
                .map(|_| ())
        })
        .await
    }

    /// Wait until the perp market's mark-twap timestamp advances past `from_ts`
    /// (proves the mark-twap crank is alive). Returns the new ts.
    pub async fn wait_mark_twap_ts_after(
        &self,
        market_index: u16,
        from_ts: i64,
        timeout: Duration,
    ) -> Option<i64> {
        self.poll(timeout, || async {
            self.client
                .get_perp_market_account(market_index)
                .await
                .ok()
                .map(|m| m.market_stats.last_mark_price_twap_ts)
                .filter(|ts| *ts > from_ts)
        })
        .await
    }

    async fn poll<T, F, Fut>(&self, timeout: Duration, mut f: F) -> Option<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Option<T>>,
    {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(v) = f().await {
                return Some(v);
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}
