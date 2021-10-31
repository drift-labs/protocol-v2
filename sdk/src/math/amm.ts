import { BN } from '@project-serum/anchor';
import { AMM_MANTISSA, PEG_SCALAR } from '../clearingHouse';
import { ZERO } from '../constants/numericConstants';
import { PositionDirection } from '../types';
import { assert } from '../assert/assert';

export function calculateCurvePriceWithMantissa(
	baseAssetAmount: BN,
	quoteAssetAmount: BN,
	peg: BN
): BN {
	if (baseAssetAmount.abs().lte(ZERO)) {
		return new BN(0);
	}

	return quoteAssetAmount
		.mul(AMM_MANTISSA)
		.mul(peg)
		.div(PEG_SCALAR)
		.div(baseAssetAmount);
}

export function findSwapOutput(
	inputAssetAmount: BN,
	outputAssetAmount: BN,
	direction: PositionDirection,
	inputAmount: BN,
	inputAsset: string,
	invariant: BN,
	pegMultiplier: BN
): [BN, BN] {
	assert(inputAmount.gte(ZERO)); // must be abs term
	// constant product

	if (inputAsset == 'quote') {
		inputAmount = inputAmount.mul(AMM_MANTISSA).div(pegMultiplier);
	}

	let newInputAssetAmount;

	if (
		(direction == PositionDirection.LONG && inputAsset == 'base') ||
		(direction == PositionDirection.SHORT && inputAsset == 'quote')
	) {
		newInputAssetAmount = inputAssetAmount.sub(inputAmount);
	} else {
		newInputAssetAmount = inputAssetAmount.add(inputAmount);
	}
	const newOutputAssetAmount = invariant.div(newInputAssetAmount);

	return [newInputAssetAmount, newOutputAssetAmount];
}
