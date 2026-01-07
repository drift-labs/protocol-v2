## Margin Calculation Snapshot (SDK)

This document describes the single-source-of-truth margin engine in the SDK that mirrors the on-chain `MarginCalculation` and related semantics. The goal is to compute an immutable snapshot in one pass and have existing `User` getters delegate to it, eliminating duplicative work across getters and UI hooks while maintaining parity with the program.

### Alignment with on-chain

- The SDK snapshot shape mirrors `programs/drift/src/state/margin_calculation.rs` field-for-field.
- The inputs and ordering mirror `calculate_margin_requirement_and_total_collateral_and_liability_info` in `programs/drift/src/math/margin.rs`.
- Isolated positions are represented as `isolatedMarginCalculations` keyed by perp `marketIndex`, matching program logic.

### Core SDK types (shape parity)

```ts
// Types reflect on-chain names and numeric signs
import { MarketType } from './types';

export type MarginCategory = 'Initial' | 'Maintenance' | 'Fill';

export type MarginCalculationMode =
  | { type: 'Standard' }
  | { type: 'Liquidation' };

export class MarketIdentifier {
  marketType: MarketType;
  marketIndex: number;

  static spot(marketIndex: number): MarketIdentifier;
  static perp(marketIndex: number): MarketIdentifier;
  equals(other: MarketIdentifier | undefined): boolean;
}

export class MarginContext {
  marginType: MarginCategory;
  mode: MarginCalculationMode;
  strict: boolean;
  ignoreInvalidDepositOracles: boolean;
  isolatedMarginBuffers: Map<number, BN>;
  crossMarginBuffer: BN;

  // Factory methods
  static standard(marginType: MarginCategory): MarginContext;
  static liquidation(
    crossMarginBuffer: BN,
    isolatedMarginBuffers: Map<number, BN>
  ): MarginContext;

  // Builder methods (return this for chaining)
  strictMode(strict: boolean): this;
  ignoreInvalidDeposits(ignore: boolean): this;
  setCrossMarginBuffer(crossMarginBuffer: BN): this;
  setIsolatedMarginBuffers(isolatedMarginBuffers: Map<number, BN>): this;
  setIsolatedMarginBuffer(marketIndex: number, isolatedMarginBuffer: BN): this;
}

export class IsolatedMarginCalculation {
  marginRequirement: BN;             // u128
  totalCollateral: BN;               // i128 (deposit + pnl)
  totalCollateralBuffer: BN;         // i128
  marginRequirementPlusBuffer: BN;   // u128

  getTotalCollateralPlusBuffer(): BN;
  meetsMarginRequirement(): boolean;
  meetsMarginRequirementWithBuffer(): boolean;
  marginShortage(): BN;
}

export class MarginCalculation {
  context: MarginContext;

  totalCollateral: BN;               // i128
  totalCollateralBuffer: BN;         // i128
  marginRequirement: BN;             // u128
  marginRequirementPlusBuffer: BN;   // u128

  isolatedMarginCalculations: Map<number, IsolatedMarginCalculation>;

  totalPerpLiabilityValue: BN;       // u128

  // Cross margin helpers
  getCrossTotalCollateralPlusBuffer(): BN;
  meetsCrossMarginRequirement(): boolean;
  meetsCrossMarginRequirementWithBuffer(): boolean;
  getCrossFreeCollateral(): BN;

  // Combined (cross + isolated) helpers
  meetsMarginRequirement(): boolean;
  meetsMarginRequirementWithBuffer(): boolean;

  // Isolated margin helpers
  getIsolatedFreeCollateral(marketIndex: number): BN;
  getIsolatedMarginCalculation(marketIndex: number): IsolatedMarginCalculation | undefined;
  hasIsolatedMarginCalculation(marketIndex: number): boolean;
}
```

### Computation model (on-demand)

- The SDK computes the snapshot on-demand when `getMarginCalculation(...)` is called.
- No event-driven recomputation by default (oracle prices can change every slot; recomputing every update would be wasteful).
- Callers (UI/bots) decide polling frequency (e.g., UI can refresh every ~1s on active trade forms).

### User integration

`User` class provides the primary entrypoint:

```ts
public getMarginCalculation(
  marginCategory: MarginCategory = 'Initial',
  opts?: {
    strict?: boolean;                              // mirror StrictOraclePrice application
    includeOpenOrders?: boolean;                   // include open orders in margin calc
    enteringHighLeverage?: boolean;                // entering high leverage mode
    liquidationBufferMap?: Map<number | 'cross', BN>; // margin buffer for liquidation mode
  }
): MarginCalculation;
```

Existing getters delegate to the snapshot to avoid duplicate work:
- `getTotalCollateral()` → `snapshot.totalCollateral`
- `getMarginRequirement(mode)` → `snapshot.marginRequirement`
- `getFreeCollateral()` → `snapshot.getCrossFreeCollateral()`
- Per-market isolated FC → `snapshot.getIsolatedFreeCollateral(marketIndex)`

### UI compatibility

- All existing `User` getters remain and delegate to the snapshot, so current UI keeps working without call-site changes.
- New consumers can call `user.getMarginCalculation()` to access isolated breakdowns via `isolatedMarginCalculations`.

### Testing and parity

- Golden tests comparing SDK snapshot against program outputs (cross and isolated, edge cases).
- Keep math/rounding identical to program (ordering, buffers, funding, open-order IM, oracle strictness).

### Migration plan (brief)

1. Implement `types` and `engine` with strict parity; land behind a feature flag.
2. Add `user.getMarginCalculation()` and delegate legacy getters.
3. Optionally update UI hooks to read richer fields; not required for compatibility.
4. Expand parity tests; enable by default after validation.
