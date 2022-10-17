import { Program } from '@project-serum/anchor';
import {
	Connection,
	Finality,
	PublicKey,
	TransactionResponse,
	TransactionSignature,
} from '@solana/web3.js';
import { WrappedEvents } from './types';

type Log = { txSig: TransactionSignature; slot: number; logs: string[] };
type FetchLogsResponse = {
	earliestTx: string;
	mostRecentTx: string;
	earliestSlot: number;
	mostRecentSlot: number;
	transactionLogs: Log[];
};

function mapTransactionResponseToLog(transaction: TransactionResponse): Log {
	return {
		txSig: transaction.transaction.signatures[0],
		slot: transaction.slot,
		logs: transaction.meta.logMessages,
	};
}

export async function fetchLogs(
	connection: Connection,
	programId: PublicKey,
	finality: Finality,
	beforeTx?: TransactionSignature,
	untilTx?: TransactionSignature,
	limit?: number
): Promise<FetchLogsResponse> {
	const signatures = await connection.getSignaturesForAddress(
		programId,
		{
			before: beforeTx,
			until: untilTx,
			limit,
		},
		finality
	);

	const sortedSignatures = signatures.sort((a, b) =>
		a.slot === b.slot ? 0 : a.slot < b.slot ? -1 : 1
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
					return mapTransactionResponseToLog(transaction);
				});
			})
		)
	).flat();

	const earliest = filteredSignatures[0];
	const mostRecent = filteredSignatures[filteredSignatures.length - 1];

	return {
		transactionLogs: transactionLogs,
		earliestTx: earliest.signature,
		mostRecentTx: mostRecent.signature,
		earliestSlot: earliest.slot,
		mostRecentSlot: mostRecent.slot,
	};
}

function chunk<T>(array: readonly T[], size: number): T[][] {
	return new Array(Math.ceil(array.length / size))
		.fill(null)
		.map((_, index) => index * size)
		.map((begin) => array.slice(begin, begin + size));
}

export class LogParser {
	private program: Program;

	constructor(program: Program) {
		this.program = program;
	}

	public parseEventsFromTransaction(
		transaction: TransactionResponse
	): WrappedEvents {
		const transactionLogObject = mapTransactionResponseToLog(transaction);

		return this.parseEventsFromLogs(transactionLogObject);
	}

	public parseEventsFromLogs(event: Log): WrappedEvents {
		const records: WrappedEvents = [];
		// @ts-ignore
		this.program._events._eventParser.parseLogs(event.logs, (eventLog) => {
			eventLog.data.txSig = event.txSig;
			eventLog.data.slot = event.slot;
			eventLog.data.eventType = eventLog.name;
			records.push(eventLog.data);
		});
		return records;
	}
}
