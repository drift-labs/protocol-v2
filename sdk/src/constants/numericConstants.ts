import BN from 'bn.js';

export const ZERO = new BN(0);
export const TEN_THOUSAND = new BN(10000);
export const BN_MAX = new BN(Number.MAX_SAFE_INTEGER);

export const MAX_LEVERAGE = new BN(5);
export const FULL_LIQUIDATION_RATIO = new BN(500);
export const PARTIAL_LIQUIDATION_RATIO = new BN(625);