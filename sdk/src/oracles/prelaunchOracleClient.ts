import { Connection, PublicKey } from '@solana/web3.js';
import { OracleClient, OraclePriceData } from './types';
import { PrelaunchOracle } from '../types';
import { DriftProgram } from '../config';

export class PrelaunchOracleClient implements OracleClient {
	private connection: Connection;
	private program: DriftProgram;

	public constructor(connection: Connection, program: DriftProgram) {
		this.connection = connection;
		this.program = program;
	}

	public async getOraclePriceData(
		pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		const accountInfo = await this.connection.getAccountInfo(pricePublicKey);
		return this.getOraclePriceDataFromBuffer(accountInfo.data);
	}

	public getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData {
		const prelaunchOracle =
			this.program.account.prelaunchOracle.coder.accounts.decodeUnchecked(
				'prelaunchOracle',
				buffer
			) as PrelaunchOracle;

		return {
			price: prelaunchOracle.price,
			slot: prelaunchOracle.ammLastUpdateSlot,
			confidence: prelaunchOracle.confidence,
			hasSufficientNumberOfDataPoints: true,
			maxPrice: prelaunchOracle.maxPrice,
		};
	}
}
