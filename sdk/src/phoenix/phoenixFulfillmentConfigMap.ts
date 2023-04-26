import { PublicKey } from '@solana/web3.js';
import { PhoenixV1FulfillmentConfigAccount } from '../types';
import { DriftClient } from '../driftClient';

export class PhoenixFulfillmentConfigMap {
	driftClient: DriftClient;
	map = new Map<number, PhoenixV1FulfillmentConfigAccount>();

	public constructor(driftClient: DriftClient) {
		this.driftClient = driftClient;
	}

	public async add(
		marketIndex: number,
		phoenixMarketAddress: PublicKey
	): Promise<void> {
		const account = await this.driftClient.getPhoenixV1FulfillmentConfig(
			phoenixMarketAddress
		);
		this.map.set(marketIndex, account);
	}

	public get(marketIndex: number): PhoenixV1FulfillmentConfigAccount {
		return this.map.get(marketIndex);
	}
}
