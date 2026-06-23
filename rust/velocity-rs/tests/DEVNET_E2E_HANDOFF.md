# Devnet E2E — CI reliability & orchestration handoff

Status for `tests/devnet_e2e.rs` (gated `--features rpc_tests`). This doc explains
**which scenarios are deterministic, which depend on uncontrollable market/infra
state, and exactly what it would take to make each of the latter deterministic.**

It supersedes the earlier "taker-vs-AMM" handoff: that investigation is resolved
(see "Root cause" below) — the blocker was **auction sanitization + TWAP lag**, NOT
the rust-filler. Two earlier hypotheses are now **refuted**:

- ~~(A) the rust-filler's DLOB doesn't update from gRPC streaming~~ — FALSE. Run
  locally in dry-run, the filler streams `User` accounts over Helius LaserStream
  gRPC and the DLOB sees resting limit makers AND a lone taker auction order
  (`taker_bids=1, kind=Market`) within a slot of placement.
- ~~(B) `find_crosses_for_auctions` needs resting makers to produce a lone-taker
  vAMM cross~~ — FALSE. `MakerCrosses::is_empty()` is `orders.is_empty() &&
  !has_vamm_cross`, so a lone taker with `has_vamm_cross` is kept.

## How to run

```bash
cd rust
set -a && . ./keep-rs/.env && set +a            # BOT_PRIVATE_KEY etc.
export TEST_PRIVATE_KEY="$BOT_PRIVATE_KEY" TEST_DEVNET_RPC_ENDPOINT="$RPC_URL"
# nightly path (non-ignored only):
cargo test -p velocity-rs --test devnet_e2e --features rpc_tests -- --test-threads=1 --nocapture
# full path (also the #[ignore]'d scenarios):
cargo test -p velocity-rs --test devnet_e2e --features rpc_tests -- --include-ignored --test-threads=1 --nocapture
```

Devnet: program `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P`. Markets: SOL-PERP =
perp 0, dUSDT = spot 0 (6dp), SOL = spot 1 (9dp).

## CI topology (why "unreliable" matters per job)

- **`rust-live-tests`** (`.github/workflows/main.yml`) — nightly cron + manual
  dispatch; runs `--features rpc_tests` **without** `--include-ignored`. So it runs
  every **non-`#[ignore]`** test. Non-gating: never blocks PRs.
- **`devnet-e2e`** — manual dispatch only; runs the devnet suite **with**
  `--include-ignored` (everything).
- PRs run neither. The suite only has a funded **`TEST_PRIVATE_KEY`** (a normal
  user, **not** the program admin and **not** an oracle authority), so a CI run
  **cannot set any market/admin/oracle state**. That single fact is the root of
  every "unreliable" scenario below.

## The design contract

Every scenario whose *outcome* depends on a deployed bot or on market state we
can't set is written to be **sound, not flaky**: it asserts the parts it CAN
control (the setup, and any program-level invariant) and treats "the bot/market
didn't cooperate in time" as **`log::warn!("INCONCLUSIVE…")` + pass**, never a hard
failure or a silent multi-minute timeout. So in CI these scenarios are *green but
may verify only their setup* on a given night — read the logs, don't trust a bare
"ok".

`#[ignore]` is reserved for the stricter case where the **setup itself cannot be
established on devnet right now** (so the test can't even reach its warn-skip).

## Reliable scenarios (deterministic — trust these)

| Test | Why deterministic |
|---|---|
| `deposit_into_spot_market` | pure user action; exact balance assert |
| `withdraw_from_spot_market` | pure user action; exact balance assert |
| `dlob_maker_taker_filled_by_filler` | matched maker↔taker; deployed filler reliably matches crossing limit orders (the limit path, unlike a market-order auction, is not sanitized out — see Root cause) |
| `mark_twap_crank_advances` | the mark-twap crank runs ~every 10s; asserts a bounded ts advance |
| `taker_fills_against_amm` (the **assertions**) | the sanitization regression locks always run and are deterministic; only the *fill* is gated (next table) |

## Unreliable scenarios — what each depends on and how to orchestrate it

All of these need market/admin/oracle/bot state a `TEST_PRIVATE_KEY`-only CI run
can't set. "Orchestrate" = what it would take to make the outcome deterministic.

### 1. `taker_fills_against_amm` — *the fill* (lone taker vs AMM, low-risk auction route)
- **Depends on:** the **sanitized** auction price out-pricing the live `vamm_ask`.
- **Why uncontrollable:** a market order's auction params are rewritten on
  placement (`update_perp_auction_params_market_and_oracle_orders`), clamped to
  `get_perp_baseline_start_end_price_offset(market, dir, 2)`. The baseline END is
  built from the **bid/ask price TWAPs**, an EWMA over the ~1h funding period
  (`calculate_new_twap`). On a low-volume devnet those TWAPs **lag the live
  oracle**, while `vamm_ask` tracks the **live** reserve price → sanitized end
  (~oracle+0.5%) sits *below* `vamm_ask` (~oracle+0.73%), so the cross never
  happens. (Observed: `start==end==oracle+0.50%`, `vamm_ask=oracle+0.73%`.)
- **To orchestrate (any one):**
  1. **Warm the TWAPs** to the live price first — loop matched maker↔taker fills
     (the reliable `dlob_maker_taker_filled_by_filler` path) at ~oracle. Slow: the
     EWMA closes only ~0.3% of the gap per ~10s crank, so ~5–7 min of sustained
     flow. Non-deterministic on a quiet night.
  2. **Admin reset** `last_bid_price_twap` / `last_ask_price_twap` to oracle
     (admin path exists, `instructions/admin.rs`) — instant, needs the **admin key**.
  3. **Admin shrink** `amm.long_spread` so `vamm_ask` drops below the sanitized end
     — needs the admin key.
- Today the test gates on `sanitized_end > vamm_ask`; if false it warn-skips with
  the exact numbers (no 120s timeout).

### 2. `taker_fills_against_amm_via_jit` — lone taker vs AMM, JIT route
- **Depends on:** `amm_jit_intensity > 0` **and** the AMM holding inventory on the
  side a taker would relieve: `base_asset_amount_with_amm` (== net user position)
  beyond `±order_step_size`.
- **Why uncontrollable:** `jit_intensity` is set by init-devnet (currently 100),
  but the AMM is **flat** (`base_asset_amount_with_amm == 0`) with no flow, so
  there's nothing to JIT-offload. Seeding inventory needs prior taker flow against
  the AMM — which is itself gated (see #1) — i.e. a chicken-and-egg.
- **To orchestrate (any one):**
  1. **Admin-set** `base_asset_amount_with_amm` (or run a quoter + sustained flow
     to build it) so the AMM is net long/short past `order_step_size`.
  2. Have a **second-authority** account open a position the AMM must take (needs a
     non-`TEST_PRIVATE_KEY` funded key to avoid the duplicate-`UserStats` issue).
- Today the test reads live inventory, picks the direction the AMM would offload,
  fills via `place_and_take` in-tx; warn-skips when the AMM is flat or jit off.

### 3. `jit_auction_filled_by_jit_maker` — deployed jit-maker fills an auction
- **Depends on:** a **deployed jit-maker bot being up and economically
  incentivized** by the auction. Observed flaky: filled on one run, not on the next.
- **Why uncontrollable:** external bot liveness + its own profitability gate; CI
  can't guarantee either.
- **To orchestrate:** run a **test-pinned maker** instead of relying on the
  ambient one — from a second authority, `place_and_make` against the resting
  auction so the fill is deterministic. (Turns it from "observe the prod bot" into
  "controlled maker fills".)

### 4. `bad_perp_trade_gets_liquidated` — deployed liquidator
- **Depends on:** adverse **oracle drift** moving SOL enough to push the position
  past maintenance within the timeout, **and** a running liquidator.
- **Why uncontrollable:** the oracle is external (pyth/switchboard); the program
  won't let you open an already-underwater position; CI can't move the price.
  (Setup is fine — the +1 SOL position opens via the filler reliably.)
- **To orchestrate (any one):**
  1. **Controllable/mock oracle** on devnet (push an adverse price via the oracle
     authority).
  2. **Admin-raise** the market's `margin_ratio_maintenance` so the existing
     leverage breaches immediately, then let the deployed liquidator act.
  Either needs an admin/oracle authority + a running liquidator.

### 5. `bad_spot_borrow_gets_liquidated` — deployed liquidator (spot) — `#[ignore]`
- **Depends on:** SOL (spot 1) **borrows being enabled and liquid**, then a
  maintenance breach (same oracle-drift problem as #4).
- **Why uncontrollable:** SOL borrow is currently **unavailable on devnet** — the
  withdraw-as-borrow fails, so the test can't even set up (hence `#[ignore]`).
- **To orchestrate:** admin-enable spot-1 borrows + seed borrow liquidity, then
  oracle control / maintenance-margin bump as in #4. Also needs a **repay** step in
  cleanup (the borrowed SOL can't be returned without acquiring SOL; `cleanup` only
  cancels orders).

### 6. `unsettled_pnl_gets_settled` — deployed userPnlSettler
- **Depends on:** the deployed **userPnlSettler being up** and the banked pnl
  exceeding **its settle threshold**.
- **Why uncontrollable:** external bot liveness + an off-chain threshold we don't
  control. (Setup is fine — open+close via the filler banks unsettled pnl reliably.)
- **To orchestrate (any one):**
  1. Size the position so realized pnl clears the settler's threshold (requires
     knowing/controlling that threshold).
  2. Drive `settle_pnl` **from the test** (deterministic) — but then it verifies
     our crank, not the deployed settler.

### 7. `swift_taker_filled_by_deployed_maker` — swift server + deployed maker — `#[ignore]`
- **Depends on:** the swift **HTTP order server being reachable** and a deployed
  swift maker filling.
- **Why uncontrollable:** `swift.master.velocity.exchange/orders` **intermittently
  502s** from the ALB (seen both 422 = up and 502 minutes apart) — server-side
  reliability. (Host is correct; the swapped `master.swift.…` does not resolve; the
  WS feed on the right host works for the filler.) Hence `#[ignore]`.
- **To orchestrate:** stabilize the swift HTTP backend (ops), and run a swift maker
  — or downgrade the test to "POST accepted (2xx)" without asserting a fill.

## What deterministic orchestration generally requires (not available to CI today)

The CI run holds only a funded `TEST_PRIVATE_KEY`. Making the above deterministic
needs one or more of: **the program admin key** (oracle push / margin / spread /
jit-intensity / borrow-enable / TWAP reset), **a controllable devnet oracle**,
**test-pinned bots** (maker / liquidator / settler) rather than ambient prod bots,
**a second funded authority** (to avoid duplicate-`UserStats` when one side fills
another), and/or **TWAP warm-up time**. Until some of those exist for the e2e
environment, the warn-skip contract above is the correct design.

## Cleanup / loose ends
- `keep-rs/.env` is set up to run the filler locally in dry-run for debugging
  (`MAINNET=false DRY_RUN=true`, Helius LaserStream gRPC, Triton RPC,
  `SWIFT_WS_URL=wss://swift.master.velocity.exchange`). Not committed (gitignored).
- If devnet state is wiped/reset, re-run keep-rs `--init-user` so the filler's User
  subaccount exists.
- Infra asks blocking the last two `#[ignore]`s: (a) stabilize the swift HTTP
  backend, (b) enable + seed SOL (spot-1) borrows on devnet.
