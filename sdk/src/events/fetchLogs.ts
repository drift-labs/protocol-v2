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
import { promiseTimeout } from '../util/promiseTimeout';
import { parseLogs } from './parse';

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
	limit?: number,
	batchSize = 25
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

	const chunkedSignatures = chunk(filteredSignatures, batchSize);

	const transactionLogs = (
		await Promise.all(
			chunkedSignatures.map(async (chunk) => {
				return await fetchTransactionLogs(
					connection,
					chunk.map((confirmedSignature) => confirmedSignature.signature),
					finality
				);
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

export async function fetchTransactionLogs(
	connection: Connection,
	signatures: TransactionSignature[],
	finality: Finality
): Promise<Log[]> {
	const requests = new Array<{ methodName: string; args: any }>();
	for (const signature of signatures) {
		const args = [
			signature,
			{ commitment: finality, maxSupportedTransactionVersion: 0 },
		];

		requests.push({
			methodName: 'getTransaction',
			args,
		});
	}

	const rpcResponses: any | null = await promiseTimeout(
		// @ts-ignore
		connection._rpcBatchRequest(requests),
		10 * 1000 // 10 second timeout
	);

	if (rpcResponses === null) {
		return Promise.reject('RPC request timed out fetching transactions');
	}

	const logs = new Array<Log>();
	for (const rpcResponse of rpcResponses) {
		if (rpcResponse.result) {
			logs.push(mapTransactionResponseToLog(rpcResponse.result));
		}
	}

	return logs;
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

		if (!event.logs) return records;

		let runningEventIndex = 0;
		for (const eventLog of parseLogs(this.program, event.logs)) {
			eventLog.data.txSig = event.txSig;
			eventLog.data.slot = event.slot;
			eventLog.data.eventType = eventLog.name;
			eventLog.data.txSigIndex = runningEventIndex;
			// @ts-ignore
			records.push(eventLog.data);
			runningEventIndex++;
		}
		return records;
	}
}
