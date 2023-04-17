import { ZERO } from '../constants/numericConstants';
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
			nShares.mul(insuranceFundVaultBalance).div(totalIfShares)
		);
	} else {
		amount = ZERO;
	}

	return amount;
}

export function unstakeSharesToAmountWithOpenRequest(
	nShares: BN,
	withdrawRequestShares: BN,
	withdrawRequestAmount: BN,
	totalIfShares: BN,
	insuranceFundVaultBalance: BN
): BN {
	let stakedAmount: BN;
	if (totalIfShares.gt(ZERO)) {
		stakedAmount = BN.max(
			ZERO,
			nShares
				.sub(withdrawRequestShares)
				.mul(insuranceFundVaultBalance)
				.div(totalIfShares)
		);
	} else {
		stakedAmount = ZERO;
	}

	const withdrawAmount = BN.min(
		withdrawRequestAmount,
		withdrawRequestShares.mul(insuranceFundVaultBalance).div(totalIfShares)
	);
	const amount = withdrawAmount.add(stakedAmount);

	return amount;
}
