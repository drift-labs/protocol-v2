import { Connection, PublicKey } from '@solana/web3.js';
import { OracleClient, OraclePriceData } from './types';
import { BN, BorshAccountsCoder, Idl } from '@coral-xyz/anchor';
import switchboardOnDemandIdl from '../idl/switchboard_on_demand.json';
import { PRICE_PRECISION_EXP } from '../constants/numericConstants';

const SB_PRECISION_EXP = new BN(18);
const SB_PRECISION = new BN(10).pow(SB_PRECISION_EXP.sub(PRICE_PRECISION_EXP));

type PullFeedAccountData = {
	result: {
		value: BN;
		stdDev: BN;
		mean: BN;
		slot: BN;
	};
	lastUpdateTimestamp: number;
	maxVariance: number;
	minResponses: number;
};

export class SwitchboardOnDemandClient implements OracleClient {
	connection: Connection;
	coder?: BorshAccountsCoder;

	public constructor(connection: Connection) {
		this.connection = connection;
		this.coder = new BorshAccountsCoder(switchboardOnDemandIdl as Idl);
	}

	public async getOraclePriceData(
		pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		const accountInfo = await this.connection.getAccountInfo(pricePublicKey);
		return this.getOraclePriceDataFromBuffer(accountInfo.data);
	}

	public getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData {
		const pullFeedAccountData = this.coder.decodeUnchecked(
			'PullFeedAccountData',
			buffer
		) as PullFeedAccountData;

		return {
			price: pullFeedAccountData.result.value.div(SB_PRECISION),
			slot: pullFeedAccountData.result.slot,
			confidence: pullFeedAccountData.result.stdDev.div(SB_PRECISION),
			hasSufficientNumberOfDataPoints: true,
		};
	}
}
