import { ClearingHouse } from './clearingHouse';
import BN from 'bn.js';
import { ZERO } from './constants/numericConstants';
import { UserAccount } from './userAccount';

export class Funder {
	clearingHouse: ClearingHouse;

	public constructor(clearingHouse: ClearingHouse) {
		if (!clearingHouse.isSubscribed) {
			throw new Error(
				'ClearingHouse must be subscribed before creating Funder'
			);
		}
		this.clearingHouse = clearingHouse;
	}

	public async updateMarketFundingRates() {
		const marketsAccount: any = await this.clearingHouse.getMarketsAccount();
		for (const marketIndex in marketsAccount.markets) {
			const market = marketsAccount.markets[marketIndex];
			if (!market.initialized) {
				continue;
			}

			console.log(
				`Market ${marketIndex} last update: ${market.amm.fundingRateTs.toString()}`
			);
			const currentTimestamp = new BN(Date.now() / 1000);
			if (
				currentTimestamp
					.sub(market.amm.fundingRateTs)
					.add(market.amm.periodicity)
					.gt(ZERO)
			) {
				console.log(
					`Updated funding rate for market: ${marketIndex}. Time: ${currentTimestamp.toString()}`
				);
				await this.clearingHouse.updateFundingRate(
					market.amm.oracle,
					new BN(marketIndex)
				);
			}
		}
	}

	public async settleUsersFundingPayments(userAccounts: UserAccount[]) {
		const usersNeedSettling = userAccounts.filter((userAccount) =>
			userAccount.needsToSettleFundingPayment()
		);
		await Promise.all(
			usersNeedSettling.map((userAccount) => {
				return (async () => {
					const userAccountPublicKey = await userAccount.getPublicKey();
					console.log(
						`Settling the funding rate for user ${userAccountPublicKey.toString()}`
					);
					await this.clearingHouse.settleFundingPayment(
						userAccountPublicKey,
						userAccount.userAccountData?.positions
					);
				})();
			})
		);
	}
}
