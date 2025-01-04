import { BN } from '@coral-xyz/anchor';
import {
	PRICE_PRECISION,
	LIQUIDATION_FEE_PRECISION,
	MARGIN_PRECISION,
	PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO,
	QUOTE_PRECISION,
	LIQUIDATION_PCT_PRECISION,
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
