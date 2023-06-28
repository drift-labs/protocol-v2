import { Program } from '@coral-xyz/anchor';
import {
	Connection,
	Finality,
	PublicKey,
	TransactionResponse,
	TransactionSignature,
	VersionedTransactionResponse,
} from '@solana/web3.js';
import { WrappedEvents } from './types';

type Log = { txSig: TransactionSignature; slot: number; logs: string[] };
type FetchLogsResponse = {
	earliestTx: string;
	mostRecentTx: string;
	earliestSlot: number;
	mostRecentSlot: number;
	transactionLogs: Log[];
	mostRecentBlockTime: number | undefined;
};

function mapTransactionResponseToLog(
	transaction: TransactionResponse | VersionedTransactionResponse
): Log {
	return {
		txSig: transaction.transaction.signatures[0],
		slot: transaction.slot,
		logs: transaction.meta.logMessages,
	};
}

export async function fetchLogs(
	connection: Connection,
	address: PublicKey,
	finality: Finality,
	beforeTx?: TransactionSignature,
	untilTx?: TransactionSignature,
	limit?: number
): Promise<FetchLogsResponse> {
	const signatures = await connection.getSignaturesForAddress(
		address,
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

	const config = { commitment: finality, maxSupportedTransactionVersion: 0 };

	const transactionLogs = (
		await Promise.all(
			chunkedSignatures.map(async (chunk) => {
				const transactions = await connection.getTransactions(
					chunk.map((confirmedSignature) => confirmedSignature.signature),
					//@ts-ignore
					config
				);

				return transactions.reduce((logs, transaction) => {
					if (transaction) {
						logs.push(mapTransactionResponseToLog(transaction));
					}
					return logs;
				}, new Array<Log>());
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
		mostRecentBlockTime: mostRecent.blockTime,
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
		const eventGenerator = this.program._events._eventParser.parseLogs(
			event.logs,
			false
		);
		for (const eventLog of eventGenerator) {
			eventLog.data.txSig = event.txSig;
			eventLog.data.slot = event.slot;
			eventLog.data.eventType = eventLog.name;
			records.push(eventLog.data);
		}
		return records;
	}
}
