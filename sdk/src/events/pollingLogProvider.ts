import { LogProvider, logProviderCallback } from './types';
import {
	Commitment,
	Connection,
	Finality,
	PublicKey,
	TransactionSignature,
} from '@solana/web3.js';
import { fetchLogs } from './fetchLogs';

export class PollingLogProvider implements LogProvider {
	private finality: Finality;
	private intervalId: NodeJS.Timer;
	private mostRecentSeenTx?: TransactionSignature;
	private mutex: number;
	private firstFetch = true;

	public constructor(
		private connection: Connection,
		private address: PublicKey,
		commitment: Commitment,
		private frequency = 15 * 1000
	) {
		this.finality = commitment === 'finalized' ? 'finalized' : 'confirmed';
	}

	public subscribe(
		callback: logProviderCallback,
		skipHistory?: boolean
	): boolean {
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
					skipHistory && this.firstFetch ? 1 : undefined
				);

				if (response === undefined) {
					return;
				}

				this.firstFetch = false;

				const { mostRecentTx, transactionLogs } = response;

				for (const { txSig, slot, logs } of transactionLogs) {
					callback(txSig, slot, logs, response.mostRecentBlockTime);
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

	public async unsubscribe(): Promise<boolean> {
		if (this.intervalId !== undefined) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
		return true;
	}
}
