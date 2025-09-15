import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { OracleSource } from '../types';

export type MMOraclePriceData = Omit<
	OraclePriceData,
	'twap' | 'twapConfidence' | 'maxPrice'
> & {
	isMMOracleActive: boolean;
};

export type OraclePriceData = {
	price: BN;
	slot: BN;
	confidence: BN;
	hasSufficientNumberOfDataPoints: boolean;
	twap?: BN;
	twapConfidence?: BN;
	maxPrice?: BN; // pre-launch markets only
	sequenceId?: BN;
};

export type OracleInfo = {
	publicKey: PublicKey;
	source: OracleSource;
};

export interface OracleClient {
	getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData;
	getOraclePriceData(publicKey: PublicKey): Promise<OraclePriceData>;
}
