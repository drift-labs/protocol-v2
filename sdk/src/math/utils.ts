import { BN } from '../';

export const squareRootBN = (n, closeness = new BN(1)) => {
	// Assuming the sqrt of n as n only
	let x = n;

	// The closed guess will be stored in the root
	let root;

	// To count the number of iterations
	let count = 0;
	const TWO = new BN(2);

	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	while (count < Number.MAX_SAFE_INTEGER) {
		count++;

		// Calculate more closed x
		root = x.add(n.div(x)).div(TWO);

		// Check for closeness
		if (x.sub(root).abs().lte(closeness)) break;

		// Update root
		x = root;
	}

	return root;
};
