import { PublicKey } from '@solana/web3.js';
import { PhoenixV1FulfillmentConfigAccount } from '../types';
import { IDriftClient } from '../driftClient/types';

export class PhoenixFulfillmentConfigMap {
	driftClient: IDriftClient;
	map = new Map<number, PhoenixV1FulfillmentConfigAccount>();

	public constructor(driftClient: IDriftClient) {
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
