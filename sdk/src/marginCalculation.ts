import { BN } from '@coral-xyz/anchor';
import { MARGIN_PRECISION } from './constants/numericConstants';
import { MarketType } from './types';

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
			this.marketType === other.marketType &&
			this.marketIndex === other.marketIndex
		);
	}
}

export class MarginContext {
	marginType: MarginCategory;
	mode: MarginCalculationMode;
	strict: boolean;
	ignoreInvalidDepositOracles: boolean;
	marginBuffer: BN; // scaled by MARGIN_PRECISION
	marginRatioOverride?: number;

	private constructor(marginType: MarginCategory) {
		this.marginType = marginType;
		this.mode = { type: 'Standard' };
		this.strict = false;
		this.ignoreInvalidDepositOracles = false;
		this.marginBuffer = new BN(0);
	}

	static standard(marginType: MarginCategory): MarginContext {
		return new MarginContext(marginType);
	}

	static liquidation(marginBuffer: BN): MarginContext {
		const ctx = new MarginContext('Maintenance');
		ctx.mode = { type: 'Liquidation' };
		ctx.marginBuffer = marginBuffer ?? new BN(0);
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

	setMarginBuffer(buffer?: BN): this {
		this.marginBuffer = buffer ?? new BN(0);
		return this;
	}

	setMarginRatioOverride(ratio: number): this {
		this.marginRatioOverride = ratio;
		return this;
	}
}

export class IsolatedMarginCalculation {
	marginRequirement: BN;
	totalCollateral: BN; // deposit + pnl
	totalCollateralBuffer: BN;
	marginRequirementPlusBuffer: BN;

	constructor() {
		this.marginRequirement = new BN(0);
		this.totalCollateral = new BN(0);
		this.totalCollateralBuffer = new BN(0);
		this.marginRequirementPlusBuffer = new BN(0);
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
		return shortage.isNeg() ? new BN(0) : shortage;
	}
}

export class MarginCalculation {
	context: MarginContext;
	totalCollateral: BN;
	totalCollateralBuffer: BN;
	marginRequirement: BN;
	marginRequirementPlusBuffer: BN;
	isolatedMarginCalculations: Map<number, IsolatedMarginCalculation>;
	numSpotLiabilities: number;
	numPerpLiabilities: number;
	allDepositOraclesValid: boolean;
	allLiabilityOraclesValid: boolean;
	withPerpIsolatedLiability: boolean;
	withSpotIsolatedLiability: boolean;
	totalSpotLiabilityValue: BN;
	totalPerpLiabilityValue: BN;
	trackedMarketMarginRequirement: BN;
	fuelDeposits: number;
	fuelBorrows: number;
	fuelPositions: number;

	constructor(context: MarginContext) {
		this.context = context;
		this.totalCollateral = new BN(0);
		this.totalCollateralBuffer = new BN(0);
		this.marginRequirement = new BN(0);
		this.marginRequirementPlusBuffer = new BN(0);
		this.isolatedMarginCalculations = new Map();
		this.numSpotLiabilities = 0;
		this.numPerpLiabilities = 0;
		this.allDepositOraclesValid = true;
		this.allLiabilityOraclesValid = true;
		this.withPerpIsolatedLiability = false;
		this.withSpotIsolatedLiability = false;
		this.totalSpotLiabilityValue = new BN(0);
		this.totalPerpLiabilityValue = new BN(0);
		this.trackedMarketMarginRequirement = new BN(0);
		this.fuelDeposits = 0;
		this.fuelBorrows = 0;
		this.fuelPositions = 0;
	}

	addCrossMarginTotalCollateral(delta: BN): void {
		this.totalCollateral = this.totalCollateral.add(delta);
		if (this.context.marginBuffer.gt(new BN(0)) && delta.isNeg()) {
			this.totalCollateralBuffer = this.totalCollateralBuffer.add(
				delta.mul(this.context.marginBuffer).div(MARGIN_PRECISION)
			);
		}
	}

	addCrossMarginRequirement(marginRequirement: BN, liabilityValue: BN): void {
		this.marginRequirement = this.marginRequirement.add(marginRequirement);
		if (this.context.marginBuffer.gt(new BN(0))) {
			this.marginRequirementPlusBuffer = this.marginRequirementPlusBuffer.add(
				marginRequirement.add(
					liabilityValue.mul(this.context.marginBuffer).div(MARGIN_PRECISION)
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
		const totalCollateralBuffer =
			this.context.marginBuffer.gt(new BN(0)) && pnl.isNeg()
				? pnl.mul(this.context.marginBuffer).div(MARGIN_PRECISION)
				: new BN(0);

		const marginRequirementPlusBuffer = this.context.marginBuffer.gt(new BN(0))
			? marginRequirement.add(
					liabilityValue.mul(this.context.marginBuffer).div(MARGIN_PRECISION)
			  )
			: new BN(0);

		const iso = new IsolatedMarginCalculation();
		iso.marginRequirement = marginRequirement;
		iso.totalCollateral = totalCollateral;
		iso.totalCollateralBuffer = totalCollateralBuffer;
		iso.marginRequirementPlusBuffer = marginRequirementPlusBuffer;
		this.isolatedMarginCalculations.set(marketIndex, iso);
	}

	addSpotLiability(): void {
		this.numSpotLiabilities += 1;
	}

	addPerpLiability(): void {
		this.numPerpLiabilities += 1;
	}

	addSpotLiabilityValue(spotLiabilityValue: BN): void {
		this.totalSpotLiabilityValue =
			this.totalSpotLiabilityValue.add(spotLiabilityValue);
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

	validateNumSpotLiabilities(): void {
		if (this.numSpotLiabilities > 0 && this.marginRequirement.eq(new BN(0))) {
			throw new Error(
				'InvalidMarginRatio: num_spot_liabilities>0 but margin_requirement=0'
			);
		}
	}

	getNumOfLiabilities(): number {
		return this.numSpotLiabilities + this.numPerpLiabilities;
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
		return free.isNeg() ? new BN(0) : free;
	}

	getIsolatedFreeCollateral(marketIndex: number): BN {
		const iso = this.isolatedMarginCalculations.get(marketIndex);
		if (!iso)
			throw new Error('InvalidMarginCalculation: missing isolated calc');
		const free = iso.totalCollateral.sub(iso.marginRequirement);
		return free.isNeg() ? new BN(0) : free;
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
