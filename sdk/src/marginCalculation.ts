import { BN } from '@coral-xyz/anchor';
import { MARGIN_PRECISION, ZERO } from './constants/numericConstants';
import { getVariant, isVariant, MarketType } from './types';

export type MarginCategory = 'Initial' | 'Maintenance' | 'Fill';

export type MarginCalculationMode =
	| { type: 'Standard' }
	| { type: 'Liquidation' };

export class MarketIdentifier {
	marketType: MarketType;
	marketIndex: number;

	private constructor(marketType: MarketType, marketIndex: number) {
		this.marketType = marketType;
		this.marketIndex = marketIndex;
	}

	static spot(marketIndex: number): MarketIdentifier {
		return new MarketIdentifier(MarketType.SPOT, marketIndex);
	}

	static perp(marketIndex: number): MarketIdentifier {
		return new MarketIdentifier(MarketType.PERP, marketIndex);
	}

	equals(other: MarketIdentifier | undefined): boolean {
		return (
			!!other &&
			isVariant(this.marketType, getVariant(other.marketType)) &&
			this.marketIndex === other.marketIndex
		);
	}
}

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
	}

	static standard(marginType: MarginCategory): MarginContext {
		return new MarginContext(marginType);
	}

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

	strictMode(strict: boolean): this {
		this.strict = strict;
		return this;
	}

	ignoreInvalidDeposits(ignore: boolean): this {
		this.ignoreInvalidDepositOracles = ignore;
		return this;
	}

	setCrossMarginBuffer(crossMarginBuffer: BN): this {
		this.crossMarginBuffer = crossMarginBuffer;
		return this;
	}
	setIsolatedMarginBuffers(isolatedMarginBuffers: Map<number, BN>): this {
		this.isolatedMarginBuffers = isolatedMarginBuffers;
		return this;
	}
	setIsolatedMarginBuffer(marketIndex: number, isolatedMarginBuffer: BN): this {
		this.isolatedMarginBuffers.set(marketIndex, isolatedMarginBuffer);
		return this;
	}
}

export class IsolatedMarginCalculation {
	marginRequirement: BN;
	totalCollateral: BN; // deposit + pnl
	totalCollateralBuffer: BN;
	marginRequirementPlusBuffer: BN;

	constructor() {
		this.marginRequirement = ZERO;
		this.totalCollateral = ZERO;
		this.totalCollateralBuffer = ZERO;
		this.marginRequirementPlusBuffer = ZERO;
	}

	getTotalCollateralPlusBuffer(): BN {
		return this.totalCollateral.add(this.totalCollateralBuffer);
	}

	meetsMarginRequirement(): boolean {
		return this.totalCollateral.gte(this.marginRequirement);
	}

	meetsMarginRequirementWithBuffer(): boolean {
		return this.getTotalCollateralPlusBuffer().gte(
			this.marginRequirementPlusBuffer
		);
	}

	marginShortage(): BN {
		const shortage = this.marginRequirementPlusBuffer.sub(
			this.getTotalCollateralPlusBuffer()
		);
		return shortage.isNeg() ? ZERO : shortage;
	}
}

export class MarginCalculation {
	context: MarginContext;
	totalCollateral: BN;
	totalCollateralBuffer: BN;
	marginRequirement: BN;
	marginRequirementPlusBuffer: BN;
	isolatedMarginCalculations: Map<number, IsolatedMarginCalculation>;
	allDepositOraclesValid: boolean;
	allLiabilityOraclesValid: boolean;
	withPerpIsolatedLiability: boolean;
	withSpotIsolatedLiability: boolean;
	totalPerpLiabilityValue: BN;
	trackedMarketMarginRequirement: BN;
	fuelDeposits: number;
	fuelBorrows: number;
	fuelPositions: number;

	constructor(context: MarginContext) {
		this.context = context;
		this.totalCollateral = ZERO;
		this.totalCollateralBuffer = ZERO;
		this.marginRequirement = ZERO;
		this.marginRequirementPlusBuffer = ZERO;
		this.isolatedMarginCalculations = new Map();
		this.allDepositOraclesValid = true;
		this.allLiabilityOraclesValid = true;
		this.withPerpIsolatedLiability = false;
		this.withSpotIsolatedLiability = false;
		this.totalPerpLiabilityValue = ZERO;
		this.trackedMarketMarginRequirement = ZERO;
		this.fuelDeposits = 0;
		this.fuelBorrows = 0;
		this.fuelPositions = 0;
	}

	addCrossMarginTotalCollateral(delta: BN): void {
		const crossMarginBuffer = this.context.crossMarginBuffer;
		this.totalCollateral = this.totalCollateral.add(delta);
		if (crossMarginBuffer.gt(ZERO) && delta.isNeg()) {
			this.totalCollateralBuffer = this.totalCollateralBuffer.add(
				delta.mul(crossMarginBuffer).div(MARGIN_PRECISION)
			);
		}
	}

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

	addPerpLiabilityValue(perpLiabilityValue: BN): void {
		this.totalPerpLiabilityValue =
			this.totalPerpLiabilityValue.add(perpLiabilityValue);
	}

	updateAllDepositOraclesValid(valid: boolean): void {
		this.allDepositOraclesValid = this.allDepositOraclesValid && valid;
	}

	updateAllLiabilityOraclesValid(valid: boolean): void {
		this.allLiabilityOraclesValid = this.allLiabilityOraclesValid && valid;
	}

	updateWithSpotIsolatedLiability(isolated: boolean): void {
		this.withSpotIsolatedLiability = this.withSpotIsolatedLiability || isolated;
	}

	updateWithPerpIsolatedLiability(isolated: boolean): void {
		this.withPerpIsolatedLiability = this.withPerpIsolatedLiability || isolated;
	}

	getCrossTotalCollateralPlusBuffer(): BN {
		return this.totalCollateral.add(this.totalCollateralBuffer);
	}

	meetsCrossMarginRequirement(): boolean {
		return this.totalCollateral.gte(this.marginRequirement);
	}

	meetsCrossMarginRequirementWithBuffer(): boolean {
		return this.getCrossTotalCollateralPlusBuffer().gte(
			this.marginRequirementPlusBuffer
		);
	}

	meetsMarginRequirement(): boolean {
		if (!this.meetsCrossMarginRequirement()) return false;
		for (const [, iso] of this.isolatedMarginCalculations) {
			if (!iso.meetsMarginRequirement()) return false;
		}
		return true;
	}

	meetsMarginRequirementWithBuffer(): boolean {
		if (!this.meetsCrossMarginRequirementWithBuffer()) return false;
		for (const [, iso] of this.isolatedMarginCalculations) {
			if (!iso.meetsMarginRequirementWithBuffer()) return false;
		}
		return true;
	}

	getCrossFreeCollateral(): BN {
		const free = this.totalCollateral.sub(this.marginRequirement);
		return free.isNeg() ? ZERO : free;
	}

	getIsolatedFreeCollateral(marketIndex: number): BN {
		const iso = this.isolatedMarginCalculations.get(marketIndex);
		if (!iso)
			throw new Error('InvalidMarginCalculation: missing isolated calc');
		const free = iso.totalCollateral.sub(iso.marginRequirement);
		return free.isNeg() ? ZERO : free;
	}

	getIsolatedMarginCalculation(
		marketIndex: number
	): IsolatedMarginCalculation | undefined {
		return this.isolatedMarginCalculations.get(marketIndex);
	}

	hasIsolatedMarginCalculation(marketIndex: number): boolean {
		return this.isolatedMarginCalculations.has(marketIndex);
	}
}
