import { Connection, PublicKey } from '@solana/web3.js';
import { BN } from '../isomorphic/anchor';
import { OraclePriceData } from './types';

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

export function getOracleConfidenceFromMMOracleData(
	mmOraclePrice: BN,
	oraclePriceData: OraclePriceData
): BN {
	const mmOracleDiffPremium = mmOraclePrice.sub(oraclePriceData.price).abs();
	return oraclePriceData.confidence.add(mmOracleDiffPremium);
}
