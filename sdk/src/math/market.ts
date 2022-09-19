import { BN } from '@project-serum/anchor';
import {
	PerpMarketAccount,
	PositionDirection,
	MarginCategory,
	SpotMarketAccount,
	SpotBalanceType,
} from '../types';
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
import {
	BASE_PRECISION,
	MARGIN_PRECISION,
	PRICE_TO_QUOTE_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { getTokenAmount } from './spotBalance';

/**
 * Calculates market mark price
 *
 * @param market
 * @return markPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateMarkPrice(
	market: PerpMarketAccount,
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
	market: PerpMarketAccount,
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
 * @return askPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateAskPrice(
	market: PerpMarketAccount,
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
	market: PerpMarketAccount
): PerpMarketAccount {
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
	market: PerpMarketAccount,
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
	market: PerpMarketAccount,
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

export function calculateUnrealizedAssetWeight(
	market: PerpMarketAccount,
	quoteSpotMarket: SpotMarketAccount,
	unrealizedPnl: BN,
	marginCategory: MarginCategory,
	oraclePriceData: OraclePriceData
): BN {
	let assetWeight: BN;
	switch (marginCategory) {
		case 'Initial':
			assetWeight = new BN(market.unrealizedInitialAssetWeight);

			if (market.unrealizedMaxImbalance.gt(ZERO)) {
				const netUnsettledPnl = calculateNetUserImbalance(
					market,
					quoteSpotMarket,
					oraclePriceData
				);
				if (netUnsettledPnl.gt(market.unrealizedMaxImbalance)) {
					assetWeight = assetWeight
						.mul(market.unrealizedMaxImbalance)
						.div(netUnsettledPnl);
				}
			}

			assetWeight = calculateSizeDiscountAssetWeight(
				unrealizedPnl,
				market.unrealizedImfFactor,
				assetWeight
			);
			break;
		case 'Maintenance':
			assetWeight = new BN(market.unrealizedMaintenanceAssetWeight);
			break;
	}

	return assetWeight;
}

export function calculateMarketAvailablePNL(
	perpMarket: PerpMarketAccount,
	spotMarket: SpotMarketAccount
): BN {
	return getTokenAmount(
		perpMarket.pnlPool.balance,
		spotMarket,
		SpotBalanceType.DEPOSIT
	);
}

export function calculateNetUserImbalance(
	market: PerpMarketAccount,
	bank: SpotMarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const netUserPositionValue = market.amm.netBaseAssetAmount
		.mul(oraclePriceData.price)
		.div(BASE_PRECISION)
		.div(PRICE_TO_QUOTE_PRECISION);

	const netUserCostBasis = market.amm.quoteAssetAmountLong
		.add(market.amm.quoteAssetAmountShort)
		.sub(market.amm.cumulativeSocialLoss);

	const userEntitledPnl = netUserPositionValue.add(netUserCostBasis);

	const pnlPool = getTokenAmount(
		market.pnlPool.balance,
		bank,
		SpotBalanceType.DEPOSIT
	);

	const imbalance = userEntitledPnl.sub(pnlPool);

	return imbalance;
}
