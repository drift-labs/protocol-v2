import { BN } from '@coral-xyz/anchor';
import {
	PRICE_PRECISION,
	LIQUIDATION_FEE_PRECISION,
	MARGIN_PRECISION,
	PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO,
	QUOTE_PRECISION,
	LIQUIDATION_PCT_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	TEN,
	ONE,
} from '../constants/numericConstants';

export function calculateBaseAssetAmountToCoverMarginShortage(
	marginShortage: BN,
	marginRatio: number,
	liquidationFee: number,
	ifLiquidationFee: number,
	oraclePrice: BN,
	quoteOraclePrice: BN
): BN | undefined {
	const marginRatioBN = new BN(marginRatio)
		.mul(LIQUIDATION_FEE_PRECISION)
		.div(MARGIN_PRECISION);
	const liquidationFeeBN = new BN(liquidationFee);

	if (oraclePrice.eq(new BN(0)) || marginRatioBN.lte(liquidationFeeBN)) {
		// undefined is max
		return undefined;
	}

	return marginShortage.mul(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO).div(
		oraclePrice
			.mul(quoteOraclePrice)
			.div(PRICE_PRECISION)
			.mul(marginRatioBN.sub(liquidationFeeBN))
			.div(LIQUIDATION_FEE_PRECISION)
			.sub(
				oraclePrice.mul(new BN(ifLiquidationFee)).div(LIQUIDATION_FEE_PRECISION)
			)
	);
}

export function calculateLiabilityTransferToCoverMarginShortage(
	marginShortage: BN,
	assetWeight: number,
	assetLiquidationMultiplier: number,
	liabilityWeight: number,
	liabilityLiquidationMultiplier: number,
	liabilityDecimals: number,
	liabilityPrice: BN,
	ifLiquidationFee: number
): BN | undefined {
	if (assetWeight >= liabilityWeight) {
		// undefined is max
		return undefined;
	}

	let numeratorScale: BN;
	let denominatorScale: BN;
	if (liabilityDecimals > 6) {
		numeratorScale = new BN(10).pow(new BN(liabilityDecimals - 6));
		denominatorScale = new BN(1);
	} else {
		numeratorScale = new BN(1);
		denominatorScale = new BN(10).pow(new BN(6 - liabilityDecimals));
	}

	// multiply market weights by extra 10 to increase precision
	const liabilityWeightComponent = liabilityWeight * 10;
	const assetWeightComponent =
		(assetWeight * 10 * assetLiquidationMultiplier) /
		liabilityLiquidationMultiplier;

	if (assetWeightComponent >= liabilityWeightComponent) {
		return undefined;
	}

	return BN.max(
		marginShortage
			.mul(numeratorScale)
			.mul(PRICE_PRECISION.mul(SPOT_MARKET_WEIGHT_PRECISION).mul(TEN))
			.div(
				liabilityPrice
					.mul(
						new BN(liabilityWeightComponent).sub(new BN(assetWeightComponent))
					)
					.sub(
						liabilityPrice
							.mul(new BN(ifLiquidationFee))
							.div(LIQUIDATION_FEE_PRECISION)
							.mul(new BN(liabilityWeight))
							.mul(new BN(10))
					)
			)
			.div(denominatorScale),
		ONE
	);
}

export function calculateAssetTransferForLiabilityTransfer(
	assetAmount: BN,
	assetLiquidationMultiplier: number,
	assetDecimals: number,
	assetPrice: BN,
	liabilityAmount: BN,
	liabilityLiquidationMultiplier: number,
	liabilityDecimals: number,
	liabilityPrice: BN
): BN | undefined {
	let numeratorScale: BN;
	let denominatorScale: BN;
	if (assetDecimals > liabilityDecimals) {
		numeratorScale = new BN(10).pow(new BN(assetDecimals - liabilityDecimals));
		denominatorScale = new BN(1);
	} else {
		numeratorScale = new BN(1);
		denominatorScale = new BN(10).pow(
			new BN(liabilityDecimals - assetDecimals)
		);
	}

	let assetTransfer = liabilityAmount
		.mul(numeratorScale)
		.mul(liabilityPrice)
		.mul(new BN(assetLiquidationMultiplier))
		.div(assetPrice.mul(new BN(liabilityLiquidationMultiplier)))
		.div(denominatorScale);
	assetTransfer = BN.max(assetTransfer, ONE);

	// Need to check if asset_transfer should be rounded to asset amount
	let assetValueNumeratorScale: BN;
	let assetValueDenominatorScale: BN;
	if (assetDecimals > 6) {
		assetValueNumeratorScale = new BN(10).pow(new BN(assetDecimals - 6));
		assetValueDenominatorScale = new BN(1);
	} else {
		assetValueNumeratorScale = new BN(1);
		assetValueDenominatorScale = new BN(10).pow(new BN(6 - assetDecimals));
	}

	let assetDelta: BN;
	if (assetTransfer > assetAmount) {
		assetDelta = assetTransfer.sub(assetAmount);
	} else {
		assetDelta = assetAmount.sub(assetTransfer);
	}

	const assetValueDelta = assetDelta
		.mul(assetPrice)
		.div(PRICE_PRECISION)
		.mul(assetValueNumeratorScale)
		.div(assetValueDenominatorScale);

	if (assetValueDelta.lt(QUOTE_PRECISION)) {
		assetTransfer = assetAmount;
	}

	return assetTransfer;
}

export function calculateMaxPctToLiquidate(
	userLastActiveSlot: BN,
	userLiquidationMarginFreed: BN,
	marginShortage: BN,
	slot: BN,
	initialPctToLiquidate: BN,
	liquidationDuration: BN
): BN {
	// if margin shortage is tiny, accelerate liquidation
	if (marginShortage.lt(new BN(50).mul(QUOTE_PRECISION))) {
		return LIQUIDATION_PCT_PRECISION;
	}

	let slotsElapsed;
	if (userLiquidationMarginFreed.gt(new BN(0))) {
		slotsElapsed = BN.max(slot.sub(userLastActiveSlot), new BN(0));
	} else {
		slotsElapsed = new BN(0);
	}

	const pctFreeable = BN.min(
		slotsElapsed
			.mul(LIQUIDATION_PCT_PRECISION)
			.div(liquidationDuration) // ~ 1 minute if per slot is 400ms
			.add(initialPctToLiquidate),
		LIQUIDATION_PCT_PRECISION
	);

	const totalMarginShortage = marginShortage.add(userLiquidationMarginFreed);
	const maxMarginFreed = totalMarginShortage
		.mul(pctFreeable)
		.div(LIQUIDATION_PCT_PRECISION);
	const marginFreeable = BN.max(
		maxMarginFreed.sub(userLiquidationMarginFreed),
		new BN(0)
	);

	return marginFreeable.mul(LIQUIDATION_PCT_PRECISION).div(marginShortage);
}

export function getMarginShortage(
	maintenanceMarginRequirementPlusBuffer: BN,
	maintenanceTotalCollateral: BN
): BN {
	return maintenanceMarginRequirementPlusBuffer
		.sub(maintenanceTotalCollateral)
		.abs();
}
