import { ClearingHouse } from './clearingHouse';
import BN from 'bn.js';
import { ZERO } from './constants/numericConstants';
import { ClearingHouseUser } from './clearingHouseUser';

export class Funder {
	clearingHouse: ClearingHouse;

	public constructor(clearingHouse: ClearingHouse) {
		this.clearingHouse = clearingHouse;
	}

	public async updateMarketFundingRates() {
		const marketsAccount: any = await this.clearingHouse.getMarketsAccount();
		for (const marketIndex in marketsAccount.markets) {
			const market = marketsAccount.markets[marketIndex];
			if (!market.initialized) {
				continue;
			}

			const currentTimestamp = new BN(Date.now() / 1000);
			if (
				currentTimestamp
					.sub(market.amm.lastFundingRateTs)
					.add(market.amm.fundingPeriod)
					.gt(ZERO)
			) {
				await this.clearingHouse.updateFundingRate(
					market.amm.oracle,
					new BN(marketIndex)
				);
			}
		}
	}

	public async settleUsersFundingPayments(userAccounts: ClearingHouseUser[]) {
		const usersNeedSettling = userAccounts.filter((userAccount) =>
			userAccount.needsToSettleFundingPayment()
		);
		await Promise.all(
			usersNeedSettling.map((userAccount) => {
				return (async () => {
					const userAccountPublicKey =
						await userAccount.getUserAccountPublicKey();
					await this.clearingHouse.settleFundingPayment(
						userAccountPublicKey,
						userAccount.getUserAccount().positions
					);
				})();
			})
		);
	}
}
