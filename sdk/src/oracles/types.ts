/**
 * Oracle types and the OraclePriceData interface used throughout the SDK.
 * Each oracle source (Pyth, Switchboard, Pyth Lazer, Prelaunch) has a client adapter
 * in this directory that fetches and normalises prices into OraclePriceData.
 * Oracle client selection is configured via VelocityClientConfig and cached in OracleClientCache.
 */
import { BN } from '../isomorphic/anchor';
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
