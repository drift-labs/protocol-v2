import { ClearingHouse, AMM_MANTISSA } from './clearingHouse';
import { PythClient } from './pythClient';
import BN from 'bn.js';
import { ZERO } from './constants/numericConstants';

export class Arbitrager {
	private clearingHouse: ClearingHouse;
	private pythClient: PythClient;

	public constructor(clearingHouse: ClearingHouse) {
		if (!clearingHouse.isSubscribed) {
			throw Error('clearingHouse must be subscribed to create arbitrager');
		}
		this.clearingHouse = clearingHouse;
		this.pythClient = new PythClient(this.clearingHouse.connection);
	}

	public async arbitrage() {
		const marketsAccount: any = await this.clearingHouse.getMarketsAccount();
		for (const marketIndex in marketsAccount.markets) {
			const market = marketsAccount.markets[marketIndex];
			if (!market.initialized) {
				continue;
			}
			const marketIndexBN = new BN(marketIndex);

			console.log(`Trying to arbitrage market: ${marketIndex}`);

			const oraclePriceData = await this.pythClient.getPriceData(
				market.amm.oracle
			);
			const oraclePriceWithMantissa = new BN(
				oraclePriceData.price * AMM_MANTISSA.toNumber()
			);

			console.log(`Oracle price: ${oraclePriceData.price}`);
			console.log(
				`Mark price: ${this.clearingHouse.calculateBaseAssetPriceAsNumber(
					marketIndexBN
				)}`
			);

			const [direction, amount] = this.clearingHouse.calculateTargetPriceTrade(
				marketIndexBN,
				oraclePriceWithMantissa,
				new BN(500) //50% (given partial fills)
			);

			if (amount.eq(ZERO)) {
				return;
			}

			await this.clearingHouse.openPosition(
				(
					await this.clearingHouse.getUserAccountPublicKey()
				)[0],
				direction,
				amount,
				marketIndexBN,
				oraclePriceWithMantissa
			);
		}
	}
}
