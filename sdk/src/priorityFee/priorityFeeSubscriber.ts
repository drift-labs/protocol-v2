import { Connection, PublicKey } from '@solana/web3.js';
import { PriorityFeeStrategy } from './types';
import { AverageStrategy } from './averageStrategy';
import { MaxStrategy } from './maxStrategy';

export class PriorityFeeSubscriber {
	connection: Connection;
	frequencyMs: number;
	addresses: PublicKey[];
	slotsToCheck: number;
	customStrategy?: PriorityFeeStrategy;
	averageStrategy = new AverageStrategy();
	maxStrategy = new MaxStrategy();

	intervalId?: ReturnType<typeof setTimeout>;

	latestPriorityFee = 0;
	lastStrategyResult = 0;
	lastCustomStrategyResult = 0;
	lastAvgStrategyResult = 0;
	lastMaxStrategyResult = 0;
	lastSlotSeen = 0;

	public constructor({
		connection,
		frequencyMs,
		addresses,
		strategy: customStrategy,
		slotsToCheck = 10,
	}: {
		connection: Connection;
		frequencyMs: number;
		addresses: PublicKey[];
		strategy?: PriorityFeeStrategy;
		slotsToCheck?: number;
	}) {
		this.connection = connection;
		this.frequencyMs = frequencyMs;
		this.addresses = addresses;
		this.slotsToCheck = slotsToCheck;
		if (customStrategy) {
			this.customStrategy = customStrategy;
		}
	}

	public get avgPriorityFee(): number {
		return this.lastAvgStrategyResult;
	}

	public get maxPriorityFee(): number {
		return this.lastMaxStrategyResult;
	}

	public get customPriorityFee(): number {
		if (!this.customStrategy) {
			console.error('Custom strategy not set');
		}
		return this.lastCustomStrategyResult;
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

		const descResults: { slot: number; prioritizationFee: number }[] =
			rpcJSONResponse?.result
				?.sort((a, b) => b.slot - a.slot)
				?.slice(0, this.slotsToCheck) ?? [];

		if (!descResults?.length) return;

		const mostRecentResult = descResults[0];
		this.latestPriorityFee = mostRecentResult.prioritizationFee;
		this.lastSlotSeen = mostRecentResult.slot;

		this.lastAvgStrategyResult = this.averageStrategy.calculate(descResults);
		this.lastMaxStrategyResult = this.maxStrategy.calculate(descResults);
		if (this.customStrategy) {
			this.lastCustomStrategyResult =
				this.customStrategy.calculate(descResults);
		}
	}

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
