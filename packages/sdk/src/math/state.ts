import { BN } from '../isomorphic/anchor';
import {
	LAMPORTS_PRECISION,
	PERCENTAGE_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { FeatureBitFlags, StateAccount } from '../types';

/**
 * Calculates the SOL fee that will be charged to initialize a new sub-account, mirroring
 * `State::get_init_user_fee`'s account-space-utilization scaling: once sub-account utilization
 * passes 80% of the max allowed, the fee ramps linearly from 0 up to `maxInitializeUserFee` at
 * 100% utilization; below 80% it's free. `numberOfSubAccounts` is incremented by 1 before this
 * ratio is computed because the on-chain handler bumps `state.numberOfSubAccounts` *before*
 * calling `get_init_user_fee` — so a client reading pre-transaction state must simulate that
 * increment itself to predict the fee the transaction will actually charge.
 *
 * @param {StateAccount} stateAccount - The global state account, read before submitting the
 *   `initializeUser` transaction
 * @return {BN} The init fee in lamports, `LAMPORTS_PRECISION` (1e9)
 */
export function calculateInitUserFee(stateAccount: StateAccount): BN {
	const maxInitFee = new BN(stateAccount.maxInitializeUserFee)
		.mul(LAMPORTS_PRECISION)
		.divn(100);
	const targetUtilization = PERCENTAGE_PRECISION.muln(8).divn(10);

	const accountSpaceUtilization = stateAccount.numberOfSubAccounts
		.addn(1)
		.mul(PERCENTAGE_PRECISION)
		.div(BN.max(getMaxNumberOfSubAccounts(stateAccount), new BN(1)));

	if (accountSpaceUtilization.gt(targetUtilization)) {
		return maxInitFee
			.mul(accountSpaceUtilization.sub(targetUtilization))
			.div(PERCENTAGE_PRECISION.sub(targetUtilization));
	} else {
		return ZERO;
	}
}

/**
 * Calculates the effective max number of sub-accounts allowed per authority, mirroring
 * `State::max_number_of_sub_accounts`. Values of 5 or below are used as-is (an explicit small
 * cap); values above 5 are multiplied by 100, letting the admin store a compact "hundreds" unit
 * for large caps.
 *
 * @param {StateAccount} stateAccount - The global state account
 * @return {BN} The effective max sub-account count (unitless count, not a token amount)
 */
export function getMaxNumberOfSubAccounts(stateAccount: StateAccount): BN {
	if (stateAccount.maxNumberOfSubAccounts <= 5) {
		return new BN(stateAccount.maxNumberOfSubAccounts);
	}
	return new BN(stateAccount.maxNumberOfSubAccounts).muln(100);
}

/**
 * True if the protocol-wide feature flag for median-based trigger prices is enabled, mirroring
 * `State::use_median_trigger_price`. When enabled, `getTriggerPrice` (in `market.ts`) uses the
 * median of last-fill, funding-basis, and 5min-basis prices instead of the raw oracle price for
 * trigger order evaluation.
 *
 * @param {StateAccount} stateAccount - The global state account
 * @return {boolean} Whether `FeatureBitFlags.MEDIAN_TRIGGER_PRICE` is set
 */
export function useMedianTriggerPrice(stateAccount: StateAccount): boolean {
	return (
		(stateAccount.featureBitFlags & FeatureBitFlags.MEDIAN_TRIGGER_PRICE) > 0
	);
}
