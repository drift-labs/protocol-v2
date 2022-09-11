import { StateAccount } from '../types';

/**
 * Get the clearing house percent fee charged on notional of taking trades
 *
 * @param state
 * @returns Precision : basis points (bps)
 */
export function getExchangeFee(state: StateAccount): number {
	const exchangeFee =
		state.perpFeeStructure.feeNumerator.toNumber() /
		state.perpFeeStructure.feeDenominator.toNumber();
	return exchangeFee;
}
