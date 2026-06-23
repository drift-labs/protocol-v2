# Devnet E2E — taker-vs-AMM handoff

Status as of this branch (`fix/devnet-amm-jit-and-e2e`). The devnet e2e suite
(`tests/devnet_e2e.rs`, gated `--features rpc_tests`) is mostly green; the one
unresolved scenario is **`taker_fills_against_amm`** (currently `#[ignore]`).
This doc captures the full investigation so the next dev can pick up cold.

## How to run locally

```bash
cd rust
TEST_PRIVATE_KEY="$(cat <funded-devnet-key-base58>)" \
TEST_DEVNET_RPC_ENDPOINT="https://drift-drift-a827.devnet.rpcpool.com/<token>" \
cargo test -p velocity-rs --test devnet_e2e --features rpc_tests \
  taker_fills_against_amm -- --exact --ignored --nocapture
```

Devnet: program `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P`, `eu-west-1`,
k8s namespace `master`. Markets: SOL-PERP = perp 0, dUSDT = spot 0 (6dp),
SOL = spot 1 (9dp).

## Green scenarios (deterministic, verified passing)
`deposit_into_spot_market`, `withdraw_from_spot_market`,
`dlob_maker_taker_filled_by_filler` (matched maker↔taker via a deployed filler),
`mark_twap_crank_advances`. `#[ignore]`'d / inconclusive: jit, swift, the two
liquidation scenarios, unsettled-pnl, and `taker_fills_against_amm` (this doc).

## The question: why `place_and_take` returns 0 base vs the AMM

Read the program + simulated on-chain (`PAT_LOG: AMM cannot fill order: AMM does
not want to JIT make`). `place_and_take` fills the AMM via exactly two routes in
`PerpMarket::amm_can_fill_order` (`programs/velocity/src/state/perp_market.rs:1048`):

1. **Low-risk route** — `Order::is_low_risk_for_amm` (`.../state/user.rs:1637`):
   passes iff `clock_slot - mm_oracle_delay >= order.slot`. A `place_and_take`
   order is placed AND taken in the same slot (`order.slot == clock_slot`), so it
   only passes when `mm_oracle_delay == 0`. The `delay` used here is the **raw**
   `clock_slot - market_stats.mm_oracle_slot` (`perp_market.rs:1011`); the
   `oracle_slot_delay_override` / `oracle_low_risk_slot_delay_override` knobs only
   gate oracle *validity* (`math/oracle.rs:362,368`), NOT this anti-pickoff age
   check — so no staleness-threshold value opens this route for a same-slot order.
2. **JIT route** — `amm_wants_to_jit_make` (`programs/velocity/src/vlp/amm/state.rs:613`):
   needs `amm_jit_intensity > 0` AND the AMM holding inventory on the matching
   side (`base_asset_amount_with_amm < -order_step_size` for a long taker).

On **production**, `place_and_take` fills via the JIT route because prod AMMs
carry inventory and run `ammJitIntensity > 0`. Devnet SOL-PERP was initialized
with `ammJitIntensity = 0` and a flat book → both routes closed.

Live diagnostics captured (via RPC `simulate_transaction_with_config` dumping
program logs): `jit_intensity=0`, `base_with_amm=0`, `mm_delay` snapshot 8;
under debug logging the `mm_delay` actually **oscillates 0→7** (hits 0 right
after each crank lands, climbs until the next), so `oracle_stale_for_amm` is
almost always false (threshold `slots_before_stale_for_amm=10`).

## Fixes already landed

1. **`deploy-scripts/init-devnet.ts`** (this branch): `ammJitIntensity 0→100` on
   SOL-PERP init (line ~968) + an **idempotent Phase-D2 `updateAmmJitIntensity`
   step** so a rerun pushes 100 onto the already-created live market. Program caps
   at 100 (`admin.rs`). **This has been rerun against live devnet — jit=100 is
   live.**
2. **rust-filler crash fixed (live, not in git).** `rust-filler-bot` was in
   CrashLoopBackOff: `keep-rs filler.rs:587 NoAccountData(CGnRHdrLGvh2za9DYExEqqdMn55Ucv5EQDmg13jMJpyz)`
   — its own drift User account never existed (keep-rs does NOT self-init).
   Fixed by running keep-rs `--init-user` as a one-off k8s Job (image
   `keep-rs:v0.1.5`, env from `master-secrets`, command
   `["/usr/local/bin/keeprs","--init-user"]`). Account now exists; pod is 1/1.
   If devnet state is ever wiped/reset, this must be redone.

## The remaining blocker (UNRESOLVED)

Even with jit=100 live and the rust-filler 1/1, **the deployed rust-filler never
fills a lone taker order against the AMM.** The test rests a market order with a
long auction (now 200 slots ≈ 85s, auction +2%→+15% through oracle) and waits
120s; the filler never fills it.

Key evidence from debug logging (`RUST_LOG=info,filler=debug,oracle=debug` — set
temporarily on the deployment; see Cleanup):
- The filler's slot loop **is alive** (logs an `oracle price:` line every slot).
  My earlier "stalled after startup" read was WRONG.
- During an 85s-long resting auction order, the filler logged **zero** non-oracle
  lines — `dlob.find_crosses_for_auctions` (`keep-rs/src/filler.rs:359`) returned
  **empty**, so `try_auction_fill` was never invoked. No "found auction crosses",
  no `intent`, no `skip`.
- Since the debug-pod restart it has done **0** fills of any kind (the only fills
  ever seen were 2 `limit_uncross` at the very first pod's startup, from leftover
  book orders).

### Two leading hypotheses (next dev: confirm which)
- **(A) The rust-filler's DLOB isn't updating from streaming gRPC.** It appears
  to only populate from the initial snapshot at startup and not apply subsequent
  account updates → an empty book → finds no crosses ever (including my fresh
  order). The gRPC subscribes to all accounts owned by the program
  (`setup_grpc`), and oracle data DOES sync, but the order/DLOB path may not.
- **(B) `find_crosses_for_auctions` needs resting makers to anchor a cross
  region** and doesn't produce a lone-taker vAMM cross. The one historical
  `has_vamm_cross: true` was inside a `MakerCrosses` that also had resting makers.

**The decisive next experiment** (was about to run when work stopped): run
`dlob_maker_taker_filled_by_filler` and tail the rust-filler debug logs. That
test places a maker AND a crossing taker.
- If the rust-filler logs `found limit crosses` / `found auction crosses` →
  its DLOB syncs ⇒ hypothesis (B): lone-taker-vs-AMM isn't detected without
  makers (a keep-rs cross-detection limitation).
- If it logs nothing (and the test still passes — meaning the TS
  `order-filler-multithreaded-bot` did the matched fill) → hypothesis (A): the
  rust-filler's DLOB streaming is broken.

```bash
# terminal 1
cargo test -p velocity-rs --test devnet_e2e --features rpc_tests \
  dlob_maker_taker_filled_by_filler -- --exact --nocapture
# terminal 2
kubectl logs -n master -l app=rust-filler-bot -f --since=2s \
  | grep -iaE "found .*cross|try uncross|intent|vamm|skip|AuctionFill|LimitUncross"
```

keep-rs source is at `rust/keep-rs/`. Relevant: `src/filler.rs` main loop
(`:186`), auction-cross detection (`:359` `find_crosses_for_auctions`),
`try_auction_fill` (`:570`), the vAMM-active closure
(`:374` = `has_too_much_drawdown && amm_wants_to_jit_make`, so NOT a blocker
here since no drawdown), `oracle_stale_for_amm` (`:347`), and
`amm_wants_to_jit_make` helper (`:918`).

## The test today (`taker_fills_against_amm`, `#[ignore]`)

Rests a `Market` order, 1 SOL long, auction `+2% → +15%` over **200 slots**, and
asserts the deployed filler fills it to **exactly `+ONE_SOL`** within 120s. The
design is right (the only deterministic, prod-faithful AMM fill on devnet is the
low-risk route reached by aging, cranked by the deployed filler — `place_and_take`
can't fill a flat AMM same-slot, proven above). It will go green once the filler
reliably cranks lone-taker vAMM fills. Un-ignore then.

Note: a self-cranked `fill_perp_order` is NOT an option for this harness — all
subaccounts share the single `TEST_PRIVATE_KEY` authority, so filler_stats ==
taker_stats (duplicate writable account).

## Possible resolutions
- Fix keep-rs (hypothesis A or B) so the rust-filler does lone-taker vAMM fills,
  ship a new image, bump the gitops pin
  (`infrastructure-v3/gitops/non-prod/workloads/master/bots/rust-filler-bot.yaml`).
- OR pre-seed AMM inventory + use `place_and_take` via the now-live JIT route
  (needs a second authority to open the AMM position deterministically — see the
  single-authority caveat above).

## Cleanup / loose ends
- **Revert the debug `RUST_LOG`** on `rust-filler-bot`: it was changed in
  `infrastructure-v3/gitops/non-prod/workloads/master/bots/rust-filler-bot.yaml`
  (committed to infra-v3 `master`) to
  `info,filler=debug,oracle=debug,dlob=warn,swift=info`. Restore to
  `info,filler=info,dlob=warn,swift=info` and re-sync ArgoCD when done debugging.
  (Note: ArgoCD self-heal is ON for this app — `kubectl set env` gets reverted;
  change must go through the gitops manifest.)
- The `rust-filler-init-user` Job has `ttlSecondsAfterFinished: 600` so it
  auto-cleans; the staged YAML is in the session scratchpad if needed again.
- This branch is NOT yet PR'd (intentionally held).
