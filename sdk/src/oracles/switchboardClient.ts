import { SwitchboardDecimal } from '@switchboard-xyz/switchboard-v2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { BN, Program, Idl, AnchorProvider } from '@project-serum/anchor';
import { MARK_PRICE_PRECISION, TEN } from '../constants/numericConstants';
import { OracleClient, OraclePriceData } from './types';
import { Wallet } from '../wallet';
import switchboardV2Idl from '../idl/switchboard_v2.json';

let program: Program | undefined;

export class SwitchboardClient implements OracleClient {
	connection: Connection;

	public constructor(connection: Connection) {
		this.connection = connection;
	}

	public async getOraclePriceData(
		pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		const accountInfo = await this.connection.getAccountInfo(pricePublicKey);
		return this.getOraclePriceDataFromBuffer(accountInfo.data);
	}

	public getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData {
		const program = this.getProgram();

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

		const hasSufficientNumberOfDataPoints =
			aggregatorAccountData.latestConfirmedRound.numSuccess >=
			aggregatorAccountData.minOracleResults;

		const slot: BN = aggregatorAccountData.latestConfirmedRound.roundOpenSlot;
		return {
			price,
			slot,
			confidence,
			hasSufficientNumberOfDataPoints,
		};
	}

	public getProgram(): Program {
		if (program) {
			return program;
		}

		program = getSwitchboardProgram(this.connection);
		return program;
	}
}

function getSwitchboardProgram(connection: Connection): Program {
	const DEFAULT_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(1));
	const programId = PublicKey.default;
	const wallet = new Wallet(DEFAULT_KEYPAIR);
	const provider = new AnchorProvider(connection, wallet, {});

	return new Program(switchboardV2Idl as Idl, programId, provider);
}

function convertSwitchboardDecimal(switchboardDecimal: SwitchboardDecimal): BN {
	const switchboardPrecision = TEN.pow(new BN(switchboardDecimal.scale));
	return switchboardDecimal.mantissa
		.mul(MARK_PRICE_PRECISION)
		.div(switchboardPrecision);
}
