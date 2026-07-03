import { Connection, PublicKey } from '@solana/web3.js';
import { OracleClient, OraclePriceData } from './types';
import { VelocityProgram } from '../config';
import { PrelaunchOracle } from '../types';
import { getOracleAccountDataOrThrow } from './utils';

/**
 * `OracleClient` for the `PrelaunchOracle` account type — a synthetic, program-managed "oracle"
 * used for perp markets that have not yet listed on a real price feed. Its price is admin/keeper
 * set (via `updatePrelaunchOracleParams`) rather than fed by an external network.
 */
export class PrelaunchOracleClient implements OracleClient {
	private connection: Connection;
	private program: VelocityProgram;

	public constructor(connection: Connection, program: VelocityProgram) {
		this.connection = connection;
		this.program = program;
	}

	/**
	 * Fetches and decodes a `PrelaunchOracle` account's current price data.
	 * @param pricePublicKey - The `PrelaunchOracle` account's address (see `getPrelaunchOraclePublicKey`).
	 * @returns The decoded price data.
	 * @throws Error if the account does not exist.
	 */
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

	/**
	 * Decodes raw `PrelaunchOracle` account bytes into normalized `OraclePriceData`. Note `slot` is
	 * populated from `ammLastUpdateSlot` (the last time the paired AMM used this price), not a
	 * slot recorded by the oracle account itself, and `hasSufficientNumberOfDataPoints` is always
	 * `true` since there is no publisher-count concept for this source.
	 * @param buffer - Raw `PrelaunchOracle` account data.
	 * @returns Price (`price`), confidence (`confidence`, both PRICE_PRECISION 1e6), and the
	 * prelaunch-only upper bound (`maxPrice`, PRICE_PRECISION 1e6).
	 */
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
