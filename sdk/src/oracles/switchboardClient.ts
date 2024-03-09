import { Connection, PublicKey } from '@solana/web3.js';
import { PRICE_PRECISION, TEN } from '../constants/numericConstants';
import { OracleClient, OraclePriceData } from './types';
import switchboardV2Idl from '../idl/switchboard.json';
import { BorshAccountsCoder, BN, Idl } from '@coral-xyz/anchor';

type SwitchboardDecimal = {
	scale: number;
	mantissa: BN;
};

type AggregatorAccountData = {
	latestConfirmedRound: {
		result: SwitchboardDecimal;
		stdDeviation: SwitchboardDecimal;
		numSuccess: number;
		roundOpenSlot: BN;
	};
	minOracleResults: number;
};

export class SwitchboardClient implements OracleClient {
	connection: Connection;
	coder: BorshAccountsCoder;

	public constructor(connection: Connection) {
		this.connection = connection;
		this.coder = new BorshAccountsCoder(switchboardV2Idl as Idl);
	}

	public async getOraclePriceData(
		pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		const accountInfo = await this.connection.getAccountInfo(pricePublicKey);
		return this.getOraclePriceDataFromBuffer(accountInfo.data);
	}

	public getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData {
		const aggregatorAccountData = this.coder.decodeUnchecked(
			'AggregatorAccountData',
			buffer
		) as AggregatorAccountData;

		const price = convertSwitchboardDecimal(
			aggregatorAccountData.latestConfirmedRound.result
		);

		const confidence = BN.max(
			convertSwitchboardDecimal(
				aggregatorAccountData.latestConfirmedRound.stdDeviation
			),
			price.divn(1000)
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
}

function convertSwitchboardDecimal(switchboardDecimal: {
	scale: number;
	mantissa: BN;
}): BN {
	const switchboardPrecision = TEN.pow(new BN(switchboardDecimal.scale));
	return switchboardDecimal.mantissa
		.mul(PRICE_PRECISION)
		.div(switchboardPrecision);
}
