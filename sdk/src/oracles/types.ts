import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { OracleSource } from '../types';

export type MMOraclePriceData = {
	mmOraclePrice: BN;
	mmOracleSlot: BN;
	oraclePriceData: OraclePriceData;
};

export type OraclePriceData = {
	price: BN;
	slot: BN;
	confidence: BN;
	hasSufficientNumberOfDataPoints: boolean;
	twap?: BN;
	twapConfidence?: BN;
	maxPrice?: BN; // pre-launch markets only
	fetchedWithMMOracle?: boolean;
	isMMOracleActive?: boolean;
};

export type OracleInfo = {
	publicKey: PublicKey;
	source: OracleSource;
};

export interface OracleClient {
	getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData;
	getOraclePriceData(publicKey: PublicKey): Promise<OraclePriceData>;
}
