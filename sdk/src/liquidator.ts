import { ClearingHouse } from './clearingHouse';
import { PublicKey } from '@solana/web3.js';
import { UserAccount } from './userAccount';
import { Wallet } from '@project-serum/anchor';

export class Liquidator {
	clearingHouse: ClearingHouse;
	liquidatorUserAccount: UserAccount;
	liquidatorUSDCTokenPublicKey: PublicKey;

	public constructor(
		clearingHouse: ClearingHouse,
		liquidatorUSDCTokenPublicKey: PublicKey
	) {
		this.clearingHouse = clearingHouse;
		this.liquidatorUserAccount = new UserAccount(
			clearingHouse,
			clearingHouse.wallet.publicKey
		);
		this.liquidatorUSDCTokenPublicKey = liquidatorUSDCTokenPublicKey;
	}

	public async liquidate(userAccounts: UserAccount[], blacklistWallets: Wallet[]): Promise<UserAccount[]> {
		const accountsToLiquidate: UserAccount[] = [];

		const blackListSet = new Set();
		for (const blacklistWallet of blacklistWallets) {
			blackListSet.add(blacklistWallet.publicKey.toString());
		}

		for (const userAccount of userAccounts) {
			const [canLiquidate] = userAccount.canBeLiquidated();

			
			if (canLiquidate) {
				accountsToLiquidate.push(userAccount);
				const liquidateeUserAccountPublicKey = await userAccount.getPublicKey();

				if (blackListSet.has(liquidateeUserAccountPublicKey.toString())) {
					continue;
				}

				try {
					this.clearingHouse
						.liquidate(
							liquidateeUserAccountPublicKey
						)
						.then((tx) => {
							console.log(
								`Liquidated user: ${userAccount.userPublicKey} Tx: ${tx}`
							);
						});
				} catch (e) {
					console.log(e);
				}
			}
		}
		return accountsToLiquidate;
	}
}
