import { ClearingHouse } from './clearingHouse';
import { PublicKey } from '@solana/web3.js';
import { ClearingHouseUser } from './clearingHouseUser';
import { Wallet } from '@project-serum/anchor';

export class Liquidator {
	clearingHouse: ClearingHouse;
	liquidatorUserAccount: ClearingHouseUser;
	liquidatorUSDCTokenPublicKey: PublicKey;

	public constructor(
		clearingHouse: ClearingHouse,
		liquidatorUSDCTokenPublicKey: PublicKey
	) {
		this.clearingHouse = clearingHouse;
		this.liquidatorUserAccount = ClearingHouseUser.from(
			clearingHouse,
			clearingHouse.wallet.publicKey
		);
		this.liquidatorUSDCTokenPublicKey = liquidatorUSDCTokenPublicKey;
	}

	public async liquidate(
		users: ClearingHouseUser[],
		blacklistWallets: Wallet[]
	): Promise<ClearingHouseUser[]> {
		const usersToLiquidate: ClearingHouseUser[] = [];

		const blackListSet = new Set();
		for (const blacklistWallet of blacklistWallets) {
			blackListSet.add(blacklistWallet.publicKey.toString());
		}

		for (const user of users) {
			const [canLiquidate] = user.canBeLiquidated();

			if (canLiquidate) {
				usersToLiquidate.push(user);
				const liquidateeUserAccountPublicKey =
					await user.getUserAccountPublicKey();

				if (blackListSet.has(liquidateeUserAccountPublicKey.toString())) {
					continue;
				}

				try {
					this.clearingHouse
						.liquidate(liquidateeUserAccountPublicKey)
						.then((tx) => {
							console.log(`Liquidated user: ${user.authority} Tx: ${tx}`);
						});
				} catch (e) {
					console.log(e);
				}
			}
		}
		return usersToLiquidate;
	}
}
