import { BN } from './isomorphic/anchor';
import { MARGIN_PRECISION, ZERO } from './constants/numericConstants';
import { getVariant, isVariant, MarginCategory, MarketType } from './types';

/**
 * Which margin threshold a `MarginCalculation` is computing against: `Initial` (opening/increasing
 * risk), `Maintenance` (liquidation eligibility), or `Fill` (order-fill-time check, the
 * integer-averaged midpoint of Initial and Maintenance). Re-exported from `./types` so the SDK has
 * a single `MarginCategory` definition.
 */
export type { MarginCategory };

/** Selects the margin-buffer behavior of a `MarginContext`: `Standard` for ordinary health checks (no buffer), or `Liquidation` to apply the cross/isolated margin buffers used to avoid liquidating a user who is only marginally underwater. */
export type MarginCalculationMode =
	| { type: 'Standard' }
	| { type: 'Liquidation' };

/** Identifies a market by type (spot or perp) and index, used as a key into per-market margin state (e.g. isolated margin buffers). Construct via `MarketIdentifier.spot` / `MarketIdentifier.perp`. */
export class MarketIdentifier {
	marketType: MarketType;
	marketIndex: number;

	private constructor(marketType: MarketType, marketIndex: number) {
		this.marketType = marketType;
		this.marketIndex = marketIndex;
	}

	/** Builds a `MarketIdentifier` for a spot market index. */
	static spot(marketIndex: number): MarketIdentifier {
		return new MarketIdentifier(MarketType.SPOT, marketIndex);
	}

	/** Builds a `MarketIdentifier` for a perp market index. */
	static perp(marketIndex: number): MarketIdentifier {
		return new MarketIdentifier(MarketType.PERP, marketIndex);
	}

	/** True if `other` refers to the same market type and index. */
	equals(other: MarketIdentifier | undefined): boolean {
		return (
			!!other &&
			isVariant(this.marketType, getVariant(other.marketType)) &&
			this.marketIndex === other.marketIndex
		);
	}
}

/**
 * Configuration driving a `MarginCalculation` pass: which margin category to compute,
 * whether it's a plain health check or a liquidation-margin-freed calculation, and the
 * per-market buffers (in `MARGIN_PRECISION`, 1e4, fractional-of-liability-value units)
 * applied to cross-margin and isolated-margin requirements/collateral so a user isn't
 * flagged liquidatable from a hair's-width shortfall. Mirrors `MarginContext` in
 * `programs/velocity/src/state/margin_calculation.rs`.
 */
export class MarginContext {
	marginType: MarginCategory;
	mode: MarginCalculationMode;
	strict: boolean;
	ignoreInvalidDepositOracles: boolean;
	isolatedMarginBuffers: Map<number, BN>;
	crossMarginBuffer: BN;

	private constructor(marginType: MarginCategory) {
		this.marginType = marginType;
		this.mode = { type: 'Standard' };
		this.strict = false;
		this.ignoreInvalidDepositOracles = false;
		this.isolatedMarginBuffers = new Map();
		this.crossMarginBuffer = ZERO;
	}

	/** Builds a plain `Standard`-mode context (no liquidation buffers) for the given margin category — the usual choice for health/leverage/order-placement checks. */
	static standard(marginType: MarginCategory): MarginContext {
		return new MarginContext(marginType);
	}

	/**
	 * Builds a `Maintenance`-category, `Liquidation`-mode context with the given buffers.
	 * Used by liquidation eligibility / margin-freed calculations so a position is only
	 * eligible once it's underwater by more than the buffer, avoiding flip-flopping right
	 * at the maintenance threshold.
	 * @param crossMarginBuffer Extra maintenance-margin cushion applied to the cross-margin
	 *   book, `MARGIN_PRECISION` (1e4) fraction of liability value.
	 * @param isolatedMarginBuffers Same buffer, per isolated-position market index.
	 */
	static liquidation(
		crossMarginBuffer: BN,
		isolatedMarginBuffers: Map<number, BN>
	): MarginContext {
		const ctx = new MarginContext('Maintenance');
		ctx.mode = { type: 'Liquidation' };
		ctx.crossMarginBuffer = crossMarginBuffer;
		ctx.isolatedMarginBuffers = isolatedMarginBuffers;
		return ctx;
	}

	/** Sets whether strict oracle pricing (worse of last/twap price) is used for collateral/liability valuation. Returns `this` for chaining. */
	strictMode(strict: boolean): this {
		this.strict = strict;
		return this;
	}

	/** Sets whether spot deposits with an invalid oracle are ignored (valued at zero) rather than failing the calculation. Returns `this` for chaining. */
	ignoreInvalidDeposits(ignore: boolean): this {
		this.ignoreInvalidDepositOracles = ignore;
		return this;
	}

	/** Sets the cross-margin maintenance buffer (`MARGIN_PRECISION`, 1e4, fraction of liability value). Returns `this` for chaining. */
	setCrossMarginBuffer(crossMarginBuffer: BN): this {
		this.crossMarginBuffer = crossMarginBuffer;
		return this;
	}
	/** Replaces the whole per-market isolated-margin buffer map. Returns `this` for chaining. */
	setIsolatedMarginBuffers(isolatedMarginBuffers: Map<number, BN>): this {
		this.isolatedMarginBuffers = isolatedMarginBuffers;
		return this;
	}
	/** Sets the isolated-margin buffer (`MARGIN_PRECISION`, 1e4, fraction of liability value) for a single perp market index. Returns `this` for chaining. */
	setIsolatedMarginBuffer(marketIndex: number, isolatedMarginBuffer: BN): this {
		this.isolatedMarginBuffers.set(marketIndex, isolatedMarginBuffer);
		return this;
	}
}

/**
 * Accumulated margin requirement and collateral for a single isolated perp position,
 * built up during a `MarginCalculation` pass via `MarginCalculation.addIsolatedMarginCalculation`.
 * All BN fields are QUOTE_PRECISION (1e6). Isolated positions have their own dedicated
 * collateral pool, so their margin health is tracked independently of the user's
 * cross-margin book.
 */
export class IsolatedMarginCalculation {
	/** Margin required to maintain/open the isolated position, QUOTE_PRECISION (1e6). */
	marginRequirement: BN;
	/** Isolated collateral: position's deposit value plus unrealized/settled pnl, QUOTE_PRECISION (1e6). */
	totalCollateral: BN; // deposit + pnl
	/** Signed adjustment to `totalCollateral` from the context's isolated margin buffer (liquidation mode only), QUOTE_PRECISION (1e6). */
	totalCollateralBuffer: BN;
	/** `marginRequirement` plus the buffered liability-value addition (liquidation mode only), QUOTE_PRECISION (1e6). */
	marginRequirementPlusBuffer: BN;

	constructor() {
		this.marginRequirement = ZERO;
		this.totalCollateral = ZERO;
		this.totalCollateralBuffer = ZERO;
		this.marginRequirementPlusBuffer = ZERO;
	}

	/** `totalCollateral + totalCollateralBuffer`, QUOTE_PRECISION (1e6). */
	getTotalCollateralPlusBuffer(): BN {
		return this.totalCollateral.add(this.totalCollateralBuffer);
	}

	/** True if the isolated position's collateral covers its margin requirement (no buffer applied). */
	meetsMarginRequirement(): boolean {
		return this.totalCollateral.gte(this.marginRequirement);
	}

	/** True if the buffered collateral covers the buffered margin requirement — the check used for liquidation eligibility. */
	meetsMarginRequirementWithBuffer(): boolean {
		return this.getTotalCollateralPlusBuffer().gte(
			this.marginRequirementPlusBuffer
		);
	}

	/** Buffered margin shortfall (`marginRequirementPlusBuffer - totalCollateralPlusBuffer`, floored at zero), QUOTE_PRECISION (1e6). */
	marginShortage(): BN {
		const shortage = this.marginRequirementPlusBuffer.sub(
			this.getTotalCollateralPlusBuffer()
		);
		return shortage.isNeg() ? ZERO : shortage;
	}
}

/**
 * Accumulator built up by walking a user's spot and perp positions, mirroring
 * `MarginCalculation` in `programs/velocity/src/state/margin_calculation.rs`. Tracks the
 * cross-margin book's total collateral/margin requirement plus a separate
 * `IsolatedMarginCalculation` per isolated perp market, so cross and isolated health are
 * evaluated independently — `meetsMarginRequirement`/`meetsMarginRequirementWithBuffer`
 * require both the cross book and every isolated position to pass.
 *
 * `numSpotLiabilities`/`numPerpLiabilities`/`withPerpIsolatedLiability`/
 * `withSpotIsolatedLiability` track the on-chain "isolated contract tier" risk-isolation
 * rule (`validate_any_isolated_tier_requirements`): a user holding a liability in a market
 * whose `ContractTier` is `Isolated` may not simultaneously hold other liabilities (perp or
 * non-quote spot) unless in reduce-only mode. Note this `ContractTier::Isolated` market
 * classification is unrelated to per-position isolated margin
 * (`isolatedPositionScaledBalance`) — a market can be isolated-tier without any position on
 * it using isolated margin.
 */
export class MarginCalculation {
	context: MarginContext;
	/** Cross-margin collateral (deposits + perp pnl), QUOTE_PRECISION (1e6). */
	totalCollateral: BN;
	/** Signed liquidation-buffer adjustment to `totalCollateral`, QUOTE_PRECISION (1e6). Zero outside `Liquidation` mode. */
	totalCollateralBuffer: BN;
	/** Cross-margin requirement accumulated so far, QUOTE_PRECISION (1e6). */
	marginRequirement: BN;
	/** `marginRequirement` plus the buffered liability-value addition (liquidation mode only), QUOTE_PRECISION (1e6). */
	marginRequirementPlusBuffer: BN;
	/** Per-isolated-perp-market margin state, keyed by perp market index. */
	isolatedMarginCalculations: Map<number, IsolatedMarginCalculation>;
	/** Sum of worst-case perp liability value across all (cross + isolated) perp positions seen so far, QUOTE_PRECISION (1e6). */
	totalPerpLiabilityValue: BN;
	/** Count of spot positions counted as liabilities (borrows) so far. */
	numSpotLiabilities: number;
	/** Count of perp positions counted as liabilities (non-flat base, negative quote, or open orders) so far. */
	numPerpLiabilities: number;
	/** True once any perp liability seen belongs to a `ContractTier::Isolated` market. */
	withPerpIsolatedLiability: boolean;
	/** True once any spot liability seen is a borrow (or has open orders) in an `AssetTier::Isolated` spot market (isolated-tier borrows are restricted to the quote asset). */
	withSpotIsolatedLiability: boolean;

	constructor(context: MarginContext) {
		this.context = context;
		this.totalCollateral = ZERO;
		this.totalCollateralBuffer = ZERO;
		this.marginRequirement = ZERO;
		this.marginRequirementPlusBuffer = ZERO;
		this.isolatedMarginCalculations = new Map();
		this.totalPerpLiabilityValue = ZERO;
		this.numSpotLiabilities = 0;
		this.numPerpLiabilities = 0;
		this.withPerpIsolatedLiability = false;
		this.withSpotIsolatedLiability = false;
	}

	/**
	 * Adds a signed collateral delta (deposit value or perp pnl, QUOTE_PRECISION 1e6) to
	 * the cross-margin book. When in `Liquidation` mode with a nonzero `crossMarginBuffer`
	 * and the delta is negative, also extends `totalCollateralBuffer` by
	 * `delta * crossMarginBuffer / MARGIN_PRECISION` so a negative-pnl position looks worse
	 * under the buffered (liquidation-eligibility) check than under the plain one.
	 * @param delta Signed collateral value to add, QUOTE_PRECISION (1e6).
	 */
	addCrossMarginTotalCollateral(delta: BN): void {
		const crossMarginBuffer = this.context.crossMarginBuffer;
		this.totalCollateral = this.totalCollateral.add(delta);
		if (crossMarginBuffer.gt(ZERO) && delta.isNeg()) {
			this.totalCollateralBuffer = this.totalCollateralBuffer.add(
				delta.mul(crossMarginBuffer).div(MARGIN_PRECISION)
			);
		}
	}

	/**
	 * Adds a position's margin requirement to the cross-margin book. When a nonzero
	 * `crossMarginBuffer` is configured, also accrues `marginRequirementPlusBuffer` with an
	 * extra `liabilityValue * crossMarginBuffer / MARGIN_PRECISION` on top, inflating the
	 * buffered requirement used for liquidation eligibility.
	 * @param marginRequirement Margin required for this position, QUOTE_PRECISION (1e6).
	 * @param liabilityValue Position's (worst-case) liability value the buffer is scaled from, QUOTE_PRECISION (1e6).
	 */
	addCrossMarginRequirement(marginRequirement: BN, liabilityValue: BN): void {
		const crossMarginBuffer = this.context.crossMarginBuffer;
		this.marginRequirement = this.marginRequirement.add(marginRequirement);
		if (crossMarginBuffer.gt(ZERO)) {
			this.marginRequirementPlusBuffer = this.marginRequirementPlusBuffer.add(
				marginRequirement.add(
					liabilityValue.mul(crossMarginBuffer).div(MARGIN_PRECISION)
				)
			);
		}
	}

	/**
	 * Records (or overwrites) the margin state for one isolated perp position, applying that
	 * market's isolated margin buffer (from `context.isolatedMarginBuffers`) to the
	 * buffered requirement, and to the buffered collateral only when `pnl` is negative —
	 * mirroring `addCrossMarginRequirement`/`addCrossMarginTotalCollateral` but scoped to a
	 * single isolated market instead of the shared cross-margin book.
	 * @param marketIndex Perp market index of the isolated position.
	 * @param depositValue Isolated collateral deposited into the position, QUOTE_PRECISION (1e6).
	 * @param pnl Position's unrealized/settled pnl, QUOTE_PRECISION (1e6, signed).
	 * @param liabilityValue Position's (worst-case) liability value the buffer is scaled from, QUOTE_PRECISION (1e6).
	 * @param marginRequirement Margin required to maintain/open the isolated position, QUOTE_PRECISION (1e6).
	 */
	addIsolatedMarginCalculation(
		marketIndex: number,
		depositValue: BN,
		pnl: BN,
		liabilityValue: BN,
		marginRequirement: BN
	): void {
		const totalCollateral = depositValue.add(pnl);
		const isolatedMarginBuffer =
			this.context.isolatedMarginBuffers.get(marketIndex) ?? ZERO;

		const totalCollateralBuffer =
			isolatedMarginBuffer.gt(ZERO) && pnl.isNeg()
				? pnl.mul(isolatedMarginBuffer).div(MARGIN_PRECISION)
				: ZERO;

		const marginRequirementPlusBuffer = isolatedMarginBuffer.gt(ZERO)
			? marginRequirement.add(
					liabilityValue.mul(isolatedMarginBuffer).div(MARGIN_PRECISION)
			  )
			: marginRequirement;

		const iso = new IsolatedMarginCalculation();
		iso.marginRequirement = marginRequirement;
		iso.totalCollateral = totalCollateral;
		iso.totalCollateralBuffer = totalCollateralBuffer;
		iso.marginRequirementPlusBuffer = marginRequirementPlusBuffer;
		this.isolatedMarginCalculations.set(marketIndex, iso);
	}

	/** Adds to the running total of worst-case perp liability value across all perp positions seen. @param perpLiabilityValue QUOTE_PRECISION (1e6). */
	addPerpLiabilityValue(perpLiabilityValue: BN): void {
		this.totalPerpLiabilityValue =
			this.totalPerpLiabilityValue.add(perpLiabilityValue);
	}

	/** Increments the count of spot positions counted as liabilities (borrows, or zero-balance positions with open orders). Call once per qualifying spot position. */
	addSpotLiability(): void {
		this.numSpotLiabilities += 1;
	}

	/** Increments the count of perp positions counted as liabilities (non-flat base, negative quote, or open orders). Call once per qualifying perp position. */
	addPerpLiability(): void {
		this.numPerpLiabilities += 1;
	}

	/** Latches `withSpotIsolatedLiability` to `true` if `isolated` is true (sticky OR — never reset to false once set). Pass whether the spot liability just added belongs to an `AssetTier::Isolated` market. */
	updateWithSpotIsolatedLiability(isolated: boolean): void {
		this.withSpotIsolatedLiability = this.withSpotIsolatedLiability || isolated;
	}

	/** Latches `withPerpIsolatedLiability` to `true` if `isolated` is true (sticky OR — never reset to false once set). Pass whether the perp liability just added belongs to a `ContractTier::Isolated` market. */
	updateWithPerpIsolatedLiability(isolated: boolean): void {
		this.withPerpIsolatedLiability = this.withPerpIsolatedLiability || isolated;
	}

	/** Total number of liability positions (spot borrows + perp liabilities) counted so far. */
	getNumOfLiabilities(): number {
		return this.numSpotLiabilities + this.numPerpLiabilities;
	}

	/** `totalCollateral + totalCollateralBuffer` for the cross-margin book, QUOTE_PRECISION (1e6). */
	getCrossTotalCollateralPlusBuffer(): BN {
		return this.totalCollateral.add(this.totalCollateralBuffer);
	}

	/** True if the cross-margin book's collateral covers its margin requirement (no buffer applied). */
	meetsCrossMarginRequirement(): boolean {
		return this.totalCollateral.gte(this.marginRequirement);
	}

	/** True if the cross-margin book's buffered collateral covers its buffered margin requirement — the check used for cross-margin liquidation eligibility. */
	meetsCrossMarginRequirementWithBuffer(): boolean {
		return this.getCrossTotalCollateralPlusBuffer().gte(
			this.marginRequirementPlusBuffer
		);
	}

	/** True only if the cross-margin book AND every tracked isolated position independently meet their (unbuffered) margin requirement. */
	meetsMarginRequirement(): boolean {
		if (!this.meetsCrossMarginRequirement()) return false;
		for (const [, iso] of this.isolatedMarginCalculations) {
			if (!iso.meetsMarginRequirement()) return false;
		}
		return true;
	}

	/** True only if the cross-margin book AND every tracked isolated position independently meet their buffered margin requirement — the overall liquidation-eligibility check. */
	meetsMarginRequirementWithBuffer(): boolean {
		if (!this.meetsCrossMarginRequirementWithBuffer()) return false;
		for (const [, iso] of this.isolatedMarginCalculations) {
			if (!iso.meetsMarginRequirementWithBuffer()) return false;
		}
		return true;
	}

	/** Cross-margin collateral in excess of its margin requirement, floored at zero, QUOTE_PRECISION (1e6). */
	getCrossFreeCollateral(): BN {
		const free = this.totalCollateral.sub(this.marginRequirement);
		return free.isNeg() ? ZERO : free;
	}

	/**
	 * Free (unbuffered) collateral for one isolated perp position, floored at zero, QUOTE_PRECISION (1e6).
	 * @param marketIndex Perp market index of the isolated position.
	 * @throws if no isolated margin calculation was recorded for `marketIndex` (call `addIsolatedMarginCalculation` first).
	 */
	getIsolatedFreeCollateral(marketIndex: number): BN {
		const iso = this.isolatedMarginCalculations.get(marketIndex);
		if (!iso)
			throw new Error('InvalidMarginCalculation: missing isolated calc');
		const free = iso.totalCollateral.sub(iso.marginRequirement);
		return free.isNeg() ? ZERO : free;
	}

	/** Returns the recorded `IsolatedMarginCalculation` for `marketIndex`, or `undefined` if none was recorded (the user has no isolated position in that market). */
	getIsolatedMarginCalculation(
		marketIndex: number
	): IsolatedMarginCalculation | undefined {
		return this.isolatedMarginCalculations.get(marketIndex);
	}

	/** True if an isolated margin calculation has been recorded for `marketIndex`. */
	hasIsolatedMarginCalculation(marketIndex: number): boolean {
		return this.isolatedMarginCalculations.has(marketIndex);
	}
}
