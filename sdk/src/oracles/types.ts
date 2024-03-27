import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { OracleSource } from '../types';

export type OraclePriceData = {
	price: BN;
	slot: BN;
	confidence: BN;
	hasSufficientNumberOfDataPoints: boolean;
	twap?: BN;
	twapConfidence?: BN;
	maxPrice?: BN; // pre-launch markets only
};

export type OracleInfo = {
	publicKey: PublicKey;
	source: OracleSource;
};

export interface OracleClient {
	getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData;
	getOraclePriceData(publicKey: PublicKey): Promise<OraclePriceData>;
}
