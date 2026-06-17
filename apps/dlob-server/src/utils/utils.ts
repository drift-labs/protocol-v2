import {
	BN,
	BigNum,
	DriftClient,
	DriftEnv,
	L2OrderBook,
	L3OrderBook,
	MarketType,
	OraclePriceData,
	PublicKey,
	decodeUser,
	isVariant,
	PositionDirection,
	ZERO,
	BASE_PRECISION,
	PRICE_PRECISION,
	calculateEstimatedEntryPriceWithL2,
	AssetType,
	MainnetSpotMarkets,
	DevnetSpotMarkets,
	PERCENTAGE_PRECISION_EXP,
} from '@velocity-exchange/sdk';
import { RedisClient } from '@velocity-exchange/common/clients';
import { TradeOffsetPrice } from '@velocity-exchange/common';
import { logger } from './logger';
import { NextFunction, Request, Response } from 'express';
import FEATURE_FLAGS from './featureFlags';
import { Connection } from '@solana/web3.js';
import { wsMarketArgs } from 'src/dlob-subscriber/DLOBSubscriberIO';
import { DEFAULT_AUCTION_PARAMS, MID_MAJOR_MARKETS } from './constants';
import { AuctionParamArgs } from './types';
import { COMMON_MATH, ENUM_UTILS } from '@velocity-exchange/common';
import { TakerFillVsOracleBpsRedisResult } from '../athena/repositories/fillQualityAnalytics';

const MAX_FILL_QUALITY_AGE_MS = 10 * 60 * 1000; // 10 minutes
export const GROUPING_OPTIONS = [1, 10, 100, 500, 1000];
export const GROUPING_DEPENDENCIES = {
	1: null,
	10: 1,
	100: 10,
	500: 100,
	1000: 100,
};

export const l2WithBNToStrings = (l2: L2OrderBook): any => {
	for (const key of Object.keys(l2)) {
		for (const idx in l2[key]) {
			const level = l2[key][idx];
			const sources = level['sources'];
			for (const sourceKey of Object.keys(sources)) {
				sources[sourceKey] = sources[sourceKey].toString();
			}
			l2[key][idx] = {
				price: level.price.toString(),
				size: level.size.toString(),
				sources,
			};
		}
	}
	return l2;
};

export const l3WithBNToStrings = (l3: L3OrderBook): any => {
	for (const key of Object.keys(l3)) {
		for (const idx in l3[key]) {
			const level = l3[key][idx];
			l3[key][idx] = {
				price: level.price.toString(),
				size: level.size.toString(),
				maker: level.maker.toBase58(),
				orderId: level.orderId.toString(),
			};
		}
	}
	return l3;
};

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parsePositiveIntArray(
	intArray: string,
	separator = ','
): number[] {
	return intArray
		.split(separator)
		.map((s) => s.trim())
		.map((s) => parseInt(s))
		.filter((n) => !isNaN(n) && n >= 0);
}

export const getOracleForMarket = (
	driftClient: DriftClient,
	marketType: MarketType,
	marketIndex: number,
	useMMOracleData = false
): number => {
	if (isVariant(marketType, 'spot')) {
		return driftClient.getOracleDataForSpotMarket(marketIndex).price.toNumber();
	} else if (isVariant(marketType, 'perp')) {
		return useMMOracleData
			? driftClient.getMMOracleDataForPerpMarket(marketIndex).price.toNumber()
			: driftClient.getOracleDataForPerpMarket(marketIndex).price.toNumber();
	}
};

type SerializableOraclePriceData = {
	price: string;
	slot: string;
	confidence: string;
	hasSufficientNumberOfDataPoints: boolean;
	twap?: string;
	twapConfidence?: string;
	maxPrice?: string;
};

const getSerializableOraclePriceData = (
	oraclePriceData: OraclePriceData
): SerializableOraclePriceData => {
	return {
		price: oraclePriceData.price?.toString?.(),
		slot: oraclePriceData.slot?.toString?.(),
		confidence: oraclePriceData.confidence?.toString?.(),
		hasSufficientNumberOfDataPoints:
			oraclePriceData.hasSufficientNumberOfDataPoints,
		twap: oraclePriceData.twap?.toString?.(),
		twapConfidence: oraclePriceData.twapConfidence?.toString?.(),
		maxPrice: oraclePriceData.maxPrice?.toString?.(),
	};
};

export const getOracleDataForMarket = (
	driftClient: DriftClient,
	marketType: MarketType,
	marketIndex: number,
	useMMOracleData = false
): SerializableOraclePriceData => {
	if (isVariant(marketType, 'spot')) {
		return getSerializableOraclePriceData(
			driftClient.getOracleDataForSpotMarket(marketIndex)
		);
	} else if (isVariant(marketType, 'perp')) {
		return getSerializableOraclePriceData(
			useMMOracleData
				? driftClient.getMMOracleDataForPerpMarket(marketIndex)
				: driftClient.getOracleDataForPerpMarket(marketIndex)
		);
	}
};

export const addOracletoResponse = (
	response: L2OrderBook | L3OrderBook,
	driftClient: DriftClient,
	marketType: MarketType,
	marketIndex: number
): void => {
	if (FEATURE_FLAGS.OLD_ORACLE_PRICE_IN_L2) {
		response['oracle'] = getOracleForMarket(
			driftClient,
			marketType,
			marketIndex
		);
		if (response['oracle'] == 0) {
			logger.info(`oracle price is 0 for ${marketType}-${marketIndex}`);
		}
	}
	if (FEATURE_FLAGS.NEW_ORACLE_DATA_IN_L2) {
		response['oracleData'] = getOracleDataForMarket(
			driftClient,
			marketType,
			marketIndex
		);
		if (!response['oracleData'].price) {
			logger.info(
				`oracle price is undefined or 0 for ${marketType}-${marketIndex}`
			);
		}
		response['mmOracleData'] = getOracleDataForMarket(
			driftClient,
			marketType,
			marketIndex,
			true
		);
		if (!response['mmOracleData'].price && response['mmOracleData'].isActive) {
			logger.info(
				`mm oracle price is undefined or 0 for ${marketType}-${marketIndex}`
			);
		}
	}
};

export const addMarketSlotToResponse = (
	response: L2OrderBook | L3OrderBook,
	driftClient: DriftClient,
	marketType: MarketType,
	marketIndex: number
): void => {
	let marketSlot: number;
	if (isVariant(marketType, 'perp')) {
		marketSlot =
			driftClient.accountSubscriber.getMarketAccountAndSlot(marketIndex).slot;
	} else {
		marketSlot =
			driftClient.accountSubscriber.getSpotMarketAccountAndSlot(
				marketIndex
			).slot;
	}
	response['marketSlot'] = marketSlot;
};

export function aggregatePrices(entries, side, pricePrecision) {
	const isAsk = side === 'ask';
	const result = new Map();

	entries.forEach((entry) => {
		const price = parseFloat(entry.price);
		const data = {
			size: parseFloat(entry.size),
			sources: entry.sources || {},
		};

		let bucketPrice, displayPrice;
		if (isAsk) {
			displayPrice = Math.ceil(price / pricePrecision) * pricePrecision;
			bucketPrice = displayPrice;
		} else {
			displayPrice = Math.floor(price / pricePrecision) * pricePrecision;
			bucketPrice = displayPrice;
		}

		const bucketKey = Math.round(bucketPrice);

		if (!result.has(bucketKey)) {
			result.set(bucketKey, {
				size: 0,
				price: displayPrice,
				sources: {},
			});
		}

		const bucketData = result.get(bucketKey);
		bucketData.size += data.size;

		if (data.sources) {
			Object.entries(data.sources).forEach(
				([sourceKey, sourceSize]: [string, string]) => {
					if (!bucketData.sources[sourceKey]) {
						bucketData.sources[sourceKey] = 0;
					}
					bucketData.sources[sourceKey] += parseFloat(sourceSize);
				}
			);
		}
	});

	return Array.from(result.values());
}

export function publishGroupings(
	l2Formatted,
	marketArgs: wsMarketArgs,
	redisClient: RedisClient,
	clientPrefix: string,
	marketType: string,
	indicativeQuotesRedisClient: RedisClient
) {
	const groupingResults = new Map();

	GROUPING_OPTIONS.forEach((group) => {
		const pricePrecision = BigNum.from(group).mul(marketArgs.tickSize).toNum();
		const dependency = GROUPING_DEPENDENCIES[group];

		let fullAggregatedBids, fullAggregatedAsks;

		if (dependency && groupingResults.has(dependency)) {
			const previousResults = groupingResults.get(dependency);

			fullAggregatedBids = aggregatePrices(
				previousResults.bids,
				'bid',
				pricePrecision
			).sort((a, b) => b[0] - a[0]);

			fullAggregatedAsks = aggregatePrices(
				previousResults.asks,
				'ask',
				pricePrecision
			).sort((a, b) => a[0] - b[0]);
		} else {
			fullAggregatedBids = aggregatePrices(
				l2Formatted.bids,
				'bid',
				pricePrecision
			).sort((a, b) => b[0] - a[0]);

			fullAggregatedAsks = aggregatePrices(
				l2Formatted.asks,
				'ask',
				pricePrecision
			).sort((a, b) => a[0] - b[0]);
		}

		groupingResults.set(group, {
			bids: fullAggregatedBids,
			asks: fullAggregatedAsks,
		});

		// Count crossed levels at the beginning
		let crossedBids = 0;
		const bestAsk = fullAggregatedAsks[0]?.price;
		if (bestAsk !== undefined) {
			for (const bid of fullAggregatedBids) {
				if (bid.price >= bestAsk) {
					crossedBids++;
				} else {
					break;
				}
			}
		}

		let crossedAsks = 0;
		const bestBid = fullAggregatedBids[0]?.price;
		if (bestBid !== undefined) {
			for (const ask of fullAggregatedAsks) {
				if (ask.price <= bestBid) {
					crossedAsks++;
				} else {
					break;
				}
			}
		}

		const maxCrossed = Math.max(crossedBids, crossedAsks);
		const levelsToTake = 20 + maxCrossed;

		const aggregatedBids = fullAggregatedBids.slice(0, levelsToTake);
		const aggregatedAsks = fullAggregatedAsks.slice(0, levelsToTake);

		const l2Formatted_grouped20 = Object.assign({}, l2Formatted, {
			bids: aggregatedBids,
			asks: aggregatedAsks,
		});

		redisClient.publish(
			`${clientPrefix}orderbook_${marketType}_${
				marketArgs.marketIndex
			}_grouped_${group}${indicativeQuotesRedisClient ? '_indicative' : ''}`,
			l2Formatted_grouped20
		);
	});
}

/**
 * Takes in a req.query like: `{
 * 		marketName: 'SOL-PERP,BTC-PERP,ETH-PERP',
 * 		marketType: undefined,
 * 		marketIndices: undefined,
 * 		...
 * 	}` and returns a normalized object like:
 *
 * `[
 * 		{marketName: 'SOL-PERP', marketType: undefined, marketIndex: undefined,...},
 * 		{marketName: 'BTC-PERP', marketType: undefined, marketIndex: undefined,...},
 * 		{marketName: 'ETH-PERP', marketType: undefined, marketIndex: undefined,...}
 * ]`
 *
 * @param rawParams req.query object
 * @returns normalized query params for batch requests, or undefined if there is a mismatched length
 */
export const normalizeBatchQueryParams = (rawParams: {
	[key: string]: string | undefined;
}): Array<{ [key: string]: string | undefined }> => {
	const normedParams: Array<{ [key: string]: string | undefined }> = [];
	const parsedParams = {};

	// parse the query string into arrays
	for (const key of Object.keys(rawParams)) {
		const rawParam = rawParams[key];
		if (rawParam === undefined) {
			parsedParams[key] = [];
		} else {
			parsedParams[key] = rawParam.split(',') || [rawParam];
		}
	}

	// of all parsedParams, find the max length
	const maxLength = Math.max(
		...Object.values(parsedParams).map((param: Array<unknown>) => param.length)
	);

	// all params have to be either 0 length, or maxLength to be valid
	const values = Object.values(parsedParams);
	const validParams = values.every(
		(value: Array<unknown>) => value.length === 0 || value.length === maxLength
	);
	if (!validParams) {
		return undefined;
	}

	// merge all params into an array of objects
	// normalize all params to the same length, filling in undefineds
	for (let i = 0; i < maxLength; i++) {
		const newParam = {};
		for (const key of Object.keys(parsedParams)) {
			const parsedParam = parsedParams[key];
			newParam[key] =
				parsedParam.length === maxLength ? parsedParam[i] : undefined;
		}
		normedParams.push(newParam);
	}

	return normedParams;
};

export const validateWsSubscribeMsg = (
	msg: any,
	sdkConfig: any
): { valid: boolean; msg?: string } => {
	const maxPerpMarketIndex = Math.max(
		...sdkConfig.PERP_MARKETS.map((m) => m.marketIndex)
	);
	const maxSpotMarketIndex = Math.max(
		...sdkConfig.SPOT_MARKETS.map((m) => m.marketIndex)
	);

	if (msg['marketIndex'] < 0) {
		return { valid: false, msg: `Invalid marketIndex, must be >= 0` };
	}

	if (
		msg['marketType'].toLowerCase() == 'spot' &&
		parseInt(msg['marketIndex']) > maxSpotMarketIndex
	) {
		return {
			valid: false,
			msg: `Invalid marketIndex for marketType: ${msg['marketType']}`,
		};
	}

	if (
		msg['marketType'].toLowerCase() == 'perp' &&
		parseInt(msg['marketIndex']) > maxPerpMarketIndex
	) {
		return {
			valid: false,
			msg: `Invalid marketIndex for marketType: ${msg['marketType']}`,
		};
	}

	if (
		msg['marketType'].toLowerCase() != 'perp' &&
		msg['marketType'] != 'spot'
	) {
		return {
			valid: false,
			msg: `Invalid marketType: ${msg['marketType']}`,
		};
	}

	return { valid: true };
};

export const validateDlobQuery = (
	driftClient: DriftClient,
	driftEnv: DriftEnv,
	marketType?: string,
	marketIndex?: string,
	marketName?: string
): {
	normedMarketType?: MarketType;
	normedMarketIndex?: number;
	error?: string;
} => {
	let normedMarketType: MarketType = undefined;
	let normedMarketIndex: number = undefined;
	let normedMarketName: string = undefined;
	if (marketName === undefined) {
		if (marketIndex === undefined || marketType === undefined) {
			return {
				error:
					'Bad Request: (marketName) or (marketIndex and marketType) must be supplied',
			};
		}

		// validate marketType
		switch ((marketType as string).toLowerCase()) {
			case 'spot': {
				normedMarketType = MarketType.SPOT;
				normedMarketIndex = parseInt(marketIndex as string);
				const spotMarketIndicies = driftClient
					.getSpotMarketAccounts()
					.map((mkt) => mkt.marketIndex);
				if (!spotMarketIndicies.includes(normedMarketIndex)) {
					return {
						error: 'Bad Request: invalid marketIndex',
					};
				}
				break;
			}
			case 'perp': {
				normedMarketType = MarketType.PERP;
				normedMarketIndex = parseInt(marketIndex as string);
				const perpMarketIndicies = driftClient
					.getPerpMarketAccounts()
					.map((mkt) => mkt.marketIndex);
				if (!perpMarketIndicies.includes(normedMarketIndex)) {
					return {
						error: 'Bad Request: invalid marketIndex',
					};
				}
				break;
			}
			default:
				return {
					error: 'Bad Request: marketType must be either "spot" or "perp"',
				};
		}
	} else {
		// validate marketName
		normedMarketName = (marketName as string).toUpperCase();
		const derivedMarketInfo =
			driftClient.getMarketIndexAndType(normedMarketName);
		if (!derivedMarketInfo) {
			return {
				error: 'Bad Request: unrecognized marketName',
			};
		}
		normedMarketType = derivedMarketInfo.marketType;
		normedMarketIndex = derivedMarketInfo.marketIndex;
	}

	return {
		normedMarketType,
		normedMarketIndex,
	};
};

export const getAccountFromId = async (
	userMapClient: RedisClient,
	topMakers: string[]
) => {
	return Promise.all(
		topMakers.map(async (userAccountPubKey) => {
			const userAccountEncoded = await userMapClient.getRaw(userAccountPubKey);
			if (userAccountEncoded) {
				return {
					userAccountPubKey,
					account: decodeUser(
						Buffer.from(userAccountEncoded.split('::')[1], 'base64')
					),
				};
			}
			return {
				userAccountPubKey,
				account: null,
			};
		})
	).then((results) => results.filter((user) => !!user));
};

export const getRawAccountFromId = async (
	userMapClient: RedisClient,
	topMakers: string[],
	connection: Connection
): Promise<
	{
		userAccountPubKey: string;
		accountBase64: string;
	}[]
> => {
	return Promise.all(
		topMakers.map(async (userAccountPubKey) => {
			const userAccountEncoded = await userMapClient.getRaw(userAccountPubKey);
			if (userAccountEncoded) {
				return {
					userAccountPubKey,
					accountBase64: userAccountEncoded.split('::')[1],
				};
			} else {
				// user is not in the userMap, try to fetch from the connection
				const account = await connection.getAccountInfo(
					new PublicKey(userAccountPubKey)
				);
				if (account) {
					return {
						userAccountPubKey,
						accountBase64: account.data.toString('base64'),
					};
				}
			}

			return {
				userAccountPubKey,
				accountBase64: null,
			};
		})
	).then((results) => results.filter((user) => !!user));
};

export function errorHandler(
	err: Error,
	_req: Request,
	res: Response,
	_next: NextFunction
): void {
	logger.error(`errorHandler, message: ${err.message}, stack: ${err.stack}`);
	if (!res.headersSent) {
		res.status(500).send('Internal error');
	}
}

export type SubscriberLookup = {
	[marketIndex: number]: {
		tickSize?: BN;
	};
};

export const selectMostRecentBySlot = (
	responses: any[]
): {
	slot: number;
	[key: string]: any;
} => {
	const parsedResponses = responses
		.map((response) => {
			try {
				return JSON.parse(response);
			} catch {
				return null;
			}
		})
		.filter((parsed) => parsed && typeof parsed.slot === 'number');
	return parsedResponses.reduce((mostRecent, current) => {
		return !mostRecent || current.slot > mostRecent.slot ? current : mostRecent;
	}, null);
};

export function createMarketBasedAuctionParams(
	args: AuctionParamArgs,
	overrideDefaults?: Partial<AuctionParamArgs>,
	version: number = 1
): AuctionParamArgs {
	// Determine if this is a major market (PERP with marketIndex 0, 1, or 2)
	const isMajorMarket =
		args.marketType?.toLowerCase() === 'perp' &&
		[0, 1, 2].includes(args.marketIndex);

	// Resolve "marketBased" values and undefined values (both should use market-based logic)
	const resolvedAuctionStartPriceOffsetFrom =
		args.auctionStartPriceOffsetFrom === 'marketBased' ||
		args.auctionStartPriceOffsetFrom === undefined
			? isMajorMarket
				? 'mark'
				: 'bestOffer'
			: args.auctionStartPriceOffsetFrom;

	const resolvedAuctionStartPriceOffset =
		args.auctionStartPriceOffset === 'marketBased' ||
		args.auctionStartPriceOffset === undefined
			? isMajorMarket
				? 0
				: -0.1
			: args.auctionStartPriceOffset;

	// Set market-specific defaults (only used if values are undefined)
	const marketSpecificDefaults: Partial<AuctionParamArgs> = {
		...DEFAULT_AUCTION_PARAMS,
		auctionStartPriceOffsetFrom:
			isMajorMarket && version === 1 ? 'mark' : 'bestOffer',
		auctionStartPriceOffset: isMajorMarket && version === 1 ? 0 : -0.1,
	};

	// Apply custom overrides if provided
	const finalDefaults = overrideDefaults
		? { ...marketSpecificDefaults, ...overrideDefaults }
		: marketSpecificDefaults;

	return {
		...finalDefaults,
		...args,
		// Override with resolved "marketBased" values if were provided
		auctionStartPriceOffsetFrom:
			resolvedAuctionStartPriceOffsetFrom ??
			finalDefaults.auctionStartPriceOffsetFrom,
		auctionStartPriceOffset:
			resolvedAuctionStartPriceOffset ?? finalDefaults.auctionStartPriceOffset,
	};
}

/**
 * Parse boolean values from string query parameters
 * @param value - string value from query parameter
 * @returns boolean | undefined - true for 'true'/'1', false for other values, undefined if input is undefined
 */
export const parseBoolean = (
	value: string | undefined
): boolean | undefined => {
	if (value === undefined) return undefined;
	return value === 'true' || value === '1';
};

/**
 * Safely parse numeric values from string query parameters
 * @param value - string value from query parameter
 * @returns number | undefined - parsed number or undefined if invalid/empty
 */
export const parseNumber = (value: string | undefined): number | undefined => {
	if (!value) return undefined;
	const parsed = parseFloat(value);
	return isNaN(parsed) ? undefined : parsed;
};

/**
 * Convert string to BN
 * @param value - string value to convert
 * @returns BN
 */
export const stringToBN = (value: string): BN => {
	if (!value) return ZERO;
	return new BN(value);
};

/**
 * Convert raw Redis L2 data (with string prices/sizes) to proper L2OrderBook format (with BN values)
 * @param rawL2 - Raw L2 data from Redis with string values
 * @returns L2OrderBook with proper BN values
 */
export const convertRawL2ToBN = (rawL2: any): L2OrderBook => {
	const convertLevel = (level: any) => ({
		...level,
		price: new BN(level.price),
		size: new BN(level.size),
	});

	return {
		...rawL2,
		bids: rawL2.bids?.map(convertLevel) || [],
		asks: rawL2.asks?.map(convertLevel) || [],
	};
};

/**
 * Maps TradeOffsetPrice values to corresponding property names in estimatedPrices object
 * @param offsetFrom - TradeOffsetPrice type or 'marketBased' or undefined
 * @returns Property name string for accessing estimatedPrices
 */
export const mapTradeOffsetPriceToProperty = (
	offsetFrom: TradeOffsetPrice | 'marketBased' | undefined
): string => {
	switch (offsetFrom) {
		case 'best':
			return 'bestPrice';
		case 'worst':
			return 'worstPrice';
		case 'oracle':
			return 'oraclePrice';
		case 'mark':
			return 'markPrice';
		case 'entry':
			return 'entryPrice';
		case 'bestOffer':
			// For bestOffer, we'll use the best price (could be refined based on direction)
			return 'bestPrice';
		case 'marketBased':
			// Default to mark price for market-based pricing
			return 'markPrice';
		default:
			// Default fallback to mark price
			return 'markPrice';
	}
};

/**
 * Get L2 orderbook data and calculate estimated prices
 * @param driftClient - DriftClient instance
 * @param marketType - MarketType enum
 * @param marketIndex - Market index number
 * @param direction - Position direction
 * @param amount - Amount as BN (could be base or quote amount)
 * @param assetType - Whether amount is 'base' or 'quote'
 * @param fetchFromRedis - Redis fetch function
 * @param selectMostRecentBySlot - Slot selection function
 * @returns Price data object with oracle, best, entry, worst, and mark prices
 */
export const getEstimatedPrices = async (
	driftClient: DriftClient,
	marketType: MarketType,
	marketIndex: number,
	direction: PositionDirection,
	amount: BN,
	assetType: AssetType,
	fetchFromRedis: (
		key: string,
		selectionCriteria: (responses: any) => any
	) => Promise<any>,
	selectMostRecentBySlot: (responses: any[]) => any
): Promise<{
	oraclePrice: BN;
	bestPrice: BN;
	entryPrice: BN;
	worstPrice: BN;
	markPrice: BN;
	priceImpact: BN;
}> => {
	const isSpot = isVariant(marketType, 'spot');

	// Get L2 orderbook data using the new utility function
	const redisL2 = await fetchL2FromRedis(
		fetchFromRedis,
		selectMostRecentBySlot,
		marketType,
		marketIndex
	);

	let l2Formatted: L2OrderBook;
	if (redisL2) {
		l2Formatted = convertRawL2ToBN(redisL2);
	} else {
		l2Formatted = {
			bids: [],
			asks: [],
		};
	}

	const oracleData = isSpot
		? driftClient.getOracleDataForSpotMarket(marketIndex)
		: driftClient.getMMOracleDataForPerpMarket(marketIndex);

	// Get oracle price
	const oraclePrice = new BN(oracleData?.price || 0).mul(PRICE_PRECISION);

	const spreadInfo = COMMON_MATH.calculateSpreadBidAskMark(
		l2Formatted,
		oraclePrice
	);

	const markPrice = spreadInfo?.markPrice ?? oraclePrice;

	// If we have L2 data, calculate estimated prices
	if (l2Formatted.bids?.length > 0 || l2Formatted.asks?.length > 0) {
		try {
			const basePrecision = !isSpot
				? BASE_PRECISION
				: process.env.ENV === 'mainnet-beta'
				? MainnetSpotMarkets[marketIndex].precision
				: DevnetSpotMarkets[marketIndex].precision;

			const priceEstimate = calculateEstimatedEntryPriceWithL2(
				assetType,
				amount,
				direction,
				basePrecision,
				l2Formatted as L2OrderBook
			);

			return {
				oraclePrice,
				bestPrice: priceEstimate.bestPrice,
				entryPrice: priceEstimate.entryPrice,
				worstPrice: priceEstimate.worstPrice,
				markPrice,
				priceImpact: priceEstimate.priceImpact,
			};
		} catch (error) {
			// If calculation fails, fallback to oracle prices
			console.warn('Price calculation failed, using oracle fallback:', error);
		}
	}

	// Fallback to oracle prices if no L2 data or calculation fails
	return {
		oraclePrice,
		bestPrice: oraclePrice,
		entryPrice: oraclePrice,
		worstPrice: oraclePrice,
		markPrice,
		priceImpact: ZERO,
	};
};

/**
 * Maps AuctionParamArgs to the format expected by deriveMarketOrderParams
 * @param params - AuctionParamArgs from the API request
 * @param driftClient - DriftClient instance (optional, for price calculation)
 * @param fetchFromRedis - Redis fetch function (optional, for price calculation)
 * @param selectMostRecentBySlot - Slot selection function (optional, for price calculation)
 * @param fillQualityInfo - Fill quality analytics data (version 2 only)
 * @param apiVersion - API version (1 or 2)
 * @returns Object formatted for deriveMarketOrderParams function or error response
 */
export const mapToMarketOrderParams = async (
	params: AuctionParamArgs,
	driftClient?: DriftClient,
	fetchFromRedis?: (
		key: string,
		selectionCriteria: (responses: any) => any
	) => Promise<any>,
	selectMostRecentBySlot?: (responses: any[]) => any,
	fillQualityInfo?: TakerFillVsOracleBpsRedisResult,
	apiVersion: number = 1
): Promise<{
	success: boolean;
	data?: {
		marketOrderParams: any;
		estimatedPrices: {
			oraclePrice: BN;
			bestPrice: BN;
			entryPrice: BN;
			worstPrice: BN;
			markPrice: BN;
			priceImpact: BN;
		};
	};
	error?: string;
}> => {
	// Convert marketType string to MarketType enum
	const marketType =
		params.marketType.toLowerCase() === 'spot'
			? MarketType.SPOT
			: MarketType.PERP;

	// Convert direction string to PositionDirection enum
	const direction =
		params.direction === 'long'
			? PositionDirection.LONG
			: PositionDirection.SHORT;

	// Convert amount string to BN - amount is already in base or quote precision
	const amount = stringToBN(params.amount);

	// Convert additionalEndPriceBuffer string to BN with PRICE_PRECISION (1e6) if provided
	const additionalEndPriceBuffer = params.additionalEndPriceBuffer
		? stringToBN(params.additionalEndPriceBuffer).mul(PRICE_PRECISION)
		: undefined;

	// Calculate estimated prices and handle slippage tolerance calculation
	let estimatedPrices;
	let processedSlippageTolerance = params.slippageTolerance;

	// Track debug info for logging
	const debugInfo = {
		originalOraclePrice: null as string | null,
		adjustedOraclePrice: null as string | null,
		adjustedMarkPrice: null as string | null,
		isCrossed: false,
		fillQualityBps: null as number | null,
		fillQualityDataStale: false,
		priceReferenceUsed: null as string | null,
		priceReferenceDistance: null as string | null,
		reason: null as string | null,
		markVsOracle: null as string | null,
		isMarkFavorableForDirection: null as boolean | null,
		appliedV2Adjustment: false,
	};

	let conditionalParams = {};

	if (driftClient && fetchFromRedis && selectMostRecentBySlot) {
		// Get L2 orderbook data using the utility function
		const redisL2 = await fetchL2FromRedis(
			fetchFromRedis,
			selectMostRecentBySlot,
			marketType,
			params.marketIndex
		);

		// Calculate estimated prices using the fetched L2 data
		estimatedPrices = await getEstimatedPricesWithL2(
			driftClient,
			marketType,
			params.marketIndex,
			direction,
			amount,
			params.assetType,
			redisL2
		);

		// Store original oracle for debugging
		debugInfo.originalOraclePrice = estimatedPrices.oraclePrice.toString();

		// VERSION 2: Adjust oracle price based on fill quality when orderbook is crossed
		if (apiVersion === 2 && fillQualityInfo && redisL2) {
			try {
				// Convert raw L2 to formatted L2 for cross detection
				const l2Formatted = convertRawL2ToBN(redisL2);

				const isSpot = isVariant(marketType, 'spot');
				const oracleData = isSpot
					? driftClient.getOracleDataForSpotMarket(params.marketIndex)
					: driftClient.getMMOracleDataForPerpMarket(params.marketIndex);
				const oraclePrice = oracleData.price ?? ZERO;

				// Detect if orderbook is crossed
				const spreadInfo = COMMON_MATH.calculateSpreadBidAskMark(
					l2Formatted,
					oraclePrice
				);

				// TODO - apply this to all apiVersions once testing is complete.
				conditionalParams = {
					ensureCrossingEndPrice: true,
					bestBidPrice: spreadInfo.bestBidPrice,
					bestAskPrice: spreadInfo.bestAskPrice,
				};

				const isCrossed =
					spreadInfo.bestBidPrice &&
					spreadInfo.bestAskPrice &&
					spreadInfo.bestBidPrice.gte(spreadInfo.bestAskPrice);

				debugInfo.isCrossed = isCrossed;

				if (isCrossed) {
					// Check data staleness - ignore if older than 10 minutes
					const dataAge = Date.now() - (fillQualityInfo.updatedAtTs || 0);

					if (dataAge > MAX_FILL_QUALITY_AGE_MS) {
						logger.warn(
							`Version 2: Fill quality data is stale (${Math.round(
								dataAge / 1000
							)}s old), skipping adjustment for market ${params.marketIndex}`
						);
						debugInfo.fillQualityDataStale = true;
					} else {
						// Get fill quality metric based on direction
						const fillQualityBpsStr =
							direction === PositionDirection.LONG
								? fillQualityInfo.takerBuyBpsFromOracle?.all
								: fillQualityInfo.takerSellBpsFromOracle?.all;

						if (
							fillQualityBpsStr &&
							fillQualityBpsStr !== 'null' &&
							fillQualityBpsStr !== null
						) {
							const fillQualityBps = Math.round(
								parseFloat(fillQualityBpsStr) * 100
							);
							debugInfo.fillQualityBps = fillQualityBps;

							if (!isNaN(fillQualityBps)) {
								const adjustment = oraclePrice
									.muln(fillQualityBps)
									.divn(10000 * 100);
								const fillQualityAdjustedPrice = oraclePrice.add(adjustment);

								// Compare fill quality adjusted price vs mark price to determine which is better for takers
								// We want to use the price that gets takers closer to where makers have been filling
								// AND consider whether the mark price is favorable for the taker's direction
								const markPrice = estimatedPrices.markPrice;
								const originalOraclePrice = oraclePrice;

								// Determine if mark price favors this direction
								const markVsOracle = markPrice.sub(originalOraclePrice);
								const isMarkFavorableForDirection =
									direction === PositionDirection.LONG
										? markVsOracle.lt(ZERO) // Mark below oracle is good for longs
										: markVsOracle.gt(ZERO); // Mark above oracle is good for shorts

								// Calculate distances from each price to the fill quality adjusted price
								// The fill quality adjusted price represents where makers have been filling
								const distanceFromMark = markPrice
									.sub(fillQualityAdjustedPrice)
									.abs();
								const distanceFromOracle = originalOraclePrice
									.sub(fillQualityAdjustedPrice)
									.abs();

								// Decision logic: prefer fill quality adjusted price when:
								// 1. It's closer to the target, OR
								// 2. Mark price is unfavorable for this direction
								if (
									distanceFromOracle.lt(distanceFromMark) ||
									!isMarkFavorableForDirection
								) {
									// Use fill quality adjusted price
									estimatedPrices.markPrice = fillQualityAdjustedPrice;
									debugInfo.priceReferenceUsed = 'oracleAdjusted';
									debugInfo.priceReferenceDistance =
										distanceFromOracle.toString();
									debugInfo.reason = isMarkFavorableForDirection
										? 'closerToTarget'
										: 'markUnfavorable';
								} else {
									// Use mark price
									debugInfo.priceReferenceUsed = 'mark';
									debugInfo.priceReferenceDistance =
										distanceFromMark.toString();
									debugInfo.reason = 'markFavorableAndCloser';
								}

								// Store additional debug info
								debugInfo.markVsOracle = markVsOracle.toString();
								debugInfo.isMarkFavorableForDirection =
									isMarkFavorableForDirection;

								// Always update oracle price with fill quality adjustment for consistency
								estimatedPrices.oraclePrice = fillQualityAdjustedPrice;

								// Update other prices to maintain consistency
								estimatedPrices.bestPrice =
									estimatedPrices.bestPrice.add(adjustment);
								estimatedPrices.entryPrice =
									estimatedPrices.entryPrice.add(adjustment);
								estimatedPrices.worstPrice =
									estimatedPrices.worstPrice.add(adjustment);

								debugInfo.adjustedOraclePrice =
									fillQualityAdjustedPrice.toString();
								debugInfo.adjustedMarkPrice =
									estimatedPrices.markPrice.toString();
								debugInfo.appliedV2Adjustment = true;
							}
						}
					}
				}
			} catch (error) {
				logger.warn(
					'Version 2: Failed to apply fill quality adjustment, using standard oracle:',
					error
				);
				// Fall through to use unadjusted oracle
			}
		}

		// Handle dynamic slippage tolerance calculation if needed
		if (params.slippageTolerance === undefined) {
			// Convert raw L2 to formatted L2 for slippage calculation
			let l2Formatted: L2OrderBook;
			if (redisL2) {
				l2Formatted = convertRawL2ToBN(redisL2);
			} else {
				l2Formatted = {
					bids: [],
					asks: [],
				};
			}

			const startPriceProperty = mapTradeOffsetPriceToProperty(
				params.auctionStartPriceOffsetFrom
			);
			const startPrice = estimatedPrices[startPriceProperty];

			processedSlippageTolerance = calculateDynamicSlippage(
				params.marketIndex,
				params.marketType,
				driftClient,
				l2Formatted,
				startPrice,
				estimatedPrices.worstPrice,
				apiVersion
			);
		}
	} else {
		return {
			success: false,
			error: 'Cannot create valid auction parameters: could not fetch prices',
		};
	}

	// Calculate baseAmount based on maxLeverageSelected or assetType
	let baseAmount: BN;
	if (params.maxLeverageSelected && params.maxLeverageOrderSize) {
		// If maxLeverageSelected is true, use maxLeverageOrderSize directly without any conversion
		baseAmount = stringToBN(params.maxLeverageOrderSize);
	} else if (params.assetType === 'base') {
		// If assetType is base, use the amount directly
		baseAmount = amount;
	} else {
		// If assetType is quote, convert quote amount to base amount using entry price
		// baseAmount = (quoteAmount * QUOTE_PRECISION * BASE_PRECISION) / entryPrice
		baseAmount = amount.mul(BASE_PRECISION).div(estimatedPrices.entryPrice);
	}

	// Comprehensive debug logging
	logger.info(
		JSON.stringify({
			event: 'auction_params_calculated',
			requestParams: {
				marketIndex: params.marketIndex,
				marketType: params.marketType,
				direction: direction === PositionDirection.LONG ? 'long' : 'short',
				amount: params.amount,
				assetType: params.assetType,
				slippageTolerance: params.slippageTolerance,
				apiVersion,
			},
			priceDiscovery: {
				originalOraclePrice: debugInfo.originalOraclePrice,
				finalOraclePrice: estimatedPrices.oraclePrice.toString(),
				bestPrice: estimatedPrices.bestPrice.toString(),
				entryPrice: estimatedPrices.entryPrice.toString(),
				worstPrice: estimatedPrices.worstPrice.toString(),
				markPrice: estimatedPrices.markPrice.toString(),
				priceImpactBps: estimatedPrices.priceImpact.toString(),
			},
			v2CrossDetection:
				apiVersion === 2
					? {
							isCrossed: debugInfo.isCrossed,
							fillQualityBps: debugInfo.fillQualityBps,
							adjustedOraclePrice: debugInfo.adjustedOraclePrice,
							adjustedMarkPrice: debugInfo.adjustedMarkPrice,
							appliedAdjustment: debugInfo.appliedV2Adjustment,
							fillQualityDataStale: debugInfo.fillQualityDataStale,
							priceReferenceUsed: debugInfo.priceReferenceUsed,
							priceReferenceDistance: debugInfo.priceReferenceDistance,
							reason: debugInfo.reason,
							markVsOracle: debugInfo.markVsOracle,
							isMarkFavorableForDirection:
								debugInfo.isMarkFavorableForDirection,
							fillQualityData: fillQualityInfo
								? {
										takerBuyBpsAll: fillQualityInfo.takerBuyBpsFromOracle?.all,
										takerSellBpsAll:
											fillQualityInfo.takerSellBpsFromOracle?.all,
										updatedAtTs: fillQualityInfo.updatedAtTs,
								  }
								: null,
					  }
					: undefined,
			auctionConfig: {
				duration: params.auctionDuration,
				startPriceOffset: params.auctionStartPriceOffset,
				startPriceOffsetFrom: params.auctionStartPriceOffsetFrom,
				endPriceOffset: params.auctionEndPriceOffset,
				endPriceOffsetFrom: params.auctionEndPriceOffsetFrom,
				slippageTolerance: processedSlippageTolerance,
				isOracleOrder: params.isOracleOrder,
				reduceOnly: params.reduceOnly ?? false,
				allowInfSlippage: params.allowInfSlippage ?? false,
			},
			calculatedValues: {
				baseAmount: baseAmount.toString(),
				slippageToleranceFinal: processedSlippageTolerance,
			},
		})
	);

	return {
		success: true,
		data: {
			marketOrderParams: {
				marketType,
				marketIndex: params.marketIndex,
				direction,
				maxLeverageSelected: params.maxLeverageSelected ?? false,
				maxLeverageOrderSize: params.maxLeverageOrderSize
					? stringToBN(params.maxLeverageOrderSize)
					: ZERO,
				baseAmount,
				reduceOnly: params.reduceOnly ?? false,
				allowInfSlippage: params.allowInfSlippage ?? false,
				oraclePrice: estimatedPrices.oraclePrice,
				bestPrice: estimatedPrices.bestPrice,
				entryPrice: estimatedPrices.entryPrice,
				worstPrice: estimatedPrices.worstPrice,
				markPrice: estimatedPrices.markPrice,
				auctionDuration: params.auctionDuration,
				auctionStartPriceOffset: params.auctionStartPriceOffset as number,
				auctionEndPriceOffset: params.auctionEndPriceOffset,
				auctionStartPriceOffsetFrom: params.auctionStartPriceOffsetFrom as any,
				auctionEndPriceOffsetFrom: params.auctionEndPriceOffsetFrom,
				slippageTolerance: processedSlippageTolerance,
				isOracleOrder: params.isOracleOrder,
				additionalEndPriceBuffer,
				forceUpToSlippage: params.forceUpToSlippage,
				userOrderId: params.userOrderId,
				...conditionalParams,
			},
			estimatedPrices,
		},
	};
};

/**
 * Format auction parameters for API response
 * @param auctionParams - Raw auction parameters from deriveMarketOrderParams
 * @returns Formatted auction parameters with BNs as strings and enums as readable strings
 */
export const formatAuctionParamsForResponse = (auctionParams: any) => {
	const formatted = { ...auctionParams };

	// we don't use this field anymore, TODO to remove from ui
	delete formatted.constrainedBySlippage;

	// Convert all properties
	Object.keys(formatted).forEach((key) => {
		const value = formatted[key];

		// Check if it's a BN using BN.isBN()
		if (BN.isBN(value)) {
			formatted[key] = value.toString();
		}
		// Check if it's an enum (has nested object structure like {oracle: {}})
		else if (
			value &&
			typeof value === 'object' &&
			Object.keys(value).length === 1
		) {
			try {
				formatted[key] = ENUM_UTILS.toStr(value);
			} catch (e) {
				// If ENUM_UTILS.toStr fails, keep original value
				formatted[key] = value;
			}
		}
	});

	return formatted;
};

/**
 * Fetch L2 orderbook data from Redis
 * @param fetchFromRedis - Redis fetch function
 * @param selectMostRecentBySlot - Slot selection function
 * @param marketType - MarketType enum (spot or perp)
 * @param marketIndex - Market index number
 * @param includeIndicative - Whether to include indicative orders (optional)
 * @returns Promise<any> - Raw L2 data from Redis or null if not found
 */
export const fetchL2FromRedis = async (
	fetchFromRedis: (
		key: string,
		selectionCriteria: (responses: any) => any
	) => Promise<any>,
	selectMostRecentBySlot: (responses: any[]) => any,
	marketType: MarketType,
	marketIndex: number,
	includeIndicative?: boolean
): Promise<any> => {
	const isSpot = isVariant(marketType, 'spot');
	const marketTypeStr = isSpot ? 'spot' : 'perp';
	const indicativeSuffix = includeIndicative ? '_indicative' : '';

	return await fetchFromRedis(
		`last_update_orderbook_${marketTypeStr}_${marketIndex}${indicativeSuffix}`,
		selectMostRecentBySlot
	);
};

/**
 * Calculate dynamic slippage tolerance using L2 data
 * @param direction - Position direction ('long' or 'short')
 * @param marketIndex - Market index number
 * @param marketType - Market type ('spot' or 'perp')
 * @param driftClient - DriftClient instance for oracle data
 * @param l2Formatted - Already formatted L2OrderBook data
 * @returns Dynamic slippage tolerance as a number
 */
export const calculateDynamicSlippage = (
	marketIndex: number,
	marketType: string,
	driftClient: DriftClient,
	l2Formatted: L2OrderBook,
	startPrice: BN,
	worstPrice: BN,
	apiVersion?: number
): number => {
	// Determine if this is a major market (PERP with marketIndex 0, 1, or 2)
	const isPerp = marketType.toLowerCase() === 'perp';
	const isMajor = isPerp && marketIndex < 3;
	const isMidMajor = isPerp && MID_MAJOR_MARKETS.includes(marketIndex);

	const baseSlippage = isMajor
		? parseFloat(process.env.DYNAMIC_BASE_SLIPPAGE_MAJOR || '0') // 0% default
		: isMidMajor
		? parseFloat(process.env.DYNAMIC_BASE_SLIPPAGE_MID_MAJOR || '0.25') // 0.25% default
		: parseFloat(process.env.DYNAMIC_BASE_SLIPPAGE_NON_MAJOR || '0.5'); // 0.5% default

	// Calculate spread using L2 data
	let spreadBaseSlippage = 0.0005; // 0.05% fallback spread
	try {
		// Get oracle data
		const oracleData = isPerp
			? driftClient.getMMOracleDataForPerpMarket(marketIndex)
			: driftClient.getOracleDataForSpotMarket(marketIndex);

		// Get oracle price
		const oraclePrice = new BN(oracleData?.price || 0).mul(PRICE_PRECISION);

		// Calculate actual spread
		const spreadInfo = COMMON_MATH.calculateSpreadBidAskMark(
			l2Formatted,
			oraclePrice
		);

		const spreadPctNum = BigNum.from(
			spreadInfo.spreadPct,
			PERCENTAGE_PRECISION_EXP
		)?.toNum();

		if (spreadInfo?.spreadPct) {
			spreadBaseSlippage = spreadPctNum * 0.9;

			// If the L2 is crossed (best bid > best ask), cap the spread contribution
			const bestBid = spreadInfo.bestBidPrice;
			const bestAsk = spreadInfo.bestAskPrice;
			const isCrossed = !!(bestBid && bestAsk && bestBid.gt(bestAsk));

			if (isCrossed) {
				// Always cap the spread component tightly when crossed, default to 0.1%
				const defaultCrossCap = 0.1;
				const crossCap =
					parseFloat(
						process.env.DYNAMIC_CROSS_SPREAD_CAP || defaultCrossCap.toString()
					) ?? defaultCrossCap;
				spreadBaseSlippage = Math.min(spreadBaseSlippage, crossCap);
			}
		}
	} catch (error) {
		console.warn('Failed to calculate spread, using fallback:', error);
	}

	let dynamicSlippage = baseSlippage + spreadBaseSlippage;

	// use halfway to worst price as size adjusted slippage
	if (startPrice && worstPrice) {
		let sizeAdjustedSlippage =
			(startPrice.sub(worstPrice).abs().toNumber() /
				startPrice.toNumber() /
				2) *
			100;

		dynamicSlippage = Math.max(dynamicSlippage, sizeAdjustedSlippage);
	}

	// Apply multiplier from env var
	const multiplier = isMajor
		? parseFloat(process.env.DYNAMIC_SLIPPAGE_MULTIPLIER_MAJOR || '1.1')
		: isMidMajor
		? parseFloat(process.env.DYNAMIC_SLIPPAGE_MULTIPLIER_MID_MAJOR || '1.25')
		: parseFloat(process.env.DYNAMIC_SLIPPAGE_MULTIPLIER_NON_MAJOR || '1.5');
	dynamicSlippage = dynamicSlippage * multiplier;

	// Enforce minimum and maximum limits from env vars
	const minSlippage = parseFloat(process.env.DYNAMIC_SLIPPAGE_MIN || '0.035'); // 0.035% minimum
	const maxSlippage = parseFloat(process.env.DYNAMIC_SLIPPAGE_MAX || '5'); // 5% maximum

	let finalSlippage = Math.min(
		Math.max(dynamicSlippage, minSlippage),
		maxSlippage
	);

	// Apply 10% boost for API v2
	if (apiVersion === 2) {
		finalSlippage = finalSlippage * 1.2;
	}

	return finalSlippage;
};

/**
 * Get L2 orderbook data and calculate estimated prices using pre-fetched L2 data
 * @param driftClient - DriftClient instance
 * @param marketType - MarketType enum
 * @param marketIndex - Market index number
 * @param direction - Position direction
 * @param amount - Amount as BN (could be base or quote amount)
 * @param assetType - Whether amount is 'base' or 'quote'
 * @param redisL2 - Pre-fetched L2 data from Redis
 * @returns Price data object with oracle, best, entry, worst, and mark prices
 */
export const getEstimatedPricesWithL2 = async (
	driftClient: DriftClient,
	marketType: MarketType,
	marketIndex: number,
	direction: PositionDirection,
	amount: BN,
	assetType: AssetType,
	redisL2: any
): Promise<{
	oraclePrice: BN;
	bestPrice: BN;
	entryPrice: BN;
	worstPrice: BN;
	markPrice: BN;
	priceImpact: BN;
}> => {
	const isSpot = isVariant(marketType, 'spot');

	let l2Formatted: L2OrderBook;
	if (redisL2) {
		l2Formatted = convertRawL2ToBN(redisL2);
	} else {
		l2Formatted = {
			bids: [],
			asks: [],
		};
	}

	const oracleData = isSpot
		? driftClient.getOracleDataForSpotMarket(marketIndex)
		: driftClient.getMMOracleDataForPerpMarket(marketIndex);

	// Get oracle price
	const oraclePrice = oracleData.price ?? ZERO;

	const spreadInfo = COMMON_MATH.calculateSpreadBidAskMark(
		l2Formatted,
		oraclePrice
	);

	const markPrice = spreadInfo?.markPrice ?? oraclePrice;

	// If we have L2 data, calculate estimated prices
	if (l2Formatted.bids?.length > 0 || l2Formatted.asks?.length > 0) {
		try {
			const basePrecision = !isSpot
				? BASE_PRECISION
				: process.env.ENV === 'mainnet-beta'
				? MainnetSpotMarkets[marketIndex].precision
				: DevnetSpotMarkets[marketIndex].precision;

			const priceEstimate = calculateEstimatedEntryPriceWithL2(
				assetType,
				amount,
				direction,
				basePrecision,
				l2Formatted as L2OrderBook
			);

			return {
				oraclePrice,
				bestPrice: priceEstimate.bestPrice,
				entryPrice: priceEstimate.entryPrice,
				worstPrice: priceEstimate.worstPrice,
				markPrice,
				priceImpact: priceEstimate.priceImpact,
			};
		} catch (error) {
			// If calculation fails, fallback to oracle prices
			console.warn('Price calculation failed, using oracle fallback:', error);
		}
	}

	// Fallback to oracle prices if no L2 data or calculation fails
	return {
		oraclePrice,
		bestPrice: oraclePrice,
		entryPrice: oraclePrice,
		worstPrice: oraclePrice,
		markPrice,
		priceImpact: ZERO,
	};
};
