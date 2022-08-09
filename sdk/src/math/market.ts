import { BN } from '@project-serum/anchor';
import { MarketAccount, PositionDirection, MarginCategory } from '../types';
import {
	calculateAmmReservesAfterSwap,
	calculatePrice,
	calculateUpdatedAMMSpreadReserves,
	getSwapDirection,
	calculateUpdatedAMM,
} from './amm';
import {
	calculateSizeDiscountAssetWeight,
	calculateSizePremiumLiabilityWeight,
} from './margin';
import { OraclePriceData } from '../oracles/types';
import { calculateLiabilityWeight } from './bankBalance';
import { MARGIN_PRECISION } from '../constants/numericConstants';

/**
 * Calculates market mark price
 *
 * @param market
 * @return markPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateMarkPrice(
	market: MarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const newAmm = calculateUpdatedAMM(market.amm, oraclePriceData);
	return calculatePrice(
		newAmm.baseAssetReserve,
		newAmm.quoteAssetReserve,
		newAmm.pegMultiplier
	);
}

/**
 * Calculates market bid price
 *
 * @param market
 * @return bidPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateBidPrice(
	market: MarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const { baseAssetReserve, quoteAssetReserve, newPeg } =
		calculateUpdatedAMMSpreadReserves(
			market.amm,
			PositionDirection.SHORT,
			oraclePriceData
		);

	return calculatePrice(baseAssetReserve, quoteAssetReserve, newPeg);
}

/**
 * Calculates market ask price
 *
 * @param market
 * @return bidPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateAskPrice(
	market: MarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const { baseAssetReserve, quoteAssetReserve, newPeg } =
		calculateUpdatedAMMSpreadReserves(
			market.amm,
			PositionDirection.LONG,
			oraclePriceData
		);

	return calculatePrice(baseAssetReserve, quoteAssetReserve, newPeg);
}

export function calculateNewMarketAfterTrade(
	baseAssetAmount: BN,
	direction: PositionDirection,
	market: MarketAccount
): MarketAccount {
	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			'base',
			baseAssetAmount.abs(),
			getSwapDirection('base', direction)
		);

	const newAmm = Object.assign({}, market.amm);
	const newMarket = Object.assign({}, market);
	newMarket.amm = newAmm;
	newMarket.amm.quoteAssetReserve = newQuoteAssetReserve;
	newMarket.amm.baseAssetReserve = newBaseAssetReserve;

	return newMarket;
}

export function calculateMarkOracleSpread(
	market: MarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const markPrice = calculateMarkPrice(market, oraclePriceData);
	return calculateOracleSpread(markPrice, oraclePriceData);
}

export function calculateOracleSpread(
	price: BN,
	oraclePriceData: OraclePriceData
): BN {
	return price.sub(oraclePriceData.price);
}

export function calculateMarketMarginRatio(
	market: MarketAccount,
	size: BN,
	marginCategory: MarginCategory
): number {
	let marginRatio;
	switch (marginCategory) {
		case 'Initial':
			marginRatio = calculateSizePremiumLiabilityWeight(
				size,
				market.imfFactor,
				new BN(market.marginRatioInitial),
				MARGIN_PRECISION
			).toNumber();
			break;
		case 'Maintenance':
			marginRatio = market.marginRatioMaintenance;
			break;
	}

	return marginRatio;
}

export function calculateUnsettledAssetWeight(
	market: MarketAccount,
	unsettledPnl: BN,
	marginCategory: MarginCategory
): BN {
	let assetWeight: BN;

	switch (marginCategory) {
		case 'Initial':
			assetWeight = calculateSizeDiscountAssetWeight(
				unsettledPnl,
				market.unsettledImfFactor,
				new BN(market.unsettledInitialAssetWeight)
			);
			break;
		case 'Maintenance':
			assetWeight = new BN(market.unsettledMaintenanceAssetWeight);
			break;
	}

	return assetWeight;
}
