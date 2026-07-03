import { PERCENTAGE_PRECISION, ZERO } from '../constants/numericConstants';
import { getTokenAmount } from '../math/spotBalance';
import { BN } from '../isomorphic/anchor';
import { SpotBalanceType, SpotMarketAccount } from '../types';

/**
 * Estimates the annualized yield (APR) insurance fund stakers would earn if the market's revenue
 * pool were settled into the insurance fund vault right now, projected forward assuming the same
 * revenue pool size settles at the market's configured `revenueSettlePeriod` cadence for a year.
 * The insurance fund is entirely staker-owned (no protocol split): all settled revenue accrues to
 * stakers via share-price appreciation. Only 10% of the projected annual revenue (`payoutRatio`)
 * is assumed to actually reach the vault as yield; the result is capped at 1000% APR.
 *
 * @param {SpotMarketAccount} spotMarket - The spot market account (its `revenuePool` and
 *   `insuranceFund.revenueSettlePeriod` drive the projection)
 * @param {BN} vaultBalance - Current insurance fund vault token amount, market's token decimals
 * @param {BN} amount - Hypothetical additional deposit/withdrawal token amount to apply to the
 *   vault balance before computing the ratio (positive = deposit, negative = withdrawal),
 *   market's token decimals
 * @return {number} Estimated APR as a plain JS percentage number (e.g. `12.5` = 12.5% APR), or
 *   `0` if `revenueSettlePeriod` is unset or `vaultBalance + amount` is zero. This is a display
 *   estimate, not a program mirror — it also inherits a small numerical imprecision from scaling
 *   a `BN` by the fractional `payoutRatio` (0.1) via `BN.muln`, which multiplies fractionally
 *   per-limb rather than performing exact fixed-point math.
 */
export function nextRevenuePoolSettleApr(
	spotMarket: SpotMarketAccount,
	vaultBalance: BN, // vault token amount
	amount: BN // delta token amount
): number {
	const MAX_APR = new BN(10).mul(PERCENTAGE_PRECISION); // 1000% APR

	// Conmputing the APR:
	const revenuePoolBN = getTokenAmount(
		spotMarket.revenuePool.scaledBalance,
		spotMarket,
		SpotBalanceType.DEPOSIT
	);

	const payoutRatio = 0.1;
	// the insurance fund is 100% staker-owned: every settled token accrues to
	// stakers as share-price appreciation (no protocol split)
	const ratioForStakers = spotMarket.insuranceFund.revenueSettlePeriod.gt(ZERO)
		? 1
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

/**
 * Calculates how many insurance fund shares a deposit of `amount` would mint, mirroring
 * `vault_amount_to_if_shares`. Shares are minted proportionally to the deposit's fraction of the
 * vault (`amount * totalIfShares / insuranceFundVaultBalance`, floored); if the vault is
 * currently empty, 1 share is minted per token (bootstrapping the share price at 1:1).
 *
 * @param {BN} amount - Token amount being staked, market's token decimals
 * @param {BN} totalIfShares - Current total insurance fund shares outstanding
 * @param {BN} insuranceFundVaultBalance - Current insurance fund vault token amount, market's token decimals
 * @return {BN} Shares minted
 */
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

/**
 * Calculates the token amount `nShares` of the insurance fund are currently worth, mirroring
 * `if_shares_to_vault_amount` (floored). Returns zero (rather than dividing by zero) if there are
 * no shares outstanding.
 *
 * @param {BN} nShares - Number of insurance fund shares
 * @param {BN} totalIfShares - Current total insurance fund shares outstanding
 * @param {BN} insuranceFundVaultBalance - Current insurance fund vault token amount, market's token decimals
 * @return {BN} Token value of `nShares`, market's token decimals; floored at zero
 */
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

/**
 * Calculates a staker's total current value — their remaining staked shares plus any pending
 * withdrawal request — accounting for the fact that a pending request's payout is locked in at
 * the vault-value snapshot taken when the request was made (`InsuranceFundStake.lastWithdrawRequestValue`),
 * not the vault's current value. This is what a user can expect to see if they cancel/complete a
 * pending unstake request without further vault movement.
 *
 * @param {BN} nShares - The staker's total shares (`InsuranceFundStake.ifShares`), including any
 *   shares already earmarked by a pending withdrawal request
 * @param {BN} withdrawRequestShares - Shares locked by a pending withdrawal request
 *   (`InsuranceFundStake.lastWithdrawRequestShares`), 0 if none is pending
 * @param {BN} withdrawRequestAmount - The token amount locked in at request time
 *   (`InsuranceFundStake.lastWithdrawRequestValue`), market's token decimals
 * @param {BN} totalIfShares - Current total insurance fund shares outstanding
 * @param {BN} insuranceFundVaultBalance - Current insurance fund vault token amount, market's token decimals
 * @return {BN} `stakedAmount + withdrawAmount`: the current value of `nShares - withdrawRequestShares`
 *   (floored at zero) at today's vault price, plus `min(withdrawRequestAmount, withdrawRequestShares'
 *   value at today's vault price)` — the pending withdrawal is whichever is lower of its
 *   locked-in amount and its current value, so vault depreciation since the request reduces the
 *   payout but vault appreciation does not increase it
 */
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
