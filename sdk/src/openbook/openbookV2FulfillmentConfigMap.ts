import { PublicKey } from '@solana/web3.js';
import { OpenbookV2FulfillmentConfigAccount } from '../types';
import { IDriftClient } from '../driftClient/types';

export class OpenbookV2FulfillmentConfigMap {
	driftClient: IDriftClient;
	map = new Map<number, OpenbookV2FulfillmentConfigAccount>();

	public constructor(driftClient: IDriftClient) {
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
