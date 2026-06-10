# Velocity Protocol v2 — Architecture

Navigation map for `programs/velocity` and `sdk/`. Start here to find the right file for any query.

---

## Module Responsibility Matrix

| Module | Owns | Does NOT own |
|---|---|---|
| `programs/velocity/src/instructions/` | Account constraint structs, Anchor deserialization, input validation, delegation to `controller` | Business logic, math |
| `programs/velocity/src/controller/` | Stateful mutations: fills, liquidations, position updates, funding | Account loading (done by `instructions`), pure math |
| `programs/velocity/src/math/` | Pure numeric functions: margin, fees, funding, AMM pricing, oracle checks | Any account I/O or state mutation |
| `programs/velocity/src/state/` | Account struct definitions and accessor/mutation methods | Instruction routing, math |
| `programs/velocity/src/validation/` | Pre-mutation precondition checks (called by `instructions` before `controller`) | Post-trade checks (those live in `math/margin`) |

---

## Execution Flows

### Place Perp Order
1. User calls `place_perp_order` → `instructions/user.rs` (`PlacePerpOrder` context)
2. → `validation::order::validate_order` (`validation/order.rs`)
3. → `controller::orders::place_perp_order` (`controller/orders.rs`)
4. → `math::orders::standardize_base_asset_amount` + auction parameter derivation
5. → `state::user::add_order` writes order to `User` account

### Fill Perp Order (keeper crank)
1. Keeper calls `fill_perp_order` → `instructions/keeper.rs` (`FillPerpOrder` context)
2. → `controller::orders::fill_perp_order` (`controller/orders.rs`)
3. → `math::margin::calculate_margin_requirement` (pre-fill margin check)
4. → `controller::orders::fulfill_perp_order_with_match` (maker matching loop)
5. → `controller::position::update_position_and_market` (`controller/position.rs`)
6. → `controller::orders::update_order_after_fill` + bookkeeping
7. → emits `OrderActionRecord` event (`state/events.rs`)

### Liquidate Perp
1. Keeper calls `liquidate_perp` → `instructions/keeper.rs`
2. → `controller::liquidation::liquidate_perp` (`controller/liquidation.rs`)
3. → `math::margin::calculate_margin_requirement` (confirms liquidatable)
4. → `math::liquidation::calculate_perp_liquidation_price` + fee
5. → `controller::position::update_position_and_market`
6. → emits `LiquidationRecord`

### Settle PnL
1. Keeper calls `settle_pnl` → `instructions/keeper.rs`
2. → `controller::pnl::settle_funding_payment` (`controller/pnl.rs`)
3. → `math::pnl::calculate_per_lp_position`
4. → mutates `PerpMarket.pnl_pool` and `User` position

### Update Funding Rate
1. Keeper calls `update_funding_rate` → `instructions/keeper.rs`
2. → `controller::funding::update_funding_rate` (`controller/funding.rs`)
3. → `math::funding::calculate_funding_rate` (TWAP-based)
4. → writes `PerpMarket.amm.last_funding_rate`

---

## Account Type Locations

| Type | File | Notes |
|---|---|---|
| `User` | `state/user.rs` | Zero-copy, `AccountLoader`. Holds positions, open orders, margin info. |
| `UserStats` | `state/user.rs` | Companion to `User`, tracks volume/fees/referrals. |
| `PerpMarket` | `state/perp_market.rs` | Zero-copy. Embeds `AMM` struct for AMM state. |
| `SpotMarket` | `state/spot_market.rs` | Zero-copy. Tracks deposits/borrows, oracle, insurance. |
| `State` | `state/state.rs` | Global protocol config: fees, admin pubkey, number of markets. |
| `InsuranceFundStake` | `state/insurance_fund_stake.rs` | Per-user IF stake position. |
| `OracleMap` | `state/oracle_map.rs` | Per-instruction oracle account loader, built from `remaining_accounts`. |
| `OrderParams` | `state/order_params.rs` | Shared input struct for place/modify order instructions. |
| All events | `state/events.rs` | `OrderActionRecord`, `DepositRecord`, `LiquidationRecord`, `FundingPaymentRecord`, etc. |

---

## Key Design Patterns

### Custom High-Frequency Entrypoint
Keeper instructions (`fill_perp_order`, `update_funding_rate`, etc.) use a custom native entrypoint with discriminator `[0xFF, 0xFF, 0xFF, 0xFF, opcode]` that bypasses Anchor's account deserialization overhead. Standard user and admin instructions use the normal Anchor `#[program]` entrypoint.

### `remaining_accounts` Convention
Variable-length account lists are passed via `remaining_accounts` to avoid fixed Anchor context sizes:
- **Oracles**: one oracle account per market referenced in the instruction
- **Spot markets**: for instructions touching multiple spot positions
- **Maker accounts**: `(User, UserStats)` pairs for each DLOB maker in a fill
- **Referrer**: optional `(User, UserStats)` pair at the end of remaining_accounts

### Zero-Copy Account Loading
`User`, `PerpMarket`, and `SpotMarket` are loaded via `AccountLoader<'info, T>` (zero-copy). Call `.load()`/`.load_mut()` rather than direct deserialization. This avoids stack overflow on large structs.

### Feature Flags
| Flag | Purpose |
|---|---|
| `mainnet-beta` | Production gates (program IDs, conservative limits) |
| `anchor-test` | Enables test helper instructions used by TS integration tests |
| `no-entrypoint` | Excludes native entrypoint (for use as CPI dependency) |
| `cpi` | Exposes CPI client only (implies `no-entrypoint`) |

---

## SDK Structure (`sdk/src/`)

### Key Files
| File | Size | Purpose |
|---|---|---|
| `velocityClient.ts` | ~13k lines | Main client. All trading + keeper instruction builders. |
| `adminClient.ts` | ~6.5k lines | Admin instruction builders (extends `VelocityClient`). |
| `user.ts` | ~4.7k lines | `User` account abstraction: margin queries, position accessors, PnL. |
| `types.ts` | ~45k lines | All shared TypeScript types mirroring on-chain structs. |
| `idl/velocity.json` | — | Generated Anchor IDL. Source of truth for instruction interfaces and account layouts. **Do not edit manually.** |

### Key Directories
| Directory | Purpose |
|---|---|
| `accounts/` | Account subscription infrastructure: WebSocket, polling, bulk loaders. |
| `addresses/` | `pda.ts` — all PDA derivation helpers. |
| `dlob/` | Decentralized Limit Order Book: order matching, price levels, maker selection. |
| `math/` | TypeScript mirrors of on-chain math (margin, funding, AMM pricing). |
| `oracles/` | Oracle client adapters (Pyth, Switchboard, Pyth Lazer). |
| `events/` | Event parsing and subscription from program logs. |
| `tx/` | Transaction building utilities, compute unit estimation. |
| `constants/` | Market indices, precision constants, numeric limits. |

### SDK ↔ On-Chain Instruction Mapping
| SDK Method | On-Chain Instruction | Handler File |
|---|---|---|
| `velocityClient.placePerpOrder` | `PlacePerpOrder` | `instructions/user.rs` |
| `velocityClient.cancelOrder` | `CancelOrder` | `instructions/user.rs` |
| `velocityClient.modifyOrder` | `ModifyOrder` | `instructions/user.rs` |
| `velocityClient.deposit` | `Deposit` | `instructions/user.rs` |
| `velocityClient.withdraw` | `Withdraw` | `instructions/user.rs` |
| `velocityClient.fillPerpOrder` | `FillPerpOrder` | `instructions/keeper.rs` |
| `velocityClient.settlePnl` | `SettlePnl` | `instructions/keeper.rs` |
| `velocityClient.liquidatePerp` | `LiquidatePerp` | `instructions/keeper.rs` |
| `velocityClient.updateFundingRate` | `UpdateFundingRate` | `instructions/keeper.rs` |
| `adminClient.initializePerpMarket` | `InitializePerpMarket` | `instructions/admin.rs` |
| `adminClient.updatePerpMarket*` | `UpdatePerpMarket*` | `instructions/admin.rs` |
| `adminClient.updateOracleGuardRails` | `UpdateOracleGuardRails` | `instructions/admin.rs` |

---

## Ancillary Programs

These are stubs/wrappers used by Velocity for oracle and DEX integrations. No core logic lives here.

| Program | Purpose |
|---|---|
| `programs/pyth/` | Pyth V1 oracle account layout definitions |
| `programs/pyth-lazer/` | Pyth Lazer type definitions and utilities |
| `programs/switchboard/` | Switchboard V2 oracle account type definitions |
| `programs/switchboard-on-demand/` | Switchboard On-Demand oracle type definitions |
| `programs/openbook_v2/` | OpenBook V2 account types for spot fulfillment |
| `programs/token_faucet/` | Devnet/test token minting utility (not on mainnet) |

---

## Build & Test Quick Reference

See `CLAUDE.md` for full commands. Key entry points:

```bash
# Verify program compiles after Rust changes
cargo build -p velocity

# Run Rust unit tests
cargo test -p velocity

# Run a single TS integration test
ts-mocha -t 300000 ./tests/<test_file>.ts

# Full TS integration suite
bash test-scripts/run-anchor-tests.sh --skip-build
```
