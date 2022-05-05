import { StateAccount } from '../types';

/**
 * Get the clearing house percent fee charged on notional of taking trades
 *
 * @param state
 * @returns Precision : basis points (bps)
 */
export function getExchangeFee(state: StateAccount): number {
	const exchangeFee =
		state.feeStructure.feeNumerator.toNumber() /
		state.feeStructure.feeDenominator.toNumber();
	return exchangeFee;
}
