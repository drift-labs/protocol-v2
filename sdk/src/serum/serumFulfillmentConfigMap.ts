import { PublicKey } from '@solana/web3.js';
import { SerumV3FulfillmentConfigAccount } from '../types';
import { IDriftClient } from '../driftClient/types';

export class SerumFulfillmentConfigMap {
	driftClient: IDriftClient;
	map = new Map<number, SerumV3FulfillmentConfigAccount>();

	public constructor(driftClient: IDriftClient) {
		this.driftClient = driftClient;
	}

	public async add(
		marketIndex: number,
		serumMarketAddress: PublicKey
	): Promise<void> {
		const account = await this.driftClient.getSerumV3FulfillmentConfig(
			serumMarketAddress
		);
		this.map.set(marketIndex, account);
	}

	public get(marketIndex: number): SerumV3FulfillmentConfigAccount {
		return this.map.get(marketIndex);
	}
}
