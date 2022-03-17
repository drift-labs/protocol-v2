import {
	loadSwitchboardProgram,
	SwitchboardDecimal,
} from '@switchboard-xyz/switchboard-v2';
import { Connection, PublicKey } from '@solana/web3.js';
import { DriftEnv } from '../config';
import { BN } from '@project-serum/anchor';
import { MARK_PRICE_PRECISION, TEN } from '../constants/numericConstants';
import { OracleClient, OraclePriceData } from './types';

type Program = ReturnType<typeof loadSwitchboardProgram>;

// cache switchboard program for every client object since itll always be the same
const programMap = new Map<string, Program>();

export class SwitchboardClient implements OracleClient {
	connection: Connection;
	env: DriftEnv;

	public constructor(connection: Connection, env: DriftEnv) {
		this.connection = connection;
		this.env = env;
	}

	public async getOraclePriceData(
		pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		const accountInfo = await this.connection.getAccountInfo(pricePublicKey);
		return this.getOraclePriceDataFromBuffer(accountInfo.data);
	}

	public async getOraclePriceDataFromBuffer(
		buffer: Buffer
	): Promise<OraclePriceData> {
		const program = await this.getProgram();

		const aggregatorAccountData =
			program.account.aggregatorAccountData.coder.accounts.decode(
				'AggregatorAccountData',
				buffer
			);
		const price = convertSwitchboardDecimal(
			aggregatorAccountData.latestConfirmedRound.result as SwitchboardDecimal
		);

		const confidence = convertSwitchboardDecimal(
			aggregatorAccountData.latestConfirmedRound
				.stdDeviation as SwitchboardDecimal
		);

		const slot: BN = aggregatorAccountData.latestConfirmedRound.roundOpenSlot;
		return {
			price,
			slot,
			confidence,
		};
	}

	public async getProgram(): Promise<Program> {
		if (programMap.has(this.env)) {
			return programMap.get(this.env);
		}

		const program = loadSwitchboardProgram(this.env, this.connection);
		programMap.set(this.env, program);
		return program;
	}
}

function convertSwitchboardDecimal(switchboardDecimal: SwitchboardDecimal): BN {
	const switchboardPrecision = TEN.pow(new BN(switchboardDecimal.scale));
	return switchboardDecimal.mantissa
		.mul(MARK_PRICE_PRECISION)
		.div(switchboardPrecision);
}
