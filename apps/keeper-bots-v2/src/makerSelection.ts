import { BN, convertToNumber, divCeil, DLOBNode, ZERO } from '@drift-labs/sdk';
import { MakerNodeMap, MAX_MAKERS_PER_FILL } from './bots/filler';

const PROBABILITY_PRECISION = new BN(1000);

export function selectMakers(makerNodeMap: MakerNodeMap): MakerNodeMap {
	const selectedMakers: MakerNodeMap = new Map();

	while (selectedMakers.size < MAX_MAKERS_PER_FILL && makerNodeMap.size > 0) {
		const maker = selectMaker(makerNodeMap);
		if (maker === undefined) {
			break;
		}
		const makerNodes = makerNodeMap.get(maker)!;
		selectedMakers.set(maker, makerNodes);
		makerNodeMap.delete(maker);
	}

	return selectedMakers;
}

function selectMaker(makerNodeMap: MakerNodeMap): string | undefined {
	if (makerNodeMap.size === 0) {
		return undefined;
	}

	let totalLiquidity = ZERO;
	for (const [_, dlobNodes] of makerNodeMap) {
		totalLiquidity = totalLiquidity.add(getMakerLiquidity(dlobNodes));
	}

	const probabilities = [];
	for (const [_, dlobNodes] of makerNodeMap) {
		probabilities.push(getProbability(dlobNodes, totalLiquidity));
	}

	let makerIndex = 0;
	const random = Math.random();
	let sum = 0;
	for (let i = 0; i < probabilities.length; i++) {
		sum += probabilities[i];
		if (random < sum) {
			makerIndex = i;
			break;
		}
	}

	return Array.from(makerNodeMap.keys())[makerIndex];
}

function getProbability(dlobNodes: DLOBNode[], totalLiquidity: BN): number {
	const makerLiquidity = getMakerLiquidity(dlobNodes);
	return convertToNumber(
		divCeil(makerLiquidity.mul(PROBABILITY_PRECISION), totalLiquidity),
		PROBABILITY_PRECISION
	);
}

function getMakerLiquidity(dlobNodes: DLOBNode[]): BN {
	return dlobNodes.reduce(
		(acc, dlobNode) =>
			acc.add(
				dlobNode.order!.baseAssetAmount.sub(
					dlobNode.order!.baseAssetAmountFilled
				)
			),
		ZERO
	);
}
