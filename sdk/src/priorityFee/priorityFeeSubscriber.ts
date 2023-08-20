import { Connection, PublicKey } from '@solana/web3.js';

export class PriorityFeeSubscriber {
	connection: Connection;
	frequency: number;
	addresses: PublicKey[];

	intervalId?: NodeJS.Timer;

	avg = 0;
	max = 0;

	public constructor({
		connection,
		frequency,
		addresses,
	}: {
		connection: Connection;
		frequency: number;
		addresses: PublicKey[];
	}) {
		this.connection = connection;
		this.frequency = frequency;
		this.addresses = addresses;
	}

	public async subscribe(): Promise<void> {
		if (this.intervalId) {
			return;
		}

		this.intervalId = setInterval(this.load.bind(this), this.frequency);
	}

	public async load(): Promise<void> {
		// @ts-ignore
		const rpcJSONResponse: any = await this.connection._rpcRequest(
			'getRecentPrioritizationFees',
			[this.addresses]
		);

		let sum = 0;
		let max = 0;

		for (const { prioritizationFee } of rpcJSONResponse.result) {
			sum += prioritizationFee;
			max = Math.max(max, prioritizationFee);
		}

		const avg = sum / rpcJSONResponse.result.length;

		this.max = max;
		this.avg = avg;
	}

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
