import { PublicKey } from '@solana/web3.js';
import { SerumV3FulfillmentConfigAccount } from '../types';
import { ClearingHouse } from '../clearingHouse';

export class SerumFulfillmentConfigMap {
	clearingHouse: ClearingHouse;
	map = new Map<number, SerumV3FulfillmentConfigAccount>();

	public constructor(clearingHouse: ClearingHouse) {
		this.clearingHouse = clearingHouse;
	}

	public async add(
		marketIndex: number,
		serumMarketAddress: PublicKey
	): Promise<void> {
		const account = await this.clearingHouse.getSerumV3FulfillmentConfig(
			serumMarketAddress
		);
		this.map.set(marketIndex, account);
	}

	public get(marketIndex: number): SerumV3FulfillmentConfigAccount {
		return this.map.get(marketIndex);
	}
}
