import { Program } from '../isomorphic/anchor';
import {
	Connection,
	Finality,
	PublicKey,
	TransactionResponse,
	TransactionSignature,
	VersionedTransactionResponse,
} from '@solana/web3.js';
import {
	DefaultEventSubscriptionOptions,
	EventType,
	WrappedEvents,
} from './types';
import { promiseTimeout } from '../util/promiseTimeout';
import { parseLogs } from './parse';

/**
 * Case-insensitive lookup from decoded (camelCase) IDL event names to
 * PascalCase `EventType` keys, mirroring `EventSubscriber`'s
 * `eventTypeByLowercaseName` — `@coral-xyz/anchor` 0.32+ decodes event names
 * in camelCase, but the rest of the SDK keys off the PascalCase `EventType`.
 */
const eventTypeByLowercaseName = new Map<string, EventType>(
	(DefaultEventSubscriptionOptions.eventTypes ?? []).map((eventType) => [
		eventType.toLowerCase(),
		eventType,
	])
);

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
		logs: transaction.meta?.logMessages ?? [],
	};
}

/**
 * Fetches raw transaction logs for `address`, newest-first from
 * `getSignaturesForAddress` then batch-fetched via `getTransaction`. Used by
 * both `PollingLogProvider` (incremental polling) and
 * `EventSubscriber.fetchPreviousTx` (historical backfill). Failed
 * transactions (with an `err`) are filtered out before fetching logs.
 * @param connection RPC connection.
 * @param address Account/program address to fetch signatures for.
 * @param finality Commitment for both the signature list and the transaction fetches.
 * @param beforeTx Only return signatures older than this one (pagination cursor).
 * @param untilTx Stop at (exclusive of) this signature.
 * @param limit Max signatures to request from `getSignaturesForAddress`; RPC default applies if omitted.
 * @param batchSize Number of `getTransaction` calls batched per RPC round-trip; defaults to 25.
 * @returns `undefined` if no non-failed signatures were found in range; otherwise the transaction logs plus the earliest/most-recent signature, slot, and block time observed, for use as the next `beforeTx`/`mostRecentSeenTx` cursor.
 */
export async function fetchLogs(
	connection: Connection,
	address: PublicKey,
	finality: Finality,
	beforeTx?: TransactionSignature,
	untilTx?: TransactionSignature,
	limit?: number,
	batchSize = 25
): Promise<FetchLogsResponse | undefined> {
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
		mostRecentBlockTime: mostRecent.blockTime ?? undefined,
	};
}

/**
 * Fetches `getTransaction` for a batch of signatures in a single RPC batch
 * request, with a 10-second overall timeout.
 * @param connection RPC connection.
 * @param signatures Signatures to fetch (fetched as `maxSupportedTransactionVersion: 0`).
 * @param finality Commitment to fetch each transaction at.
 * @returns One `Log` per signature that returned a result (signatures the RPC couldn't resolve are silently dropped, not padded with placeholders).
 * @throws (rejects) if the batch RPC call doesn't complete within 10 seconds.
 */
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

/**
 * Standalone helper to decode events out of an already-fetched transaction or
 * log object, without going through `EventSubscriber`. Useful for one-off
 * decoding (e.g. re-parsing a transaction fetched elsewhere).
 */
export class LogParser {
	private program: Program;

	constructor(program: Program) {
		this.program = program;
	}

	/** Decodes the events emitted in a fetched `TransactionResponse`. Assigns `txSigIndex` by decode order (0-based), not by any provider-supplied index. */
	public parseEventsFromTransaction(
		transaction: TransactionResponse
	): WrappedEvents {
		const transactionLogObject = mapTransactionResponseToLog(transaction);

		return this.parseEventsFromLogs(transactionLogObject);
	}

	/** Decodes the events in a `{ txSig, slot, logs }` log object. Returns an empty array if `logs` is falsy. Assigns `txSigIndex` by decode order (0-based). */
	public parseEventsFromLogs(event: Log): WrappedEvents {
		const records: WrappedEvents = [];

		if (!event.logs) return records;

		let runningEventIndex = 0;
		for (const eventLog of parseLogs(this.program, event.logs)) {
			eventLog.data.txSig = event.txSig;
			eventLog.data.slot = event.slot;
			eventLog.data.eventType =
				eventTypeByLowercaseName.get(eventLog.name.toLowerCase()) ??
				eventLog.name;
			eventLog.data.txSigIndex = runningEventIndex;
			// @ts-ignore
			records.push(eventLog.data);
			runningEventIndex++;
		}
		return records;
	}
}
