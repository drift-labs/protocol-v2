import { BN } from '@coral-xyz/anchor';
import {
	LAMPORTS_PRECISION,
	PERCENTAGE_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { FeatureBitFlags, StateAccount } from '../types';

export function calculateInitUserFee(stateAccount: StateAccount): BN {
	const maxInitFee = new BN(stateAccount.maxInitializeUserFee)
		.mul(LAMPORTS_PRECISION)
		.divn(100);
	const targetUtilization = PERCENTAGE_PRECISION.muln(8).divn(10);

	const accountSpaceUtilization = stateAccount.numberOfSubAccounts
		.addn(1)
		.mul(PERCENTAGE_PRECISION)
		.div(getMaxNumberOfSubAccounts(stateAccount));

	if (accountSpaceUtilization.gt(targetUtilization)) {
		return maxInitFee
			.mul(accountSpaceUtilization.sub(targetUtilization))
			.div(PERCENTAGE_PRECISION.sub(targetUtilization));
	} else {
		return ZERO;
	}
}

export function getMaxNumberOfSubAccounts(stateAccount: StateAccount): BN {
	if (stateAccount.maxNumberOfSubAccounts <= 5) {
		return new BN(stateAccount.maxNumberOfSubAccounts);
	}
	return new BN(stateAccount.maxNumberOfSubAccounts).muln(100);
}

export function useMedianTriggerPrice(stateAccount: StateAccount): boolean {
	return (
		(stateAccount.featureBitFlags & FeatureBitFlags.MEDIAN_TRIGGER_PRICE) > 0
	);
}

export function builderCodesEnabled(stateAccount: StateAccount): boolean {
	return (stateAccount.featureBitFlags & FeatureBitFlags.BUILDER_CODES) > 0;
}

export function builderReferralEnabled(stateAccount: StateAccount): boolean {
	return (stateAccount.featureBitFlags & FeatureBitFlags.BUILDER_REFERRAL) > 0;
}
