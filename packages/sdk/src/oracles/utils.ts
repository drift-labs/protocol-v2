import { Connection, PublicKey } from '@solana/web3.js';
import { BN } from '../isomorphic/anchor';
import { OraclePriceData } from './types';

/**
 * Fetches an account's raw data, throwing if the account does not exist. Shared by every
 * `OracleClient.getOraclePriceData` implementation so a missing oracle account fails loudly rather
 * than silently decoding garbage/zeroed data.
 * @param connection - RPC connection to fetch from.
 * @param pricePublicKey - The oracle account's address.
 * @param oracleName - Human-readable oracle name used only in the thrown error message (e.g. `"Pyth oracle"`).
 * @returns The account's raw data buffer.
 * @throws Error if the account does not exist.
 */
export async function getOracleAccountDataOrThrow(
	connection: Connection,
	pricePublicKey: PublicKey,
	oracleName: string
): Promise<Buffer> {
	const accountInfo = await connection.getAccountInfo(pricePublicKey);
	if (!accountInfo) {
		throw new Error(
			`${oracleName} account not found: ${pricePublicKey.toBase58()}`
		);
	}
	return accountInfo.data;
}

/**
 * Derives an effective confidence interval for the market-maker (MM) oracle price by widening the
 * primary oracle's confidence by however far the MM price has diverged from it. Used when
 * validating the MM oracle (via `getOracleValidity`) so a large MM/primary-oracle divergence
 * degrades MM-oracle validity the same way low primary-oracle confidence would, rather than
 * evaluating MM price divergence with an artificially tight confidence band.
 * @param mmOraclePrice - The perp market's cached MM oracle price, PRICE_PRECISION (1e6).
 * @param oraclePriceData - The primary oracle's current price data (`price`/`confidence` in PRICE_PRECISION, 1e6).
 * @returns `oraclePriceData.confidence + |mmOraclePrice - oraclePriceData.price|`, PRICE_PRECISION (1e6).
 */
export function getOracleConfidenceFromMMOracleData(
	mmOraclePrice: BN,
	oraclePriceData: OraclePriceData
): BN {
	const mmOracleDiffPremium = mmOraclePrice.sub(oraclePriceData.price).abs();
	return oraclePriceData.confidence.add(mmOracleDiffPremium);
}
