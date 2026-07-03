import { PublicKey } from '@solana/web3.js';
import { OracleClient, OraclePriceData } from './types';
import { BN } from '../isomorphic/anchor';
import { PRICE_PRECISION } from '../constants/numericConstants';

/**
 * Fixed price of exactly 1.0 (PRICE_PRECISION, 1e6) with a minimal confidence band, returned by
 * `QuoteAssetOracleClient` for any oracle lookup. Represents the quote asset (e.g. USDC) pegged
 * 1:1 to itself with no real oracle needed.
 */
export const QUOTE_ORACLE_PRICE_DATA: OraclePriceData = {
	price: PRICE_PRECISION,
	slot: new BN(0),
	confidence: new BN(1),
	hasSufficientNumberOfDataPoints: true,
};

/**
 * `OracleClient` for the `quoteAsset` `OracleSource` variant — the spot market whose asset *is*
 * the protocol's quote currency. Ignores its inputs entirely and always returns the constant
 * `QUOTE_ORACLE_PRICE_DATA` (price 1.0); never makes an RPC call.
 */
export class QuoteAssetOracleClient implements OracleClient {
	public constructor() {}

	/**
	 * @param _pricePublicKey - Ignored.
	 * @returns The constant `QUOTE_ORACLE_PRICE_DATA`.
	 */
	public async getOraclePriceData(
		_pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		return Promise.resolve(QUOTE_ORACLE_PRICE_DATA);
	}

	/**
	 * @param _buffer - Ignored.
	 * @returns The constant `QUOTE_ORACLE_PRICE_DATA`.
	 */
	public getOraclePriceDataFromBuffer(_buffer: Buffer): OraclePriceData {
		return QUOTE_ORACLE_PRICE_DATA;
	}
}
