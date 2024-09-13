import { PERCENTAGE_PRECISION, ZERO } from '../constants/numericConstants';
import { BN, SpotMarketAccount, SpotBalanceType } from '../index';
import { getTokenAmount } from '../math/spotBalance';

export function nextRevenuePoolSettleApr(
	spotMarket: SpotMarketAccount,
	vaultBalance: BN, // vault token amount
	amount?: BN // delta token amount
): number {
	const MAX_APR = new BN(10).mul(PERCENTAGE_PRECISION); // 1000% APR

	// Conmputing the APR:
	const revenuePoolBN = getTokenAmount(
		spotMarket.revenuePool.scaledBalance,
		spotMarket,
		SpotBalanceType.DEPOSIT
	);

	const payoutRatio = 0.1;
	const ratioForStakers =
		spotMarket.insuranceFund.totalFactor > 0 &&
		spotMarket.insuranceFund.userFactor > 0 &&
		spotMarket.insuranceFund.revenueSettlePeriod.gt(ZERO)
			? spotMarket.insuranceFund.userFactor /
			  spotMarket.insuranceFund.totalFactor
			: 0;

	// Settle periods from on-chain data:
	const revSettlePeriod =
		spotMarket.insuranceFund.revenueSettlePeriod.toNumber() * 1000;

	const settlesPerYear = 31536000000 / revSettlePeriod;

	const projectedAnnualRev = revenuePoolBN
		.muln(settlesPerYear)
		.muln(payoutRatio);

	const uncappedApr = vaultBalance.add(amount).eq(ZERO)
		? 0
		: projectedAnnualRev.muln(1000).div(vaultBalance.add(amount)).toNumber() *
		  100 *
		  1000;
	const cappedApr = Math.min(uncappedApr, MAX_APR.toNumber());

	const nextApr = cappedApr * ratioForStakers;

	return nextApr;
}

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
