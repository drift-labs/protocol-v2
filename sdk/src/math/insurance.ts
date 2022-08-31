import { ONE, ZERO } from '../constants/numericConstants';
import { BN } from '../index';

export function stakeAmountToShares(
	amount: BN,
	totalIfShares: BN,
	insuranceFundVaultBalance: BN
): BN {
	let nShares: BN;
	if (insuranceFundVaultBalance.gt(ZERO)) {
		nShares = amount.mul(totalIfShares).div(insuranceFundVaultBalance);
	} else {
		nShares = amount;
	}

	return nShares;
}

export function unstakeSharesToAmount(
	nShares: BN,
	totalIfShares: BN,
	insuranceFundVaultBalance: BN
): BN {
	let amount: BN;
	if (totalIfShares.gt(ZERO)) {
		amount = BN.max(
			ZERO,
			nShares.mul(insuranceFundVaultBalance).div(totalIfShares).sub(ONE)
		);
	} else {
		amount = ZERO;
	}

	return amount;
}
