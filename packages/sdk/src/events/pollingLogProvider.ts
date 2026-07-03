import { LogProvider, logProviderCallback } from './types';
import {
	Commitment,
	Connection,
	Finality,
	PublicKey,
	TransactionSignature,
} from '@solana/web3.js';
import { fetchLogs } from './fetchLogs';

/**
 * `LogProvider` that polls `fetchLogs` (`getSignaturesForAddress` +
 * `getTransaction`) on a fixed interval instead of holding a websocket open.
 * Used both as the default fallback provider after repeated websocket
 * reconnect failures and as an explicit choice for RPCs without reliable log
 * subscriptions. Only one poll runs at a time (a simple mutex flag skips an
 * overlapping tick if the previous fetch hasn't finished).
 */
export class PollingLogProvider implements LogProvider {
	private finality: Finality;
	private intervalId?: ReturnType<typeof setTimeout>;
	private mostRecentSeenTx?: TransactionSignature;
	private mutex = 0;
	private firstFetch = true;

	/**
	 * @param connection RPC connection to poll on.
	 * @param address Account/program address to poll logs for.
	 * @param commitment Commitment level; anything other than `'finalized'` is treated as `'confirmed'` for the underlying `fetchLogs` calls.
	 * @param frequency Poll interval in milliseconds; defaults to 15000 (15s).
	 * @param batchSize Max `getTransaction` calls batched per `fetchLogs` round-trip.
	 */
	public constructor(
		private connection: Connection,
		private address: PublicKey,
		commitment: Commitment,
		private frequency = 15 * 1000,
		private batchSize?: number
	) {
		this.finality = commitment === 'finalized' ? 'finalized' : 'confirmed';
	}

	/**
	 * Starts the polling interval; the first tick fires immediately per
	 * `setInterval` semantics only after `frequency` ms (there is no
	 * immediate initial fetch). Idempotent — a second call while already
	 * subscribed is a no-op.
	 * @param skipHistory On the first poll only, fetches just the single most recent transaction instead of the full backlog since `mostRecentSeenTx`.
	 * @returns Always resolves `true`.
	 */
	public async subscribe(
		callback: logProviderCallback,
		skipHistory?: boolean
	): Promise<boolean> {
		if (this.intervalId) {
			return true;
		}

		this.intervalId = setInterval(async () => {
			if (this.mutex === 1) {
				return;
			}
			this.mutex = 1;

			try {
				const response = await fetchLogs(
					this.connection,
					this.address,
					this.finality,
					undefined,
					this.mostRecentSeenTx,
					// If skipping history, only fetch one log back, not the maximum amount available
					skipHistory && this.firstFetch ? 1 : undefined,
					this.batchSize
				);

				if (response === undefined) {
					return;
				}

				this.firstFetch = false;

				const { mostRecentTx, transactionLogs } = response;

				for (const { txSig, slot, logs } of transactionLogs) {
					callback(txSig, slot, logs, response.mostRecentBlockTime, undefined);
				}

				this.mostRecentSeenTx = mostRecentTx;
			} catch (e) {
				console.error('PollingLogProvider threw an Error');
				console.error(e);
			} finally {
				this.mutex = 0;
			}
		}, this.frequency);

		return true;
	}

	public isSubscribed(): boolean {
		return this.intervalId !== undefined;
	}

	/** Stops the polling interval. Always resolves `true`. */
	public async unsubscribe(): Promise<boolean> {
		if (this.intervalId !== undefined) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
		return true;
	}
}
