# Plan: AI-Conducive Code Structure Refactor

Structural changes to reduce context explosion and improve discoverability for AI-assisted development.
**No logic changes — mechanical reorganization only.**

---

## Goals

1. No single source file should require loading more than ~1,500 lines to understand its domain
2. An AI (or human) should be able to identify the right file for any query without reading file contents
3. The public API surface of each module should be visible without reading implementation files
4. Test files should be grouped so coverage for any feature is findable by directory name alone

---

## Scope of Work at a Glance

| Area | Worst Offender | Size | Action |
|---|---|---|---|
| SDK | `sdk/src/velocityClient.ts` | 12,933 lines | Split by domain |
| SDK | `sdk/src/adminClient.ts` | 6,515 lines | Split by domain |
| SDK | `sdk/src/user.ts` | 4,651 lines | Split by domain |
| Instructions | `instructions/admin.rs` | 6,067 lines | Split into submodule |
| Instructions | `instructions/user.rs` | 5,252 lines | Split into submodule |
| Instructions | `instructions/keeper.rs` | 4,193 lines | Split into submodule |
| Controller | `controller/orders.rs` | 5,752 lines | Split into submodule |
| All mod.rs files | (no doc comments) | — | Add `//!` doc headers |
| `instructions/mod.rs` | glob re-exports | — | Replace with explicit exports |
| Tests | 110 flat `.ts` files | — | Reorganize into subdirs |
| Tests | `phoenixTestAccountData.ts` | 1.1 MB | Extract to JSON fixture |
| Docs | (nothing) | — | Add `ARCHITECTURE.md` nav map |

---

## Execution Order

Steps are ordered by ROI-to-risk ratio. Each step is independently shippable and verifiable.

1. **`//!` doc comments** on all `mod.rs` / entry files (zero compilation risk, immediate benefit)
2. **`ARCHITECTURE.md`** navigation map (zero risk, unblocks every future AI query)
3. **Explicit re-exports** in `instructions/mod.rs` (replaces glob exports)
4. **Extract phoenix fixture** to JSON (isolated, verifiable)
5. **Reorganize tests/** into subdirectories
6. **Split `controller/orders.rs`** (highest Rust edit frequency, unblocks PropAMM fill work)
7. **Split `instructions/keeper.rs`** (distinct domain, moderate size)
8. **Split `instructions/admin.rs`**
9. **Split `instructions/user.rs`**
10. **Split `sdk/src/velocityClient.ts`** (largest single file in repo)
11. **Split `sdk/src/adminClient.ts`**
12. **Split `sdk/src/user.ts`**
13. **Update `CLAUDE.md`** (reflect new paths, add ARCHITECTURE.md pointer)

---

## Step 1 — Add `//!` Doc Comments to All `mod.rs` Files

**Why first:** Costs ~30 minutes total. No compilation risk. Every subsequent AI query against these modules benefits immediately — the right file becomes identifiable without reading file contents.

**Files to update and suggested comment:**

- `programs/velocity/src/controller/mod.rs`
  ```rust
  //! Stateful protocol operations: fills, liquidations, position mutations, funding settlements.
  //! Pure math lives in `crate::math`. Instruction handlers (account validation) live in `crate::instructions`.
  ```

- `programs/velocity/src/instructions/mod.rs`
  ```rust
  //! Anchor instruction handlers: account constraints, deserialization, delegation to `controller`.
  //! user.rs = trading (orders, deposits, LP). keeper.rs = cranks (funding, settlement, liquidation). admin.rs = governance.
  ```

- `programs/velocity/src/math/mod.rs`
  ```rust
  //! Pure numeric logic: margin, fees, funding, AMM pricing, oracle validation.
  //! No account I/O. All functions are deterministic given inputs.
  ```

- `programs/velocity/src/state/mod.rs`
  ```rust
  //! On-chain account structs and their accessor/mutation methods.
  //! Zero-copy types (User, PerpMarket, SpotMarket) use AccountLoader. Enums and params are Copy.
  ```

- `programs/velocity/src/controller/orders.rs` (top of file, before use statements)
  ```rust
  //! Order lifecycle: placement validation, cancellation, and fill matching (perp + spot).
  //! Margin math → `crate::math::margin`. Liquidation fills → `crate::controller::liquidation`.
  //! AMM JIT and fuel accounting are in submodule tests but share this file's logic.
  ```

- `programs/velocity/src/controller/liquidation.rs`
  ```rust
  //! Liquidation engine: margin checks, position reduction, social loss, insurance draws.
  //! Liquidation instruction entry points → `crate::instructions::keeper`.
  ```

- `programs/velocity/src/lib.rs` (crate-level, before `#![allow(...)]` lines)
  ```rust
  //! Velocity Protocol v2 — Solana perpetuals and spot trading.
  //! Custom high-frequency entrypoint at discriminator `[0xFF, 0xFF, 0xFF, 0xFF, opcode]` bypasses Anchor overhead.
  //! Standard Anchor `#[program]` entrypoint handles all other instructions.
  ```

**Verify:** `cargo build -p velocity` passes.

---

## Step 2 — Add `ARCHITECTURE.md`

**Why:** A navigation map that answers "where do I look for X?" is the highest-leverage documentation change possible. It eliminates the grep-to-find-the-right-file loop on every query.

**File location:** `ARCHITECTURE.md` at repo root (alongside CLAUDE.md).

**Content should cover:**

- **Execution flows** (step-by-step file→function chains for: place order, fill order, liquidate, settle PnL, update funding)
- **Module responsibility matrix** (what each top-level module owns and explicitly does NOT own)
- **Account type locations** (where User, PerpMarket, SpotMarket structs live, how they're loaded)
- **SDK ↔ Program mapping** (which SDK method calls which on-chain instruction)
- **Key design patterns** (remaining_accounts layout, zero-copy loading, custom discriminator, feature flags)

Example entry:
```
## Order Fill Flow
1. Keeper calls `fill_perp_order` (instructions/keeper.rs)
2. → `controller::orders::fill_perp_order` (controller/orders.rs)
3. → margin check via `math::margin::calculate_margin_requirement`
4. → `fulfill_perp_order_with_match` for maker matching
5. → `controller::position::update_position_and_market` for settlement
6. → emits `OrderActionRecord` event
```

**Verify:** Human review only. No compilation step.

---

## Step 3 — Replace Glob Re-exports in `instructions/mod.rs`

**Why:** `pub use admin::*` floods ~150 symbols into one namespace. An AI (or human) cannot determine the API surface without reading all handler files. Explicit exports make the instruction set self-documenting.

**Current state:**
```rust
pub use admin::*;
pub use user::*;
pub use keeper::*;
// etc.
```

**Target state** — grouped, named re-exports:
```rust
// Trading instructions (user.rs)
pub use user::{Deposit, Withdraw, PlacePerpOrder, CancelOrder, /* ... */};

// Keeper/crank instructions (keeper.rs)  
pub use keeper::{FillPerpOrder, SettlePnl, UpdateFundingRate, LiquidatePerp, /* ... */};

// Admin/governance instructions (admin.rs)
pub use admin::{InitializeMarket, UpdatePerpMarket, UpdateOracleGuardRails, /* ... */};
```

**Verify:** `cargo build -p velocity` — all call sites resolve.

---

## Step 4 — Extract Phoenix Fixture to JSON

**Why:** `tests/phoenixTestAccountData.ts` is 1.1 MB of inline TypeScript constants. Loading this file for any phoenix-related query burns the entire usable context window.

- Create `tests/fixtures/` directory (may already exist)
- Extract the account data object to `tests/fixtures/phoenix_accounts.json`
- Replace `phoenixTestAccountData.ts` content with:
  ```typescript
  import { readFileSync } from 'fs';
  import path from 'path';
  export default JSON.parse(
    readFileSync(path.join(__dirname, 'fixtures/phoenix_accounts.json'), 'utf8')
  );
  ```
- Same treatment for `tests/switchboardOnDemandData.ts` (~50 KB, same pattern)

**Verify:** `ts-mocha -t 300000 ./tests/phoenixTest.ts` passes.

---

## Step 5 — Reorganize `tests/` into Subdirectories

**Why:** 110 flat files — an AI must scan all names to find coverage for any feature. Subdirectory names make coverage immediately discoverable.

**Create subdirectories and move files (no content changes):**

| Subdir | Files |
|---|---|
| `tests/orders/` | order.ts, scaleOrders.ts, modifyOrder.ts, cancelAllOrders.ts, postOnly.ts, stopLimits.ts, triggerOrders.ts, triggerSpotOrder.ts, ordersWithSpread.ts, oracleOffsetOrders.ts, roundInFavorBaseAsset.ts, maxLeverageOrderParams.ts, userOrderId.ts, multipleMakerOrders.ts, multipleSpotMakerOrders.ts, placeAndMakePerp.ts, placeAndMakeSpotOrder.ts, placeAndMakeSignedMsgBankrun.ts, marketOrder.ts, marketOrderBaseAssetAmount.ts |
| `tests/liquidation/` | liquidatePerp.ts, liquidatePerpWithFill.ts, liquidateSpot.ts, liquidateSpotSocialLoss.ts, liquidateBorrowForPerpPnl.ts, liquidatePerpPnlForDeposit.ts, isolatedPositionLiquidatePerp.ts, isolatedPositionLiquidatePerpwithFill.ts |
| `tests/markets/` | curve.ts, oracleDiffSources.ts, oracleFillPriceGuardrails.ts, repegAndSpread.ts, updateAMM.ts, updateK.ts, cappedSymFunding.ts, delistMarket.ts, delistMarketLiq.ts, imbalancePerpPnl.ts, switchOracle.ts, pyth.ts, pythLazerBankrun.ts, perpMarketConfig.ts, prelisting.ts, pauseExchange.ts |
| `tests/spot/` | spotDepositWithdraw.ts, spotDepositWithdraw22.ts, spotDepositWithdraw22TransferHooks.ts, fillSpot.ts, spotSwap.ts, spotSwap22.ts, spotMarketPoolIds.ts, depositIntoSpotMarketVault.ts, maxDeposit.ts, pauseDepositWithdraw.ts, assetTier.ts |
| `tests/admin/` | admin.ts, deleteInitializedSpotMarket.ts, adminWithdrawFromInsuranceFundVault.ts, insuranceFundStake.ts, ifRebalance.ts, builderCodes.ts |
| `tests/users/` | userAccount.ts, subaccounts.ts, userDelegate.ts, referrer.ts, velocityClient.ts, decodeUser.ts, isolatedPositionVelocityClient.ts, highLeverageMode.ts |
| `tests/` (keep root) | lpPool.ts, lpPoolSwap.ts, openbookTest.ts, phoenixTest.ts, serumTest.ts, switchboardTxCus.ts, settlePNLInvariant.ts, postOnlyAmmFulfillment.ts, fuel.ts, fuelSweep.ts, surgePricing.ts, transferPerpPosition.ts, whitelist.ts |

**After moving files:**
- Update `test-scripts/run-anchor-tests.sh` to use `tests/**/*.ts` glob or explicit new paths
- Update any `import` paths inside test files that cross-reference each other

**Verify:** `bash test-scripts/run-anchor-tests.sh --skip-build` runs all tests without path errors.

---

## Step 6 — Split `controller/orders.rs` (5,752 lines)

**Why:** Hottest-path file for trading and PropAMM work. Every fill, placement, and cancellation query forces loading 5,752 lines. Splitting enables targeted context loading.

**Create `programs/velocity/src/controller/orders/` directory:**

| New file | Contents |
|---|---|
| `orders/place.rs` | `place_perp_order`, `place_spot_order`, auction parameter logic, order validation |
| `orders/cancel.rs` | `cancel_order`, `cancel_orders_by_user_id`, `cancel_orders_by_market`, expiry logic |
| `orders/fill.rs` | `fill_perp_order`, `fulfill_perp_order_with_match`, AMM JIT, maker matching internals |
| `orders/mod.rs` | `//!` doc comment + `pub use` re-exports preserving `crate::controller::orders::*` call sites |

**`orders/mod.rs` must re-export all public symbols** that currently live in `orders.rs` so zero call sites change.

**Verify:** `cargo test -p velocity` passes with no logic changes.

---

## Step 7 — Split `instructions/keeper.rs` (4,193 lines)

**Why:** keeper.rs is not in the existing split plan but at 4,193 lines it has distinct, separable domains: funding rate cranks, PnL settlement, and liquidation entry points. These are rarely edited together.

**Create `programs/velocity/src/instructions/keeper/` directory:**

| New file | Contents |
|---|---|
| `keeper/funding.rs` | `update_funding_rate`, `update_funding_rate_ix` |
| `keeper/settle.rs` | `settle_pnl`, `settle_expired_market`, `settle_revenue_to_insurance_fund` |
| `keeper/liquidation.rs` | `liquidate_perp`, `liquidate_spot`, `liquidate_borrow_for_perp_pnl`, resolve handlers |
| `keeper/fill.rs` | `fill_perp_order`, `fill_spot_order`, keeper-side fill dispatch |
| `keeper/mod.rs` | `//!` doc comment + `pub use` re-exports |

**Verify:** `cargo test -p velocity` passes.

---

## Step 8 — Split `instructions/admin.rs` (6,067 lines, ~126 handlers)

**Create `programs/velocity/src/instructions/admin/` directory:**

| New file | Contents |
|---|---|
| `admin/initialize.rs` | Protocol bootstrap, state initialization, market initialization |
| `admin/markets.rs` | Perp/spot market create, update, status transitions, margin ratio updates |
| `admin/oracle.rs` | Oracle guard rails, oracle source updates, prelaunch oracle config |
| `admin/fees.rs` | Fee structure updates, discount tiers, maker/taker fee overrides |
| `admin/insurance.rs` | Insurance fund operations, revenue pool, IF stake management |
| `admin/token.rs` | Vault management, token admin operations |
| `admin/mod.rs` | `//!` doc comment + explicit named re-exports (no glob) |

**Update `instructions/mod.rs`** to use the same explicit re-export style established in Step 3.

**Verify:** `cargo test -p velocity` + `ts-mocha -t 300000 ./tests/admin/admin.ts` pass.

---

## Step 9 — Split `instructions/user.rs` (5,252 lines)

**Create `programs/velocity/src/instructions/user/` directory:**

| New file | Contents |
|---|---|
| `user/deposits.rs` | `deposit`, `withdraw`, `transfer_between_subaccounts` |
| `user/orders.rs` | `place_perp_order`, `cancel_order`, `modify_order` instruction handlers |
| `user/positions.rs` | `settle_pnl`, `close_position`, LP add/remove operations |
| `user/account.rs` | `initialize_user`, `delete_user`, `update_user_delegate`, referrer link |
| `user/mod.rs` | `//!` doc comment + explicit named re-exports |

**Verify:** Full `bash test-scripts/run-anchor-tests.sh --skip-build` passes.

---

## Step 10 — Split `sdk/src/velocityClient.ts` (12,933 lines)

**Why:** The largest single file in the repo and the one most queried by AI when building integrations or debugging. No plan previously addressed the SDK side at all. Every SDK query forces loading this monolith.

**Strategy:** Decompose by instruction domain into a directory-based class composition pattern.

**Create `sdk/src/velocityClient/` directory:**

| New file | Contents |
|---|---|
| `velocityClient/orders.ts` | `placePerpOrder`, `cancelOrder`, `modifyOrder`, `placeAndMake*` methods |
| `velocityClient/positions.ts` | `settlePnl`, `closePosition`, LP add/remove, position query methods |
| `velocityClient/deposits.ts` | `deposit`, `withdraw`, `transferBetweenSubAccounts` |
| `velocityClient/markets.ts` | Market info queries, oracle price fetching, funding rate reads |
| `velocityClient/accounts.ts` | `initializeUser`, `deleteUser`, subaccount management, delegate ops |
| `velocityClient/subscribe.ts` | Account subscription setup, slot tracking, connection management |
| `velocityClient/index.ts` | `VelocityClient` class that extends/composes the above, re-exports all types |

**Maintain backward compatibility:** `sdk/src/velocityClient.ts` becomes a re-export barrel:
```typescript
export { VelocityClient } from './velocityClient/index';
export * from './velocityClient/index';
```

**Verify:** `cd sdk && bun run build` passes. `cd sdk && bun run test:ci` passes.

---

## Step 11 — Split `sdk/src/adminClient.ts` (6,515 lines)

**Create `sdk/src/adminClient/` directory following the same pattern as Step 10:**

| New file | Contents |
|---|---|
| `adminClient/markets.ts` | `initializePerpMarket`, `updatePerpMarket*`, spot market admin ops |
| `adminClient/oracle.ts` | Oracle guard rail updates, oracle source admin methods |
| `adminClient/insurance.ts` | Insurance fund operations, revenue settings |
| `adminClient/fees.ts` | Fee structure admin methods |
| `adminClient/index.ts` | `AdminClient` class composition + re-exports |

**Verify:** `cd sdk && bun run build` passes.

---

## Step 12 — Split `sdk/src/user.ts` (4,651 lines)

**Create `sdk/src/user/` directory:**

| New file | Contents |
|---|---|
| `user/margin.ts` | Margin calculation methods, leverage queries, health factor |
| `user/positions.ts` | Position accessors, PnL calculation, unrealized PnL |
| `user/orders.ts` | Open order accessors, order filtering methods |
| `user/account.ts` | Account state, subaccount info, delegate checks |
| `user/index.ts` | `User` class composition + re-exports |

**Verify:** `cd sdk && bun run build` + `cd sdk && bun run test:ci` pass.

---

## Step 13 — Update `CLAUDE.md`

**Why:** CLAUDE.md is loaded into every AI session for this repo. After the refactor, several paths it references will be wrong or incomplete — broken references are worse than no references. It also currently has no pointer to `ARCHITECTURE.md` (Step 2), missing the primary navigation artifact.

**Changes required:**

- **Architecture → Programs section:** Update `src/instructions/` bullet points to reflect the new subdirectory layout (e.g., `user/` instead of `user.rs`, with a note that each subdirectory has a `mod.rs` that re-exports its handlers)
- **Architecture → SDK section:** Update `velocityClient.ts` and `user.ts` entries to reference the new `velocityClient/` and `user/` directories; note the barrel re-export pattern
- **Architecture → Tests section:** Update test count and note the subdirectory organization (orders/, liquidation/, markets/, etc.)
- **Add a navigation pointer:** After the Architecture heading, add a one-liner: `For a detailed execution flow map and module responsibility matrix, see [ARCHITECTURE.md](./ARCHITECTURE.md).`
- **Do not change:** Build commands, test commands, design patterns section — these remain accurate

**Verify:** Human review only. Confirm all file paths mentioned in CLAUDE.md exist on disk.

---

## What This Does NOT Change

- No logic changes anywhere — all changes are file reorganization and `pub use` re-exports
- No public API changes to the on-chain program (instruction discriminators unchanged)
- No SDK public API changes (all existing imports continue to work via barrel re-exports)
- No changes to Rust test logic (inline `#[cfg(test)]` modules stay where they are)

---

## Verification Checkpoints

Each step has its own verify block. Full suite after all steps complete:

```bash
# Rust
cargo test -p velocity

# TypeScript integration (full suite, ~70 tests)
bash test-scripts/run-anchor-tests.sh --skip-build

# SDK unit tests
cd sdk && bun run test:ci

# Build check
anchor build -- --features anchor-test
cd sdk && bun run build
```
