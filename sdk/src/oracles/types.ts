import { BN } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';

export type OraclePriceData = {
	price: BN;
	slot: BN;
	confidence: BN;
	twap?: BN;
	twapConfidence?: BN;
};

export interface OracleClient {
	getOraclePriceDataFromBuffer(buffer: Buffer): Promise<OraclePriceData>;
	getOraclePriceData(publicKey: PublicKey): Promise<OraclePriceData>;
}
