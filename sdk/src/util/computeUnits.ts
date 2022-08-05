import { Connection, Finality, PublicKey } from '@solana/web3.js';

export async function findComputeUnitConsumption(
	programId: PublicKey,
	connection: Connection,
	txSignature: string,
	commitment: Finality = 'confirmed'
): Promise<number[]> {
	const tx = await connection.getTransaction(txSignature, { commitment });
	const computeUnits = [];
	const regex = new RegExp(
		`Program ${programId.toString()} consumed ([0-9]{0,6}) of ([0-9]{0,7}) compute units`
	);
	tx.meta.logMessages.forEach((logMessage) => {
		const match = logMessage.match(regex);
		if (match && match[1]) {
			computeUnits.push(match[1]);
		}
	});
	return computeUnits;
}
