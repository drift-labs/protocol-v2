import { Connection, PublicKey } from '@solana/web3.js';

export async function estimateTps(
	programId: PublicKey,
	connection: Connection,
	failed: boolean
): Promise<number> {
	let signatures = await connection.getSignaturesForAddress(
		programId,
		undefined,
		'finalized'
	);
	if (failed) {
		signatures = signatures.filter((signature) => signature.err);
	}

	const numberOfSignatures = signatures.length;

	if (numberOfSignatures === 0) {
		return 0;
	}

	return (
		numberOfSignatures /
		(signatures[0].blockTime - signatures[numberOfSignatures - 1].blockTime)
	);
}
