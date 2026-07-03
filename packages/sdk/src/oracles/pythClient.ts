import { parsePriceData } from '@pythnetwork/client';
import { Connection, PublicKey } from '@solana/web3.js';
import { OracleClient, OraclePriceData } from './types';
import { BN } from '../isomorphic/anchor';
import {
	ONE,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	TEN,
} from '../constants/numericConstants';
import { getOracleAccountDataOrThrow } from './utils';

/**
 * `OracleClient` for legacy (push-model) Pyth price accounts, decoded via `@pythnetwork/client`'s
 * `parsePriceData`. Backs the `pyth`, `pyth1K`, `pyth1M`, and `pythStableCoin` `OracleSource`
 * variants — the `pythPull`/`pyth1KPull`/`pyth1MPull`/`pythStableCoinPull` (Pyth pull-oracle)
 * variants have been removed from the SDK and throw in `getOracleClient`.
 */
export class PythClient implements OracleClient {
	private connection: Connection;
	private multiple: BN;
	private stableCoin: boolean;

	/**
	 * @param connection - RPC connection used to fetch oracle account data.
	 * @param multiple - Divisor applied to the raw Pyth precision before rescaling to
	 * PRICE_PRECISION; pass `1000`/`1000000` for the `pyth1K`/`pyth1M` source variants (feeds
	 * quoted per 1,000 / 1,000,000 units of the underlying), or the default `ONE` (1) for a
	 * standard per-unit feed.
	 * @param stableCoin - When `true` (the `pythStableCoin` variant), snaps the decoded price to
	 * exactly `QUOTE_PRECISION` (1.0) whenever it is within 5bps (or within `confidence` if
	 * tighter) of peg — see `getStableCoinPrice`.
	 */
	public constructor(
		connection: Connection,
		multiple = ONE,
		stableCoin = false
	) {
		this.connection = connection;
		this.multiple = multiple;
		this.stableCoin = stableCoin;
	}

	/**
	 * Fetches and decodes a Pyth price account's current price data.
	 * @param pricePublicKey - The Pyth price account's address.
	 * @returns The decoded, normalized price data.
	 * @throws Error if the account does not exist.
	 */
	public async getOraclePriceData(
		pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		const data = await getOracleAccountDataOrThrow(
			this.connection,
			pricePublicKey,
			'Pyth oracle'
		);
		return this.getOraclePriceDataFromBuffer(data);
	}

	/**
	 * Decodes raw Pyth price account bytes into normalized `OraclePriceData`, rescaling from
	 * Pyth's native exponent to PRICE_PRECISION (1e6) via `convertPythPrice`. `confidence` defaults
	 * to 0 if the account has no confidence field (e.g. uninitialized), and `hasSufficientNumberOfDataPoints`
	 * is `true` only when the number of active quoters is at least `min(numComponentPrices, 3)`.
	 * @param buffer - Raw Pyth price account data.
	 * @returns `price`, `confidence`, `twap`, `twapConfidence` (all PRICE_PRECISION 1e6), `slot`
	 * (the price account's last update slot), and `hasSufficientNumberOfDataPoints`.
	 */
	public getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData {
		const priceData = parsePriceData(buffer);
		// `confidence` is absent on uninitialized/invalid price accounts. Base passed it
		// straight into convertPythPrice, where `undefined * 10**exponent` is `NaN` and
		// `new BN(NaN)` coerces to 0 — so base already yielded a zero-confidence price.
		// `?? 0` makes that explicit and type-checks, preserving the same result.
		const confidence = convertPythPrice(
			priceData.confidence ?? 0,
			priceData.exponent,
			this.multiple
		);
		const minPublishers = Math.min(priceData.numComponentPrices, 3);
		let price = convertPythPrice(
			priceData.aggregate.price,
			priceData.exponent,
			this.multiple
		);
		if (this.stableCoin) {
			price = getStableCoinPrice(price, confidence);
		}

		return {
			price,
			slot: new BN(priceData.lastSlot.toString()),
			confidence,
			twap: convertPythPrice(
				priceData.twap.value,
				priceData.exponent,
				this.multiple
			),
			twapConfidence: convertPythPrice(
				priceData.twac.value,
				priceData.exponent,
				this.multiple
			),
			hasSufficientNumberOfDataPoints: priceData.numQuoters >= minPublishers,
		};
	}
}

function convertPythPrice(price: number, exponent: number, multiple: BN): BN {
	exponent = Math.abs(exponent);
	const pythPrecision = TEN.pow(new BN(exponent).abs()).div(multiple);
	return new BN(price * Math.pow(10, exponent))
		.mul(PRICE_PRECISION)
		.div(pythPrecision);
}

const fiveBPS = new BN(500);
function getStableCoinPrice(price: BN, confidence: BN): BN {
	if (price.sub(QUOTE_PRECISION).abs().lte(BN.min(confidence, fiveBPS))) {
		return QUOTE_PRECISION;
	} else {
		return price;
	}
}
