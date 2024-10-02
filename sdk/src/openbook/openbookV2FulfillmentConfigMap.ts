import { PublicKey } from '@solana/web3.js';
import { OpenbookV2FulfillmentConfigAccount } from '../types';
import { DriftClient } from '../driftClient';

export class OpenbookV2FulfillmentConfigMap {
	driftClient: DriftClient;
	map = new Map<number, OpenbookV2FulfillmentConfigAccount>();

	public constructor(driftClient: DriftClient) {
		this.driftClient = driftClient;
	}

	public async add(
		marketIndex: number,
		openbookV2MarketAddress: PublicKey
	): Promise<void> {
		const account = await this.driftClient.getOpenbookV2FulfillmentConfig(
			openbookV2MarketAddress
		);

		this.map.set(marketIndex, account);
	}

	public get(
		marketIndex: number
	): OpenbookV2FulfillmentConfigAccount | undefined {
		return this.map.get(marketIndex);
	}
}
