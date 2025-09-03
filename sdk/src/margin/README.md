## Margin Calculation Snapshot (SDK)

This document describes the single-source-of-truth margin engine in the SDK that mirrors the on-chain `MarginCalculation` and related semantics. The goal is to compute an immutable snapshot in one pass and have existing `User` getters delegate to it, eliminating duplicative work across getters and UI hooks while maintaining parity with the program.

### Alignment with on-chain

- The SDK snapshot shape mirrors `programs/drift/src/state/margin_calculation.rs` field-for-field.
- The inputs and ordering mirror `calculate_margin_requirement_and_total_collateral_and_liability_info` in `programs/drift/src/math/margin.rs`.
- Isolated positions are represented as `isolated_margin_calculations` keyed by perp `market_index`, matching program logic.

### Core SDK types (shape parity)

```ts
// Types reflect on-chain names and numeric signs
export type MarginRequirementType = 'Initial' | 'Fill' | 'Maintenance';
export type MarketType = 'Spot' | 'Perp';

export type MarketIdentifier = {
  marketType: MarketType;
  marketIndex: number; // u16
};

export type MarginCalculationMode =
  | { kind: 'Standard' }
  | { kind: 'Liquidation'; marketToTrackMarginRequirement?: MarketIdentifier };

export type MarginContext = {
  marginType: MarginRequirementType;
  mode: MarginCalculationMode;
  strict: boolean;
  ignoreInvalidDepositOracles: boolean;
  marginBuffer: BN;                  // u128
  fuelBonusNumerator: number;       // i64
  fuelBonus: number;                 // u64
  fuelPerpDelta?: { marketIndex: number; delta: BN };      // (u16, i64)
  fuelSpotDeltas: Array<{ marketIndex: number; delta: BN }>; // up to 2 entries
  marginRatioOverride?: number;     // u32
};

export type IsolatedMarginCalculation = {
  marginRequirement: BN;             // u128
  totalCollateral: BN;               // i128
  totalCollateralBuffer: BN;        // i128
  marginRequirementPlusBuffer: BN; // u128
};

export type MarginCalculation = {
  context: MarginContext;

  totalCollateral: BN;               // i128
  totalCollateralBuffer: BN;        // i128
  marginRequirement: BN;             // u128
  marginRequirementPlusBuffer: BN; // u128

  isolatedMarginCalculations: Map<number, IsolatedMarginCalculation>; // BTreeMap<u16,_>

  numSpotLiabilities: number;       // u8
  numPerpLiabilities: number;       // u8
  allDepositOraclesValid: boolean;
  allLiabilityOraclesValid: boolean;
  withPerpIsolatedLiability: boolean;
  withSpotIsolatedLiability: boolean;

  totalSpotAssetValue: BN;         // i128
  totalSpotLiabilityValue: BN;     // u128
  totalPerpLiabilityValue: BN;     // u128
  totalPerpPnl: BN;                 // i128

  trackedMarketMarginRequirement: BN; // u128
  fuelDeposits: number;              // u32
  fuelBorrows: number;               // u32
  fuelPositions: number;             // u32
};
```

### Engine API

```ts
// Pure computation, no I/O; uses data already cached in the client/subscribers
export function computeMarginCalculation(user: User, context: MarginContext): MarginCalculation;

// Helpers that mirror on-chain semantics
export function meets_margin_requirement(calc: MarginCalculation): boolean;
export function meets_margin_requirement_with_buffer(calc: MarginCalculation): boolean;
export function get_cross_free_collateral(calc: MarginCalculation): BN;
export function get_isolated_free_collateral(calc: MarginCalculation, marketIndex: number): BN;
export function cross_margin_shortage(calc: MarginCalculation): BN; // requires buffer mode
export function isolated_margin_shortage(calc: MarginCalculation, marketIndex: number): BN; // requires buffer mode
```

### Computation model (on-demand)

- The SDK computes the snapshot on-demand when `getMarginCalculation(...)` is called.
- No event-driven recomputation by default (oracle prices can change every slot; recomputing every update would be wasteful).
- Callers (UI/bots) decide polling frequency (e.g., UI can refresh every ~1s on active trade forms).

### User integration

- Add `user.getMarginCalculation(margin_type = 'Initial', overrides?: Partial<MarginContext>)`.
- Existing getters delegate to the snapshot to avoid duplicate work:
  - `getTotalCollateral()` → `snapshot.total_collateral`
  - `getMarginRequirement(mode)` → `snapshot.margin_requirement`
  - `getFreeCollateral()` → `get_cross_free_collateral(snapshot)`
  - Per-market isolated FC → `get_isolated_free_collateral(snapshot, marketIndex)`

Suggested `User` API surface (non-breaking):

```ts
// Primary entrypoint
getMarginCalculation(
  marginType: 'Initial' | 'Maintenance' | 'Fill' = 'Initial',
  contextOverrides?: Partial<MarginContext>
): MarginCalculation;

// Optional conveniences for consumers
getIsolatedMarginCalculation(
  marketIndex: number,
  marginType: 'Initial' | 'Maintenance' | 'Fill' = 'Initial',
  contextOverrides?: Partial<MarginContext>
): IsolatedMarginCalculation | undefined;

// Cross views can continue to use helpers on the snapshot:
// get_cross_free_collateral(snapshot), meets_margin_requirement(snapshot), etc.
```

### UI compatibility

- All existing `User` getters remain and delegate to the snapshot, so current UI keeps working without call-site changes.
- New consumers can call `user.getMarginCalculation()` to access isolated breakdowns.

### Testing and parity

- Golden tests comparing SDK snapshot against program outputs (cross and isolated, edge cases).
- Keep math/rounding identical to program (ordering, buffers, funding, open-order IM, oracle strictness).

### Migration plan (brief)

1. Implement `types` and `engine` with strict parity; land behind a feature flag.
2. Add `user.getMarginCalculation()` and delegate legacy getters.
3. Optionally update UI hooks to read richer fields; not required for compatibility.
4. Expand parity tests; enable by default after validation.


