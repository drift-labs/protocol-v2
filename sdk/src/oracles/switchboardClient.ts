import {
	getSwitchboardPid,
	SwitchboardDecimal,
} from '@switchboard-xyz/switchboard-v2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DriftEnv } from '../config';
import { BN, Provider, Program, Idl } from '@project-serum/anchor';
import { MARK_PRICE_PRECISION, TEN } from '../constants/numericConstants';
import { OracleClient, OraclePriceData } from './types';
import { Wallet } from '../wallet';
import switchboardV2Idl from '../idl/switchboard_v2.json';

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

		const program = await getSwitchboardProgram(this.env, this.connection);
		programMap.set(this.env, program);
		return program;
	}
}

async function getSwitchboardProgram(
	env: DriftEnv,
	connection: Connection
): Promise<Program> {
	const DEFAULT_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(1));
	const programId = getSwitchboardPid(env);
	const wallet = new Wallet(DEFAULT_KEYPAIR);
	const provider = new Provider(connection, wallet, {});

	return new Program(switchboardV2Idl as Idl, programId, provider);
}

function convertSwitchboardDecimal(switchboardDecimal: SwitchboardDecimal): BN {
	const switchboardPrecision = TEN.pow(new BN(switchboardDecimal.scale));
	return switchboardDecimal.mantissa
		.mul(MARK_PRICE_PRECISION)
		.div(switchboardPrecision);
}
