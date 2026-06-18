import { Connection, PublicKey } from '@solana/web3.js';
import { OracleClient, OraclePriceData } from './types';
import { VelocityProgram } from '../config';
import { PrelaunchOracle } from '../types';
import { getOracleAccountDataOrThrow } from './utils';

export class PrelaunchOracleClient implements OracleClient {
	private connection: Connection;
	private program: VelocityProgram;

	public constructor(connection: Connection, program: VelocityProgram) {
		this.connection = connection;
		this.program = program;
	}

	public async getOraclePriceData(
		pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		const data = await getOracleAccountDataOrThrow(
			this.connection,
			pricePublicKey,
			'Prelaunch oracle'
		);
		return this.getOraclePriceDataFromBuffer(data);
	}

	public getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData {
		const prelaunchOracle = (
			this.program.account as any
		).prelaunchOracle.coder.accounts.decodeUnchecked(
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
