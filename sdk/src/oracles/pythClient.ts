import { parsePriceData } from '@pythnetwork/client';
import { Connection, PublicKey } from '@solana/web3.js';
import { OracleClient, OraclePriceData } from './types';
import { BN } from '@project-serum/anchor';
import { ONE, PRICE_PRECISION, TEN } from '../constants/numericConstants';

export class PythClient implements OracleClient {
	private connection: Connection;
	private multiple: BN;

	public constructor(connection: Connection, multiple = ONE) {
		this.connection = connection;
		this.multiple = multiple;
	}

	public async getOraclePriceData(
		pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		const accountInfo = await this.connection.getAccountInfo(pricePublicKey);
		return this.getOraclePriceDataFromBuffer(accountInfo.data);
	}

	public getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData {
		const priceData = parsePriceData(buffer);
		return {
			price: convertPythPrice(
				priceData.aggregate.price,
				priceData.exponent,
				this.multiple
			),
			slot: new BN(priceData.lastSlot.toString()),
			confidence: convertPythPrice(
				priceData.confidence,
				priceData.exponent,
				this.multiple
			),
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
			hasSufficientNumberOfDataPoints: true,
		};
	}
}

export function convertPythPrice(
	price: number,
	exponent: number,
	multiple: BN
): BN {
	exponent = Math.abs(exponent);
	const pythPrecision = TEN.pow(new BN(exponent).abs()).div(multiple);
	return new BN(price * Math.pow(10, exponent))
		.mul(PRICE_PRECISION)
		.div(pythPrecision);
}
