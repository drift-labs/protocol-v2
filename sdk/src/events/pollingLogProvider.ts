import { LogProvider, logProviderCallback } from './types';
import {
	Commitment,
	ConfirmedSignatureInfo,
	Connection,
	Finality,
	LogsCallback,
	PublicKey,
	TransactionSignature,
} from '@solana/web3.js';

export class PollingLogProvider implements LogProvider {
	private finality: Finality;
	private intervalId: NodeJS.Timer;
	private mostRecentSeenTx?: TransactionSignature;
	private mutex: number;

	public constructor(
		private connection: Connection,
		private programId: PublicKey,
		commitment: Commitment,
		private frequency = 15 * 1000
	) {
		this.finality = commitment === 'finalized' ? 'finalized' : 'confirmed';
	}

	public subscribe(callback: logProviderCallback): boolean {
		this.intervalId = setInterval(async () => {
			if (this.mutex === 1) {
				return;
			}
			this.mutex = 1;

			try {
				const signatures = await this.connection.getSignaturesForAddress(
					this.programId,
					{
						until: this.mostRecentSeenTx,
					},
					this.finality
				);

				const sortedSignatures = signatures.sort((a, b) =>
					a.slot < b.slot ? -1 : 1
				);

				if (sortedSignatures.length === 0) {
					return;
				}

				const chunkedSignatures = this.chunk(sortedSignatures, 100);

				this.mostRecentSeenTx =
					sortedSignatures[sortedSignatures.length - 1].signature;
			} catch (e) {
				console.error('PollingLogProvider threw an Error');
				console.error(e);
			} finally {
				this.mutex = 0;
			}
		}, this.frequency);
	}

	chunk<T>(array: readonly T[], size: number): T[][] {
		return new Array(Math.ceil(array.length / size))
			.fill(null)
			.map((_, index) => index * size)
			.map((begin) => array.slice(begin, begin + size));
	}

	fetchLogs(
		confirmedSignatures: ConfirmedSignatureInfo[],
		callback: LogsCallback
	): void {
		this.connection.getTransactions(
			confirmedSignatures.map(
				(confirmedSignature) => confirmedSignature.signature
			),
			this.finality
		);
	}

	public isSubscribed(): boolean {
		return this.intervalId !== undefined;
	}

	public async unsubscribe(): Promise<boolean> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
		return true;
	}
}
