import { BN, BigNum } from '@velocity-exchange/sdk';

const DEFAULT_MODIFIED_DIETZ_RESULT = {
	apy: 0,
	returns: 0,
};

/**
 * https://en.wikipedia.org/wiki/Modified_Dietz_method
 * @param currentVaultEquityBaseValue
 * @param vaultDeposits
 * @returns weighted APY and cumulative returns calculated using the Modified Dietz method
 */
export const calcModifiedDietz = (
	currentVaultEquityBaseValue: BigNum,
	precisionExp: BN,
	vaultDeposits: {
		ts: string;
		marketIndex: number;
		amount: string;
		direction: 'deposit' | 'withdraw';
	}[],
	startingMarketValue = 0
): { apy: number; returns: number } => {
	if (vaultDeposits.length === 0) {
		return DEFAULT_MODIFIED_DIETZ_RESULT;
	}

	const endingMarkeValue = currentVaultEquityBaseValue.toNum();
	const firstDepositTs = parseInt(vaultDeposits[vaultDeposits.length - 1].ts);
	const lastDepositTs = parseInt(vaultDeposits[0].ts);
	const nowTs = Date.now() / 1000;
	if (nowTs < firstDepositTs) {
		console.error('nowTs < firstDepositTs');
		return DEFAULT_MODIFIED_DIETZ_RESULT;
	}
	if (lastDepositTs < firstDepositTs) {
		console.error('lastDepositTs < firstDepositTs');
		return DEFAULT_MODIFIED_DIETZ_RESULT;
	}
	const totalDuration = nowTs - firstDepositTs;

	let totalNetFlow = 0;
	let weightedNetFlow = 0;
	vaultDeposits.forEach((deposit) => {
		let depositAmount = BigNum.from(deposit.amount, precisionExp).toNum();
		if (deposit.direction === 'withdraw') {
			depositAmount *= -1;
		}
		totalNetFlow += depositAmount;
		const depositAge = parseInt(deposit.ts) - firstDepositTs;
		const depositWeight = (totalDuration - depositAge) / totalDuration;
		if (depositWeight < 0) {
			console.error('depositWeight < 0');
			return -1;
		}
		weightedNetFlow += depositWeight * depositAmount;
	}, 0);

	const modifiedDietzReturns =
		(endingMarkeValue - startingMarketValue - totalNetFlow) /
		(startingMarketValue + weightedNetFlow);

	if (modifiedDietzReturns < 0) return DEFAULT_MODIFIED_DIETZ_RESULT;

	const annualized =
		Math.pow(1 + modifiedDietzReturns, (86400 * 365) / totalDuration) - 1;

	const positiveApy = Math.max(annualized, 0);
	return { apy: positiveApy, returns: modifiedDietzReturns };
};
