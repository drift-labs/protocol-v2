import { Program } from '@coral-xyz/anchor';
import { TransactionSignature } from '@solana/web3.js';
import { WrappedEvents } from '../types/types';

type Log = { txSig: TransactionSignature; slot: number; logs: string[] };

export class LogParser {
	constructor(private program: Program) {}

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
