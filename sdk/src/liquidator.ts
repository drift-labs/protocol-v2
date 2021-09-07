import { ClearingHouse } from './clearingHouse';
import { PublicKey } from '@solana/web3.js';
import { UserAccount } from './userAccount';

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

	public async liquidate(userAccounts: UserAccount[]) {
		for (const userAccount of userAccounts) {
			const [canLiquidate, marginRatio] = userAccount.canBeLiquidated();
			if (canLiquidate) {
				const liquidateeUserAccountPublicKey = await userAccount.getPublicKey();
				const tx = await this.clearingHouse.liquidate(
					this.liquidatorUSDCTokenPublicKey,
					liquidateeUserAccountPublicKey
				);
				const formattedMarginRatio = (marginRatio.toNumber() / 1000).toFixed(3);
				console.log(
					`Liquidated user ${liquidateeUserAccountPublicKey.toString()}. Margin Ratio: ${formattedMarginRatio}`
				);
				console.log(`Liquidation Tx ${tx}`);
			}
		}
	}
}
