import { BASE_PRECISION, PRICE_PRECISION } from '@velocity-exchange/sdk';

export type FillEventStub = {
	ts: number;
	marketIndex: number;
	marketType: string;
	baseAssetAmountFilled: number;
	quoteAssetAmountFilled: number;
	takerOrderDirection?: string;
	makerOrderDirection?: string;
	oraclePrice: number;
};

export type IndicativeQuoteLevel = {
	bid_price?: number | string | null;
	bid_size?: number | string | null;
	ask_price?: number | string | null;
	ask_size?: number | string | null;
	is_oracle_offset?: boolean;
};

export type IndicativeQuoteBlob = {
	ts?: number | string;
	quotes?: IndicativeQuoteLevel[];
};

export type CompetitiveLiquidity = {
	maker: string;
	size: number;
	bestPrice: number;
	quoteValue: number;
	quoteTsMs: number;
};

export const INDICATIVE_BPS_BUCKETS = [
	{ label: 'very_tight', min: 0, max: 10 },
	{ label: 'tight', min: 10, max: 20 },
	{ label: 'moderate', min: 20, max: 30 },
	{ label: 'wide', min: 30, max: 50 },
	{ label: 'very_wide', min: 50, max: Infinity },
] as const;

/**
 * Extracts a raw indicative quote timestamp in milliseconds.
 */
export const getQuoteTimestampMs = (
	quoteBlob: IndicativeQuoteBlob | null
): number | undefined => {
	const quoteTsMs = Number(quoteBlob?.ts);
	return Number.isFinite(quoteTsMs) ? quoteTsMs : undefined;
};

/**
 * Aggregates a maker's total quoted notional on the relevant side, regardless of whether it was competitive.
 */
export const getQuoteValueOnBook = (
	fillEvent: Pick<FillEventStub, 'oraclePrice' | 'marketIndex' | 'marketType'>,
	side: 'long' | 'short',
	quoteBlob: IndicativeQuoteBlob | null,
	spotMarketPrecision?: number
): number => {
	if (!quoteBlob?.quotes?.length) {
		return 0;
	}

	const basePrecision = getBasePrecisionForFillEvent(
		fillEvent,
		spotMarketPrecision
	);

	return quoteBlob.quotes
		.map((quote) => {
			if (side === 'long') {
				if (!quote.bid_size || quote.bid_price == null) {
					return 0;
				}
				const price = quote.is_oracle_offset
					? rawPriceToNumber(quote.bid_price, fillEvent.oraclePrice)
					: Number(quote.bid_price) / PRICE_PRECISION.toNumber();
				const size = Number(quote.bid_size) / basePrecision;
				return Number.isFinite(price) && Number.isFinite(size)
					? price * size
					: 0;
			}
			if (!quote.ask_size || quote.ask_price == null) {
				return 0;
			}
			const price = quote.is_oracle_offset
				? rawPriceToNumber(quote.ask_price, fillEvent.oraclePrice)
				: Number(quote.ask_price) / PRICE_PRECISION.toNumber();
			const size = Number(quote.ask_size) / basePrecision;
			return Number.isFinite(price) && Number.isFinite(size) ? price * size : 0;
		})
		.filter((notional) => Number.isFinite(notional) && notional > 0)
		.reduce((total, notional) => total + notional, 0);
};

/**
 * Computes the quoted VWAP on the relevant side, capped by the observed fill size.
 */
export const getQuotedFillReferencePrice = (
	fillEvent: Pick<FillEventStub, 'oraclePrice' | 'marketIndex' | 'marketType'>,
	side: 'long' | 'short',
	fillSize: number,
	quoteBlob: IndicativeQuoteBlob | null,
	spotMarketPrecision?: number
): number | undefined => {
	if (
		!quoteBlob?.quotes?.length ||
		!Number.isFinite(fillSize) ||
		fillSize <= 0
	) {
		return undefined;
	}

	const basePrecision = getBasePrecisionForFillEvent(
		fillEvent,
		spotMarketPrecision
	);
	const levels = quoteBlob.quotes
		.map((quote) => {
			const rawPrice = side === 'long' ? quote.bid_price : quote.ask_price;
			const rawSize = side === 'long' ? quote.bid_size : quote.ask_size;
			if (rawPrice == null || rawSize == null) {
				return undefined;
			}

			const price = quote.is_oracle_offset
				? rawPriceToNumber(rawPrice, fillEvent.oraclePrice)
				: Number(rawPrice) / PRICE_PRECISION.toNumber();
			const size = Number(rawSize) / basePrecision;

			return Number.isFinite(price) &&
				price > 0 &&
				Number.isFinite(size) &&
				size > 0
				? { price, size }
				: undefined;
		})
		.filter((level): level is { price: number; size: number } => !!level);

	if (!levels.length) {
		return undefined;
	}

	levels.sort((a, b) =>
		side === 'long' ? b.price - a.price : a.price - b.price
	);

	let remainingSize = fillSize;
	let weightedNotional = 0;
	let consumedSize = 0;

	for (const level of levels) {
		if (remainingSize <= 0) {
			break;
		}
		const sizeToConsume = Math.min(level.size, remainingSize);
		weightedNotional += level.price * sizeToConsume;
		consumedSize += sizeToConsume;
		remainingSize -= sizeToConsume;
	}

	return consumedSize > 0 ? weightedNotional / consumedSize : undefined;
};

/**
 * Computes the executed unit price from the fill event's quote and base amounts.
 */
export const getFillPrice = (
	fillEvent: Pick<
		FillEventStub,
		'baseAssetAmountFilled' | 'quoteAssetAmountFilled'
	>
): number | undefined => {
	if (fillEvent.baseAssetAmountFilled === 0) {
		return undefined;
	}
	return fillEvent.quoteAssetAmountFilled / fillEvent.baseAssetAmountFilled;
};

/**
 * Normalizes the fill timestamp to milliseconds so it can be compared with Redis quote timestamps.
 */
export const getFillTimestampMs = (fillTs: number): number => {
	return fillTs < 1_000_000_000_000 ? fillTs * 1000 : fillTs;
};

/**
 * Infers the maker-side direction for the fill so quotes can be compared on the correct side.
 */
export const getFillSide = (
	fillEvent: Pick<FillEventStub, 'takerOrderDirection' | 'makerOrderDirection'>
): 'long' | 'short' | undefined => {
	if (fillEvent.takerOrderDirection === 'long') {
		return 'short';
	}
	if (fillEvent.takerOrderDirection === 'short') {
		return 'long';
	}
	if (fillEvent.makerOrderDirection === 'long') {
		return 'long';
	}
	if (fillEvent.makerOrderDirection === 'short') {
		return 'short';
	}
	return undefined;
};

/**
 * Builds the common Prometheus label set used for per-maker competitive quote metrics.
 */
export const getMakerMetricAttrs = (
	fillEvent: Pick<FillEventStub, 'marketIndex' | 'marketType'>,
	maker: string,
	side: 'long' | 'short'
) => ({
	market_index: fillEvent.marketIndex,
	market_type: fillEvent.marketType,
	maker,
	side,
});

/**
 * Converts an oracle-offset indicative quote into an absolute display price.
 */
export const rawPriceToNumber = (
	rawPrice: number | string,
	oraclePrice: number
): number => {
	const raw = Number(rawPrice);
	return raw / PRICE_PRECISION + oraclePrice;
};

/**
 * Returns the correct base precision for the fill's market so quote sizes are normalized consistently.
 */
export const getBasePrecisionForFillEvent = (
	fillEvent: Pick<FillEventStub, 'marketIndex' | 'marketType'>,
	spotMarketPrecision?: number
): number => {
	if (fillEvent.marketType === 'spot' && spotMarketPrecision) {
		return spotMarketPrecision;
	}
	return BASE_PRECISION.toNumber();
};

/**
 * Determines whether a quoted price was aggressive enough to have participated at the observed fill price.
 */
export const isCompetitivePrice = (
	side: 'long' | 'short',
	quotePrice: number,
	fillPrice: number
): boolean => {
	if (side === 'long') {
		return quotePrice >= fillPrice;
	}
	return quotePrice <= fillPrice;
};

/**
 * Computes absolute bps difference between a fill price and a reference quote price.
 */
export const getAbsoluteBpsDiff = (
	fillPrice: number,
	quotePrice: number
): number => {
	return Math.abs(((fillPrice - quotePrice) / quotePrice) * 10000);
};

/**
 * Computes signed bps difference between a fill price and a reference quote price.
 */
export const getSignedBpsDiff = (
	fillPrice: number,
	quotePrice: number
): number => {
	return ((fillPrice - quotePrice) / quotePrice) * 10000;
};

/**
 * Buckets an absolute bps distance into the configured indicative spread bands.
 */
export const getIndicativeBpsBucket = (bpsDiff: number): string => {
	for (const bucket of INDICATIVE_BPS_BUCKETS) {
		if (bpsDiff >= bucket.min && bpsDiff < bucket.max) {
			return bucket.label;
		}
	}
	return INDICATIVE_BPS_BUCKETS[INDICATIVE_BPS_BUCKETS.length - 1].label;
};

/**
 * Buckets a signed bps distance into a compact directional classification.
 */
export const getIndicativeDirectionBucket = (signedBpsDiff: number): string => {
	const epsilon = 1e-9;
	if (signedBpsDiff > epsilon) {
		return 'better';
	}
	if (signedBpsDiff < -epsilon) {
		return 'worse';
	}
	return 'equal';
};

/**
 * Aggregates a maker's fresh indicative liquidity that was actually competitive at the observed fill price.
 */
export const getCompetitiveLiquidity = (
	maker: string,
	fillEvent: Pick<FillEventStub, 'oraclePrice' | 'marketIndex' | 'marketType'>,
	side: 'long' | 'short',
	fillPrice: number,
	quoteBlob: IndicativeQuoteBlob | null,
	spotMarketPrecision?: number
): CompetitiveLiquidity | undefined => {
	if (!quoteBlob?.quotes?.length) {
		return undefined;
	}

	const basePrecision = getBasePrecisionForFillEvent(
		fillEvent,
		spotMarketPrecision
	);
	const quoteTsMs = Number(quoteBlob.ts);
	if (!Number.isFinite(quoteTsMs)) {
		return undefined;
	}

	const competitiveLevels = quoteBlob.quotes
		.map((quote) => {
			if (side === 'long') {
				if (quote.bid_price == null || !quote.bid_size) {
					return undefined;
				}
				const price = quote.is_oracle_offset
					? rawPriceToNumber(quote.bid_price, fillEvent.oraclePrice)
					: Number(quote.bid_price) / PRICE_PRECISION.toNumber();
				const size = Number(quote.bid_size) / basePrecision;
				return { price, size };
			}

			if (quote.ask_price == null || !quote.ask_size) {
				return undefined;
			}
			const price = quote.is_oracle_offset
				? rawPriceToNumber(quote.ask_price, fillEvent.oraclePrice)
				: Number(quote.ask_price) / PRICE_PRECISION.toNumber();
			const size = Number(quote.ask_size) / basePrecision;
			return { price, size };
		})
		.filter((quote): quote is { price: number; size: number } => {
			return (
				!!quote &&
				Number.isFinite(quote.price) &&
				Number.isFinite(quote.size) &&
				quote.size > 0 &&
				isCompetitivePrice(side, quote.price, fillPrice)
			);
		});

	if (!competitiveLevels.length) {
		return undefined;
	}

	const bestPrice = competitiveLevels.reduce((best, current) => {
		if (side === 'long') {
			return current.price > best ? current.price : best;
		}
		return current.price < best ? current.price : best;
	}, competitiveLevels[0].price);
	const size = competitiveLevels.reduce(
		(total, current) => total + current.size,
		0
	);
	const quoteValue = competitiveLevels.reduce(
		(total, current) => total + current.price * current.size,
		0
	);

	return {
		maker,
		size,
		bestPrice,
		quoteValue,
		quoteTsMs,
	};
};
