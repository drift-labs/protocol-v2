import { BN } from '@coral-xyz/anchor';
import {
	PRICE_PRECISION,
	LIQUIDATION_FEE_PRECISION,
	MARGIN_PRECISION,
	PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO,
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
