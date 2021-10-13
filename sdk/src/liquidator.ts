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

	public async liquidate(userAccounts: UserAccount[], blacklist: Wallet[]): Promise<UserAccount[]> {
		const accountsToLiquidate: UserAccount[] = [];
		for (const userAccount of userAccounts) {
			const [canLiquidate] = userAccount.canBeLiquidated();

			
			if (canLiquidate) {
				accountsToLiquidate.push(userAccount);
				const liquidateeUserAccountPublicKey = await userAccount.getPublicKey();

				if(liquidateeUserAccountPublicKey.toString() == blacklist[0].publicKey.toString()){
					continue;
				}

				try {
					this.clearingHouse
						.liquidate(
							this.liquidatorUSDCTokenPublicKey,
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
