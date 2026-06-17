import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
	BASE_PRECISION,
	BN,
	VelocityEnv,
	initialize,
	OrderTriggerCondition,
	OrderType,
	PositionDirection,
	QUOTE_PRECISION,
	QUOTE_PRECISION_EXP,
	SpotMarketConfig,
} from '@velocity-exchange/sdk';
import Decimal from 'decimal.js';
import {
	CandleResolutions,
	LastOrderStatus,
	OrderAction,
	OrderActionRecord,
	OrderLabel,
	SerializedMarketFilter,
	TradeRecord,
} from './types';

const driftEnv = (process.env.ENV || 'mainnet-beta') as VelocityEnv;
const { SPOT_MARKETS, PERP_MARKETS } = initialize({ env: driftEnv });

export const batchArray = <T>(array: T[], batchSize: number): T[][] => {
	const batches: T[][] = [];
	for (let i = 0; i < array.length; i += batchSize) {
		batches.push(array.slice(i, i + batchSize));
	}
	return batches;
};

export const sleep = async (ms: number) => {
	return new Promise((resolve) => setTimeout(resolve, ms));
};

export const enumToStr = (enumStr: Record<string, any>) => {
	return Object.keys(enumStr ?? {})?.[0];
};

export const bnStringToNumber = (value: string | undefined, precision?: BN): number => {
	if (!value) return 0;
	const bn = new BN(value);
	if (!precision) return bn.toNumber();
	return bn.div(precision).toNumber() + bn.mod(precision).toNumber() / precision.toNumber();
};

export const getTimestamp = ({
	days = 0,
	hours = 0,
	minutes = 0,
}: {
	days?: number;
	hours?: number;
	minutes?: number;
} = {}) => {
	const date = new Date();

	date.setDate(date.getDate() + days);
	date.setHours(date.getHours() + hours);
	date.setMinutes(date.getMinutes() + minutes);

	return Math.floor(date.getTime() / 1000);
};

export const getTimestampHour = ({
	days = 0,
	hours = 0,
}: {
	days?: number;
	hours?: number;
	minutes?: number;
} = {}) => {
	const date = new Date();
	date.setUTCDate(date.getUTCDate() + days);
	date.setUTCHours(date.getUTCHours() + hours);

	date.setUTCMinutes(0);
	date.setUTCSeconds(0);
	date.setUTCMilliseconds(0);

	return Math.floor(date.getTime() / 1000);
};

export const getTimestampDay = ({
	days = 0,
	months = 0,
}: {
	days?: number;
	months?: number;
} = {}) => {
	const date = new Date();
	date.setUTCMonth(date.getUTCMonth() + months);
	date.setUTCDate(date.getUTCDate() + days);

	date.setUTCHours(0);
	date.setUTCMinutes(0);
	date.setUTCSeconds(0);
	date.setUTCMilliseconds(0);

	return Math.floor(date.getTime() / 1000);
};

export const roundToDay = (timestamp: number): number => {
	const DAY_IN_SECONDS = 24 * 60 * 60;
	return Math.floor(timestamp / DAY_IN_SECONDS) * DAY_IN_SECONDS;
};

export const roundToHour = (ts: number): number => {
	const HOUR_IN_SECONDS = 60 * 60;
	return Math.floor(ts / HOUR_IN_SECONDS) * HOUR_IN_SECONDS;
};

export const getUTCDayFromTimestamp = (timestamp: number): string => {
	return new Date(timestamp * 1000).toISOString().split('T')[0];
};

export const getTimestampsWithInterval = (
	startTimestamp: number,
	endTimestamp: number,
	intervalHours = 1
): number[] => {
	const timestamps: number[] = [];
	const HOUR_IN_SECONDS = 60 * 60;
	const intervalInSeconds = intervalHours * HOUR_IN_SECONDS;

	for (
		let timestamp = startTimestamp;
		timestamp <= endTimestamp;
		timestamp += intervalInSeconds
	) {
		timestamps.push(timestamp);
	}

	return timestamps;
};

export const getOrderStatus = (
	action: string,
	totalBaseAmountFilled: number,
	baseAssetAmount: number
): LastOrderStatus => {
	switch (action) {
		case OrderAction.CANCEL:
			return totalBaseAmountFilled > 0
				? LastOrderStatus.PARTIAL_FILL_CANCEL
				: LastOrderStatus.CANCELLED;
		case OrderAction.FILL:
			return baseAssetAmount === totalBaseAmountFilled
				? LastOrderStatus.FILLED
				: LastOrderStatus.PARTIAL_FILL;
		case OrderAction.PLACE:
			return LastOrderStatus.OPEN;
		case OrderAction.EXPIRE:
			return LastOrderStatus.EXPIRED;
		default:
			return totalBaseAmountFilled > 0
				? LastOrderStatus.PARTIAL_FILL
				: LastOrderStatus.TRIGGERED;
	}
};

export const getActionPriority = (action: string): number => {
	const priorities: Record<string, number> = {
		[OrderAction.CANCEL]: 1,
		[OrderAction.EXPIRE]: 2,
		[OrderAction.FILL]: 3,
		[OrderAction.TRIGGER]: 4,
		[OrderAction.PLACE]: 5,
	};

	return priorities[action] || 99;
};

export const compareActions = (a: OrderActionRecord, b: OrderActionRecord): number => {
	if (a.ts !== b.ts) return b.ts - a.ts;
	if (a.slot !== b.slot) return b.slot - a.slot;
	const aPriority = getActionPriority(a.action);
	const bPriority = getActionPriority(b.action);

	if (aPriority !== bPriority) {
		return aPriority - bPriority;
	}

	if (a.action === OrderAction.FILL && b.action === OrderAction.FILL) {
		return parseInt(b.fillRecordId || '0') - parseInt(a.fillRecordId || '0');
	}

	return 0;
};

export const isOrderInactive = (status: LastOrderStatus): boolean => {
	return [
		LastOrderStatus.FILLED,
		LastOrderStatus.CANCELLED,
		LastOrderStatus.PARTIAL_FILL_CANCEL,
		LastOrderStatus.EXPIRED,
	].includes(status);
};

export const getResolutionSeconds = (resolution: CandleResolutions): number => {
	switch (resolution) {
		case '1':
			return 60;
		case '5':
			return 5 * 60;
		case '15':
			return 15 * 60;
		case '60':
			return 60 * 60;
		case '240':
			return 4 * 60 * 60;
		case 'D':
			return 24 * 60 * 60;
		case 'W':
			return 7 * 24 * 60 * 60;
		case 'M':
			return 30 * 24 * 60 * 60;
		default:
			throw Error(`Invalid resolution: ${resolution}`);
	}
};

export const isOrderFullyFilled = (record: OrderActionRecord): boolean => {
	const key = record.taker === record.user ? 'taker' : 'maker';
	const baseAmount = record[`${key}OrderBaseAssetAmount`];
	const baseFilled = record[`${key}OrderCumulativeBaseAssetAmountFilled`];

	return baseAmount === baseFilled;
};

export const getOrderLabel = (order: any): OrderLabel | null => {
	const hasValidTrigger = order.triggerPrice && order.triggerPrice > 0;
	const hasOracleOffset =
		typeof order.oraclePriceOffset?.eqZero === 'function'
			? !order.oraclePriceOffset.eqZero()
			: Number(order.oraclePriceOffset || 0) !== 0;

	if (order.orderType === enumToStr(OrderType.LIMIT)) {
		if (hasOracleOffset) {
			return OrderLabel.ORACLE_LIMIT;
		}
		return OrderLabel.LIMIT;
	}

	if (
		(order.orderType === enumToStr(OrderType.TRIGGER_MARKET) ||
			order.orderType === enumToStr(OrderType.TRIGGER_LIMIT)) &&
		hasValidTrigger
	) {
		const isMarketOrder = order.orderType === enumToStr(OrderType.TRIGGER_MARKET);

		if (order.triggerCondition === enumToStr(OrderTriggerCondition.ABOVE)) {
			return isMarketOrder ? OrderLabel.TAKE_PROFIT_MARKET : OrderLabel.TAKE_PROFIT_LIMIT;
		} else {
			return isMarketOrder ? OrderLabel.STOP_MARKET : OrderLabel.STOP_LIMIT;
		}
	}

	return null;
};

export const getSpotMarkets = () => {
	return SPOT_MARKETS;
};

export const getPerpMarkets = () => {
	return PERP_MARKETS;
};

export const getSpotMarketSymbol = (marketIndex: number) => {
	return SPOT_MARKETS.find((x) => x.marketIndex === marketIndex)?.symbol ?? 'NA';
};

export const getPerpMarketSymbol = (marketIndex: number) => {
	return PERP_MARKETS.find((x) => x.marketIndex === marketIndex)?.symbol ?? 'NA';
};

export const isFeatureEnabled = (flagName: string, defaultValue = false) => {
	const envVarName = `ENABLE_${flagName}`;
	const envValue = process.env[envVarName];

	if (envValue === undefined) {
		return defaultValue;
	}

	return envValue.toLowerCase() === 'true';
};

export const filterOutKeys = <T extends Record<string, any>>(
	object: T,
	keys?: string[]
): Partial<T> => {
	// Additional keys not needed outside of infra
	let defaultKeys = ['pk', 'sk', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'source', 'ttl'];

	if (keys) {
		defaultKeys = keys;
	}

	const filteredObject = { ...object };

	defaultKeys.forEach((key) => {
		if (key in filteredObject) {
			delete filteredObject[key];
		}
	});

	return filteredObject;
};

export const parseSQSMessageFromDynamoEvent = <T = any>(
	body: string | undefined
): T | undefined => {
	if (!body) return undefined;

	const parsedMessage = JSON.parse(body ?? '{}');

	if (!parsedMessage?.detail?.dynamodb) {
		return undefined;
	}

	const {
		detail: {
			dynamodb: { NewImage = null },
		},
	} = parsedMessage;

	if (!NewImage) return undefined;

	return unmarshall(NewImage) as T;
};

export const calculatePnlFromTrade = (
	trade: TradeRecord,
	includeFees: boolean = true,
	side: 'taker' | 'maker' = 'taker'
): Decimal => {
	const {
		taker,
		maker,
		quoteAssetAmountFilled,
		baseAssetAmountFilled,
		takerExistingQuoteEntryAmount,
		takerExistingBaseAssetAmount,
		makerExistingQuoteEntryAmount,
		makerExistingBaseAssetAmount,
		takerFee,
		makerFee,
		takerOrderDirection,
		makerOrderDirection,
	} = trade;

	if (side === 'taker' && !taker) return new Decimal(0);
	if (side === 'maker' && !maker) return new Decimal(0);

	let pnl = new Decimal(0);

	const existingQuoteEntry =
		side === 'taker'
			? new Decimal(takerExistingQuoteEntryAmount ?? 0)
			: new Decimal(makerExistingQuoteEntryAmount ?? 0);

	const existingBase =
		side === 'taker'
			? new Decimal(takerExistingBaseAssetAmount ?? 0)
			: new Decimal(makerExistingBaseAssetAmount ?? 0);

	const fee = side === 'taker' ? new Decimal(takerFee ?? 0) : new Decimal(makerFee ?? 0);

	const orderDirection = side === 'taker' ? takerOrderDirection : makerOrderDirection;

	const baseFilled = new Decimal(baseAssetAmountFilled ?? 0);
	const baseForEntryPrice = existingBase.gt(0) ? existingBase : baseFilled;
	const quoteFilled = new Decimal(quoteAssetAmountFilled ?? 0);

	if (existingQuoteEntry.gt(0) && baseForEntryPrice.gt(0)) {
		const avgExitPrice = baseFilled.gt(0) ? quoteFilled.div(baseFilled) : new Decimal(0);

		const entryPrice = baseForEntryPrice.gt(0)
			? existingQuoteEntry.div(baseForEntryPrice)
			: new Decimal(0);

		const baseAmount = baseForEntryPrice.toNumber();

		const pnlBeforeFee =
			orderDirection === enumToStr(PositionDirection.SHORT)
				? avgExitPrice.minus(entryPrice).mul(baseAmount)
				: entryPrice.minus(avgExitPrice).mul(baseAmount);

		if (includeFees) {
			pnl = pnlBeforeFee.minus(fee).toSignificantDigits(QUOTE_PRECISION_EXP.toNumber());
		} else {
			pnl = pnlBeforeFee.toSignificantDigits(QUOTE_PRECISION_EXP.toNumber());
		}
	}

	return pnl;
};

// We only get RAW data from athena. Transform it to the required format
export const formatTradesFromAthenaForLeaderboard = (trades: any): TradeRecord[] => {
	const spotMarkets = getSpotMarkets();
	const perpMarkets = getPerpMarkets();

	return trades.map((trade: any) => {
		const market =
			trade.markettype === SerializedMarketFilter.SPOT
				? spotMarkets.find((x) => x.marketIndex === Number(trade.marketindex))
				: perpMarkets.find((x) => x.marketIndex === Number(trade.marketindex));

		const symbol = market?.symbol ?? 'NA';
		const basePrecision =
			trade.markettype === SerializedMarketFilter.SPOT
				? (market as SpotMarketConfig).precision || BASE_PRECISION
				: BASE_PRECISION;

		return {
			symbol,
			taker: trade.taker,
			maker: trade.maker,
			quoteAssetAmountFilled: bnStringToNumber(trade.quoteassetamountfilled, QUOTE_PRECISION),
			baseAssetAmountFilled: bnStringToNumber(trade.baseassetamountfilled, basePrecision),
			takerFee: bnStringToNumber(trade.takerfee, QUOTE_PRECISION),
			makerFee: bnStringToNumber(trade.makerfee, QUOTE_PRECISION),
			takerOrderDirection: trade.takerorderdirection,
			makerOrderDirection: trade.makerorderdirection,
			takerExistingQuoteEntryAmount: trade.takerexistingquoteentryamount
				? bnStringToNumber(trade.takerexistingquoteentryamount, QUOTE_PRECISION)
				: null,
			takerExistingBaseAssetAmount: trade.takerexistingbaseassetamount
				? bnStringToNumber(trade.takerexistingbaseassetamount, basePrecision)
				: null,
			makerExistingQuoteEntryAmount: trade.makerexistingquoteentryamount
				? bnStringToNumber(trade.makerexistingquoteentryamount, QUOTE_PRECISION)
				: null,
			makerExistingBaseAssetAmount: trade.makerexistingbaseassetamount
				? bnStringToNumber(trade.makerexistingbaseassetamount, basePrecision)
				: null,
		};
	});
};

export const getShard = (id: string, numShards: number): number => {
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = (hash << 5) - hash + id.charCodeAt(i);
		hash = hash & hash;
	}
	return Math.abs(hash) % numShards;
};
