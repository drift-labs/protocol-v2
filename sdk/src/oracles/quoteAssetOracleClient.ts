import { PublicKey } from '@solana/web3.js';
import { OracleClient, OraclePriceData } from './types';
import { BN } from '@coral-xyz/anchor';
import { PRICE_PRECISION } from '../constants/numericConstants';

export const QUOTE_ORACLE_PRICE_DATA: OraclePriceData = {
	price: PRICE_PRECISION,
	slot: new BN(0),
	confidence: new BN(1),
	hasSufficientNumberOfDataPoints: true,
};

export class QuoteAssetOracleClient implements OracleClient {
	public constructor() {}

	public async getOraclePriceData(
		_pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		return Promise.resolve(QUOTE_ORACLE_PRICE_DATA);
	}

	public getOraclePriceDataFromBuffer(_buffer: Buffer): OraclePriceData {
		return QUOTE_ORACLE_PRICE_DATA;
	}
}
