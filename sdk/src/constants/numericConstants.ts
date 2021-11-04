import BN from 'bn.js';

export const ZERO = new BN(0);
export const ONE = new BN(1);
export const TEN_THOUSAND = new BN(10000);
export const BN_MAX = new BN(Number.MAX_SAFE_INTEGER);

export const MAX_LEVERAGE = new BN(5);
export const FULL_LIQUIDATION_RATIO = new BN(500);
export const PARTIAL_LIQUIDATION_RATIO = new BN(625);

export const QUOTE_PRECISION = new BN(10 ** 6);
export const MARK_PRICE_PRECISION = new BN(10 ** 10);
export const FUNDING_MANTISSA = new BN(10000);
export const PEG_SCALAR = new BN(1000);

export const BASE_ASSET_PRECISION = new BN(10 ** 13);
export const QUOTE_BASE_PRECISION_DIFF =
	BASE_ASSET_PRECISION.div(QUOTE_PRECISION); // 10^7
export const PRICE_TO_QUOTE_PRECISION =
	MARK_PRICE_PRECISION.div(QUOTE_PRECISION);
