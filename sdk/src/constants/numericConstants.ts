import { BN } from '../';

export const ZERO = new BN(0);
export const ONE = new BN(1);
export const TWO = new BN(2);
export const TEN = new BN(10);
export const TEN_THOUSAND = new BN(10000);
export const BN_MAX = new BN(Number.MAX_SAFE_INTEGER);

export const MAX_LEVERAGE = new BN(5);

export const QUOTE_PRECISION = new BN(10 ** 6);
export const MARK_PRICE_PRECISION = new BN(10 ** 10);
export const FUNDING_PAYMENT_PRECISION = new BN(10000);
export const PEG_PRECISION = new BN(1000);

export const AMM_RESERVE_PRECISION = new BN(10 ** 13);
export const BASE_PRECISION = AMM_RESERVE_PRECISION;
export const AMM_TO_QUOTE_PRECISION_RATIO =
	AMM_RESERVE_PRECISION.div(QUOTE_PRECISION); // 10^7
export const PRICE_TO_QUOTE_PRECISION =
	MARK_PRICE_PRECISION.div(QUOTE_PRECISION);
export const AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO =
	AMM_RESERVE_PRECISION.mul(PEG_PRECISION).div(QUOTE_PRECISION); // 10^10
export const MARGIN_PRECISION = TEN_THOUSAND;
