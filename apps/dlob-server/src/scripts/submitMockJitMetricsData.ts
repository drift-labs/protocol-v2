import { RedisClient } from '@velocity-exchange/common/clients';

require('dotenv').config();

const mockFillPort = process.env.MOCK_FILL_PORT
	? parseInt(process.env.MOCK_FILL_PORT)
	: 9470;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type MockQuote = {
	maker: string;
	side: 'long' | 'short';
	price: number;
	size: number;
};

type MockFill = {
	maker: string;
	side: 'long' | 'short';
	fillPrice: number;
	fillSize: number;
	oraclePrice: number;
};

const parseJsonArrayEnv = <T>(
	envValue: string | undefined
): T[] | undefined => {
	if (!envValue) {
		return undefined;
	}
	return JSON.parse(envValue) as T[];
};

const groupQuotesByMaker = (quotes: MockQuote[]) => {
	const grouped = new Map<string, MockQuote[]>();
	for (const quote of quotes) {
		const makerQuotes = grouped.get(quote.maker) ?? [];
		makerQuotes.push(quote);
		grouped.set(quote.maker, makerQuotes);
	}
	return grouped;
};

const main = async () => {
	const indicativeRedisClient = new RedisClient({});
	await indicativeRedisClient.connect();

	const marketType = process.env.MOCK_MARKET_TYPE || 'perp';
	const marketIndex = parseInt(process.env.MOCK_MARKET_INDEX || '0');
	const now = Date.now();
	const quotes = parseJsonArrayEnv<MockQuote>(process.env.MOCK_QUOTES_JSON);
	const fills = parseJsonArrayEnv<MockFill>(process.env.MOCK_FILLS_JSON);
	if (!quotes?.length) {
		throw new Error('MOCK_QUOTES_JSON must contain at least one quote');
	}
	if (!fills?.length) {
		throw new Error('MOCK_FILLS_JSON must contain at least one fill');
	}
	const marketMmsKey = `market_mms_${marketType}_${marketIndex}`;
	const existingMakers = await indicativeRedisClient.smembers(marketMmsKey);
	const existingQuoteKeys = existingMakers.map(
		(maker) => `mm_quotes_v2_${marketType}_${marketIndex}_${maker}`
	);

	if (existingQuoteKeys.length > 0) {
		await indicativeRedisClient.delete(...existingQuoteKeys);
	}
	await indicativeRedisClient.delete(marketMmsKey);

	await indicativeRedisClient
		.forceGetClient()
		.sadd(marketMmsKey, ...quotes.map((quote) => quote.maker));

	const quotesByMaker = groupQuotesByMaker(quotes);

	for (const [maker, makerQuotes] of quotesByMaker.entries()) {
		await indicativeRedisClient.set(
			`mm_quotes_v2_${marketType}_${marketIndex}_${maker}`,
			{
				ts: now,
				quotes: makerQuotes.map((quote) =>
					quote.side === 'long'
						? {
								bid_price: Math.round(quote.price * 1_000_000),
								bid_size: Math.round(quote.size * 1_000_000_000),
						  }
						: {
								ask_price: Math.round(quote.price * 1_000_000),
								ask_size: Math.round(quote.size * 1_000_000_000),
						  }
				),
			}
		);
	}

	await sleep(100);

	for (const [idx, fill] of fills.entries()) {
		const fillEvent = {
			ts: now + idx,
			marketIndex,
			marketType,
			filler: 'mock-filler',
			takerFee: 0,
			makerFee: 0,
			quoteAssetAmountSurplus: 0,
			baseAssetAmountFilled: fill.fillSize,
			quoteAssetAmountFilled: fill.fillPrice * fill.fillSize,
			taker: 'mock-taker',
			takerOrderId: idx + 1,
			takerOrderDirection: fill.side === 'long' ? 'short' : 'long',
			takerOrderBaseAssetAmount: fill.fillSize,
			takerOrderCumulativeBaseAssetAmountFilled: fill.fillSize,
			takerOrderCumulativeQuoteAssetAmountFilled:
				fill.fillPrice * fill.fillSize,
			maker: fill.maker,
			makerOrderId: idx + 100,
			makerOrderDirection: fill.side,
			makerOrderBaseAssetAmount: fill.fillSize,
			makerOrderCumulativeBaseAssetAmountFilled: fill.fillSize,
			makerOrderCumulativeQuoteAssetAmountFilled:
				fill.fillPrice * fill.fillSize,
			oraclePrice: fill.oraclePrice,
			txSig: `mock-${now}-${idx}`,
			slot: idx + 1,
			fillRecordId: idx + 1,
			action: 'fill',
			actionExplanation: 'none',
			referrerReward: 0,
			bitFlags: 0,
		};

		const response = await fetch(`http://localhost:${mockFillPort}/mockFill`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify(fillEvent),
		});

		console.log(await response.text());
	}
};

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
