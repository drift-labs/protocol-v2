import { BN } from '@coral-xyz/anchor';
import {
	PerpMarketAccount,
	PositionDirection,
	MarginCategory,
	SpotMarketAccount,
	SpotBalanceType,
	MarketType,
	isVariant,
} from '../types';
import {
	calculateAmmReservesAfterSwap,
	calculatePrice,
	calculateUpdatedAMMSpreadReserves,
	getSwapDirection,
	calculateUpdatedAMM,
	calculateMarketOpenBidAsk,
} from './amm';
import {
	calculateSizeDiscountAssetWeight,
	calculateSizePremiumLiabilityWeight,
	calcHighLeverageModeInitialMarginRatioFromSize,
} from './margin';
import { MMOraclePriceData, OraclePriceData } from '../oracles/types';
import {
	BASE_PRECISION,
	MARGIN_PRECISION,
	PRICE_TO_QUOTE_PRECISION,
	ZERO,
	QUOTE_SPOT_MARKET_INDEX,
	PRICE_PRECISION,
	PERCENTAGE_PRECISION,
	FUNDING_RATE_PRECISION,
} from '../constants/numericConstants';
import { getTokenAmount } from './spotBalance';
import { DLOB } from '../dlob/DLOB';
import { assert } from '../assert/assert';

/**
 * Calculates market mark price
 *
 * @param market
 * @return markPrice : Precision PRICE_PRECISION
 */
export function calculateReservePrice(
	market: PerpMarketAccount,
	mmOraclePriceData: MMOraclePriceData
): BN {
	const newAmm = calculateUpdatedAMM(market.amm, mmOraclePriceData);
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
 * @return bidPrice : Precision PRICE_PRECISION
 */
export function calculateBidPrice(
	market: PerpMarketAccount,
	mmOraclePriceData: MMOraclePriceData,
	latestSlot?: BN
): BN {
	const { baseAssetReserve, quoteAssetReserve, newPeg } =
		calculateUpdatedAMMSpreadReserves(
			market.amm,
			PositionDirection.SHORT,
			mmOraclePriceData,
			undefined,
			latestSlot
		);

	return calculatePrice(baseAssetReserve, quoteAssetReserve, newPeg);
}

/**
 * Calculates market ask price
 *
 * @param market
 * @return askPrice : Precision PRICE_PRECISION
 */
export function calculateAskPrice(
	market: PerpMarketAccount,
	mmOraclePriceData: MMOraclePriceData,
	latestSlot?: BN
): BN {
	const { baseAssetReserve, quoteAssetReserve, newPeg } =
		calculateUpdatedAMMSpreadReserves(
			market.amm,
			PositionDirection.LONG,
			mmOraclePriceData,
			undefined,
			latestSlot
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

export function calculateOracleReserveSpread(
	market: PerpMarketAccount,
	mmOraclePriceData: MMOraclePriceData
): BN {
	const reservePrice = calculateReservePrice(market, mmOraclePriceData);
	return calculateOracleSpread(reservePrice, mmOraclePriceData);
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
	marginCategory: MarginCategory,
	customMarginRatio = 0,
	userHighLeverageMode = false
): number {
	if (market.status === 'Settlement') return 0;

	const isHighLeverageUser =
		userHighLeverageMode &&
		market.highLeverageMarginRatioInitial > 0 &&
		market.highLeverageMarginRatioMaintenance > 0;

	const marginRatioInitial = isHighLeverageUser
		? market.highLeverageMarginRatioInitial
		: market.marginRatioInitial;

	const marginRatioMaintenance = isHighLeverageUser
		? market.highLeverageMarginRatioMaintenance
		: market.marginRatioMaintenance;

	let defaultMarginRatio: number;
	switch (marginCategory) {
		case 'Initial':
			defaultMarginRatio = marginRatioInitial;
			break;
		case 'Maintenance':
			defaultMarginRatio = marginRatioMaintenance;
			break;
		default:
			throw new Error('Invalid margin category');
	}

	let marginRatio: number;

	if (isHighLeverageUser && marginCategory !== 'Maintenance') {
		// Use ordinary-mode initial/fill ratios for size-adjusted calc
		let preSizeAdjMarginRatio: number;
		switch (marginCategory) {
			case 'Initial':
				preSizeAdjMarginRatio = market.marginRatioInitial;
				break;
			default:
				preSizeAdjMarginRatio = marginRatioMaintenance;
				break;
		}

		const sizeAdjMarginRatio = calculateSizePremiumLiabilityWeight(
			size,
			new BN(market.imfFactor),
			new BN(preSizeAdjMarginRatio),
			MARGIN_PRECISION,
			false
		).toNumber();

		marginRatio = calcHighLeverageModeInitialMarginRatioFromSize(
			new BN(preSizeAdjMarginRatio),
			new BN(sizeAdjMarginRatio),
			new BN(defaultMarginRatio)
		).toNumber();
	} else {
		const sizeAdjMarginRatio = calculateSizePremiumLiabilityWeight(
			size,
			new BN(market.imfFactor),
			new BN(defaultMarginRatio),
			MARGIN_PRECISION,
			true
		).toNumber();

		marginRatio = Math.max(defaultMarginRatio, sizeAdjMarginRatio);
	}

	if (marginCategory === 'Initial') {
		marginRatio = Math.max(marginRatio, customMarginRatio);
	}

	return marginRatio;
}

export function calculateUnrealizedAssetWeight(
	market: PerpMarketAccount,
	quoteSpotMarket: SpotMarketAccount,
	unrealizedPnl: BN,
	marginCategory: MarginCategory,
	oraclePriceData: Pick<OraclePriceData, 'price'>
): BN {
	let assetWeight: BN;
	switch (marginCategory) {
		case 'Initial':
			assetWeight = new BN(market.unrealizedPnlInitialAssetWeight);

			if (market.unrealizedPnlMaxImbalance.gt(ZERO)) {
				const netUnsettledPnl = calculateNetUserPnlImbalance(
					market,
					quoteSpotMarket,
					oraclePriceData
				);
				if (netUnsettledPnl.gt(market.unrealizedPnlMaxImbalance)) {
					assetWeight = assetWeight
						.mul(market.unrealizedPnlMaxImbalance)
						.div(netUnsettledPnl);
				}
			}

			assetWeight = calculateSizeDiscountAssetWeight(
				unrealizedPnl,
				new BN(market.unrealizedPnlImfFactor),
				assetWeight
			);
			break;
		case 'Maintenance':
			assetWeight = new BN(market.unrealizedPnlMaintenanceAssetWeight);
			break;
	}

	return assetWeight;
}

export function calculateMarketAvailablePNL(
	perpMarket: PerpMarketAccount,
	spotMarket: SpotMarketAccount
): BN {
	return getTokenAmount(
		perpMarket.pnlPool.scaledBalance,
		spotMarket,
		SpotBalanceType.DEPOSIT
	);
}

export function calculateMarketMaxAvailableInsurance(
	perpMarket: PerpMarketAccount,
	spotMarket: SpotMarketAccount
): BN {
	assert(spotMarket.marketIndex == QUOTE_SPOT_MARKET_INDEX);

	// todo: insuranceFundAllocation technically not guaranteed to be in Insurance Fund
	const insuranceFundAllocation =
		perpMarket.insuranceClaim.quoteMaxInsurance.sub(
			perpMarket.insuranceClaim.quoteSettledInsurance
		);
	const ammFeePool = getTokenAmount(
		perpMarket.amm.feePool.scaledBalance,
		spotMarket,
		SpotBalanceType.DEPOSIT
	);
	return insuranceFundAllocation.add(ammFeePool);
}

export function calculateNetUserPnl(
	perpMarket: PerpMarketAccount,
	oraclePriceData: Pick<OraclePriceData, 'price'>
): BN {
	const netUserPositionValue = perpMarket.amm.baseAssetAmountWithAmm
		.add(perpMarket.amm.baseAssetAmountWithUnsettledLp)
		.mul(oraclePriceData.price)
		.div(BASE_PRECISION)
		.div(PRICE_TO_QUOTE_PRECISION);

	const netUserCostBasis = perpMarket.amm.quoteAssetAmount
		.add(perpMarket.amm.quoteAssetAmountWithUnsettledLp)
		.add(perpMarket.amm.netUnsettledFundingPnl);

	const netUserPnl = netUserPositionValue.add(netUserCostBasis);

	return netUserPnl;
}

export function calculateNetUserPnlImbalance(
	perpMarket: PerpMarketAccount,
	spotMarket: SpotMarketAccount,
	oraclePriceData: Pick<OraclePriceData, 'price'>,
	applyFeePoolDiscount = true
): BN {
	const netUserPnl = calculateNetUserPnl(perpMarket, oraclePriceData);

	const pnlPool = getTokenAmount(
		perpMarket.pnlPool.scaledBalance,
		spotMarket,
		SpotBalanceType.DEPOSIT
	);
	let feePool = getTokenAmount(
		perpMarket.amm.feePool.scaledBalance,
		spotMarket,
		SpotBalanceType.DEPOSIT
	);
	if (applyFeePoolDiscount) {
		feePool = feePool.div(new BN(5));
	}

	const imbalance = netUserPnl.sub(pnlPool.add(feePool));

	return imbalance;
}

export function calculateAvailablePerpLiquidity(
	market: PerpMarketAccount,
	mmOraclePriceData: MMOraclePriceData,
	dlob: DLOB,
	slot: number
): { bids: BN; asks: BN } {
	let [bids, asks] = calculateMarketOpenBidAsk(
		market.amm.baseAssetReserve,
		market.amm.minBaseAssetReserve,
		market.amm.maxBaseAssetReserve,
		market.amm.orderStepSize
	);

	asks = asks.abs();

	for (const bid of dlob.getRestingLimitBids(
		market.marketIndex,
		slot,
		MarketType.PERP,
		mmOraclePriceData
	)) {
		bids = bids.add(
			bid.order.baseAssetAmount.sub(bid.order.baseAssetAmountFilled)
		);
	}

	for (const ask of dlob.getRestingLimitAsks(
		market.marketIndex,
		slot,
		MarketType.PERP,
		mmOraclePriceData
	)) {
		asks = asks.add(
			ask.order.baseAssetAmount.sub(ask.order.baseAssetAmountFilled)
		);
	}

	return {
		bids: bids,
		asks: asks,
	};
}

export function calculatePerpMarketBaseLiquidatorFee(
	market: PerpMarketAccount,
	userHighLeverageMode: boolean
): number {
	if (userHighLeverageMode && market.highLeverageMarginRatioMaintenance > 0) {
		const marginRatio = market.highLeverageMarginRatioMaintenance * 100;
		// min(liquidator_fee, .8 * high_leverage_margin_ratio_maintenance)
		return Math.min(
			market.liquidatorFee,
			marginRatio - Math.floor(marginRatio / 5)
		);
	} else {
		return market.liquidatorFee;
	}
}

/**
 * Calculates trigger price for a perp market based on oracle price and current time
 * Implements the same logic as the Rust get_trigger_price function
 *
 * @param market - The perp market account
 * @param oraclePrice - Current oracle price (precision: PRICE_PRECISION)
 * @param now - Current timestamp in seconds
 * @returns trigger price (precision: PRICE_PRECISION)
 */
export function getTriggerPrice(
	market: PerpMarketAccount,
	oraclePrice: BN,
	now: BN,
	useMedianPrice: boolean
): BN {
	if (!useMedianPrice) {
		return oraclePrice.abs();
	}

	const lastFillPrice = market.lastFillPrice;

	// Calculate 5-minute basis
	const markPrice5minTwap = market.amm.lastMarkPriceTwap5Min;
	const lastOraclePriceTwap5min =
		market.amm.historicalOracleData.lastOraclePriceTwap5Min;
	const basis5min = markPrice5minTwap.sub(lastOraclePriceTwap5min);

	const oraclePlusBasis5min = oraclePrice.add(basis5min);

	// Calculate funding basis
	const lastFundingBasis = getLastFundingBasis(market, oraclePrice, now);
	const oraclePlusFundingBasis = oraclePrice.add(lastFundingBasis);

	const prices = [
		lastFillPrice.gt(ZERO) ? lastFillPrice : oraclePrice,
		oraclePlusFundingBasis,
		oraclePlusBasis5min,
	].sort((a, b) => a.cmp(b));
	const medianPrice = prices[1];

	return clampTriggerPrice(market, oraclePrice.abs(), medianPrice);
}

/**
 * Calculates the last funding basis for trigger price calculation
 * Implements the same logic as the Rust get_last_funding_basis function
 */
function getLastFundingBasis(
	market: PerpMarketAccount,
	oraclePrice: BN,
	now: BN
): BN {
	if (market.amm.lastFundingOracleTwap.gt(ZERO)) {
		const lastFundingRate = market.amm.lastFundingRate
			.mul(PRICE_PRECISION)
			.div(market.amm.lastFundingOracleTwap)
			.muln(24);
		const lastFundingRatePreAdj = lastFundingRate.sub(
			FUNDING_RATE_PRECISION.div(new BN(5000)) // FUNDING_RATE_OFFSET_PERCENTAGE
		);
		const timeLeftUntilFundingUpdate = BN.min(
			BN.max(now.sub(market.amm.lastFundingRateTs), ZERO),
			market.amm.fundingPeriod
		);
		const lastFundingBasis = oraclePrice
			.mul(lastFundingRatePreAdj)
			.div(PERCENTAGE_PRECISION)
			.mul(market.amm.fundingPeriod.sub(timeLeftUntilFundingUpdate))
			.div(market.amm.fundingPeriod)
			.div(new BN(1000)); // FUNDING_RATE_BUFFER
		return lastFundingBasis;
	} else {
		return ZERO;
	}
}

/**
 * Clamps trigger price based on contract tier
 * Implements the same logic as the Rust clamp_trigger_price function
 */
function clampTriggerPrice(
	market: PerpMarketAccount,
	oraclePrice: BN,
	medianPrice: BN
): BN {
	let maxBpsDiff: BN;
	const tier = market.contractTier;
	if (isVariant(tier, 'a') || isVariant(tier, 'b')) {
		maxBpsDiff = new BN(500); // 20 BPS
	} else if (isVariant(tier, 'c')) {
		maxBpsDiff = new BN(100); // 100 BPS
	} else {
		maxBpsDiff = new BN(40); // 250 BPS
	}
	const maxOracleDiff = oraclePrice.div(maxBpsDiff);
	return BN.min(
		BN.max(medianPrice, oraclePrice.sub(maxOracleDiff)),
		oraclePrice.add(maxOracleDiff)
	);
}
