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

export class PythClient implements OracleClient {
	private connection: Connection;
	private multiple: BN;
	private stableCoin: boolean;

	public constructor(
		connection: Connection,
		multiple = ONE,
		stableCoin = false
	) {
		this.connection = connection;
		this.multiple = multiple;
		this.stableCoin = stableCoin;
	}

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
	if (price.sub(QUOTE_PRECISION).abs().lt(BN.min(confidence, fiveBPS))) {
		return QUOTE_PRECISION;
	} else {
		return price;
	}
}
