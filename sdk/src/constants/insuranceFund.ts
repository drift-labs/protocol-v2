import { PERCENTAGE_PRECISION } from './numericConstants';

// follows program constant MAX_APR_PER_REVENUE_SETTLE_TO_INSURANCE_FUND_VAULT_GOV in math/constants.rs
/**
 * Max APR for DRIFT IF vault.
 */
export const MAX_APR_PER_REVENUE_SETTLE_TO_INSURANCE_FUND_VAULT_GOV =
	PERCENTAGE_PRECISION.divn(22);
