import {
	Connection,
	Finality,
	PublicKey,
	TransactionSignature,
} from '@solana/web3.js';

type Log = { txSig: TransactionSignature; slot: number; logs: string[] };
type FetchLogsResponse = {
	earliestTx: string;
	mostRecentTx: string;
	transactionLogs: Log[];
};

export async function fetchLogs(
	connection: Connection,
	programId: PublicKey,
	finality: Finality,
	beforeTx?: TransactionSignature,
	untilTx?: TransactionSignature
): Promise<FetchLogsResponse | undefined> {
	const signatures = await connection.getSignaturesForAddress(
		programId,
		{
			before: beforeTx,
			until: untilTx,
		},
		finality
	);

	const sortedSignatures = signatures.sort((a, b) =>
		a.slot < b.slot ? -1 : 1
	);

	const filteredSignatures = sortedSignatures.filter(
		(signature) => !signature.err
	);

	if (filteredSignatures.length === 0) {
		return undefined;
	}

	const chunkedSignatures = chunk(filteredSignatures, 100);

	const transactionLogs = (
		await Promise.all(
			chunkedSignatures.map(async (chunk) => {
				const transactions = await connection.getTransactions(
					chunk.map((confirmedSignature) => confirmedSignature.signature),
					finality
				);

				return transactions.map((transaction) => {
					return {
						txSig: transaction.transaction.signatures[0],
						slot: transaction.slot,
						logs: transaction.meta.logMessages,
					};
				});
			})
		)
	).flat();

	const earliestTx = filteredSignatures[0].signature;
	const mostRecentTx =
		filteredSignatures[filteredSignatures.length - 1].signature;

	return {
		transactionLogs: transactionLogs,
		earliestTx: earliestTx,
		mostRecentTx: mostRecentTx,
	};
}

function chunk<T>(array: readonly T[], size: number): T[][] {
	return new Array(Math.ceil(array.length / size))
		.fill(null)
		.map((_, index) => index * size)
		.map((begin) => array.slice(begin, begin + size));
}
