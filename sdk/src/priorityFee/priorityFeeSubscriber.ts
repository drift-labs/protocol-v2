import { Connection, PublicKey } from '@solana/web3.js';

export class PriorityFeeSubscriber {
	connection: Connection;
	frequencyMs: number;
	addresses: PublicKey[];

	intervalId?: NodeJS.Timer;

	latestPriorityFee = 0;
	// avg of last 5 slots
	avgPriorityFee = 0;
	lastSlotSeen = 0;

	public constructor({
		connection,
		frequencyMs,
		addresses,
	}: {
		connection: Connection;
		frequencyMs: number;
		addresses: PublicKey[];
	}) {
		this.connection = connection;
		this.frequencyMs = frequencyMs;
		this.addresses = addresses;
	}

	public async subscribe(): Promise<void> {
		if (this.intervalId) {
			return;
		}

		this.intervalId = setInterval(this.load.bind(this), this.frequencyMs);
	}

	public async load(): Promise<void> {
		// @ts-ignore
		const rpcJSONResponse: any = await this.connection._rpcRequest(
			'getRecentPrioritizationFees',
			[this.addresses]
		);

		const descResults: {slot: number; prioritizationFee: number}[] = rpcJSONResponse?.result?.sort((a, b) => b.slot - a.slot)?.slice(0, 5) ?? [];

		if (!descResults.length) return;

		const mostRecentResult = descResults[0];
		this.latestPriorityFee = mostRecentResult.prioritizationFee;
		this.lastSlotSeen = mostRecentResult.slot;
		this.avgPriorityFee = descResults.reduce((a, b) => { return a + b.prioritizationFee }, 0) / descResults.length;
	}

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
