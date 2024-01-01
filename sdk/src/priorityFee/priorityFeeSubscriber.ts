import { Connection, PublicKey } from '@solana/web3.js';
import { PriorityFeeStrategy } from './types';
import { AverageOverSlotsStrategy } from './averageOverSlotsStrategy';
import { MaxOverSlotsStrategy } from './maxOverSlotsStrategy';

export class PriorityFeeSubscriber {
	connection: Connection;
	frequencyMs: number;
	addresses: PublicKey[];
	customStrategy?: PriorityFeeStrategy;
	averageStrategy = new AverageOverSlotsStrategy();
	maxStrategy = new MaxOverSlotsStrategy();

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
		customStrategy,
		slotsToCheck = 10,
	}: {
		connection: Connection;
		frequencyMs: number;
		addresses: PublicKey[];
		customStrategy?: PriorityFeeStrategy;
		slotsToCheck?: number;
	}) {
		this.connection = connection;
		this.frequencyMs = frequencyMs;
		this.addresses = addresses;
		if (slotsToCheck) {
			this.averageStrategy = new AverageOverSlotsStrategy(slotsToCheck);
			this.maxStrategy = new MaxOverSlotsStrategy(slotsToCheck);
		}
		if (customStrategy) {
			this.customStrategy = customStrategy;
		}
	}

	public get avgPriorityFee(): number {
		return Math.floor(this.lastAvgStrategyResult);
	}

	public get maxPriorityFee(): number {
		return Math.floor(this.lastMaxStrategyResult);
	}

	public get customPriorityFee(): number {
		if (!this.customStrategy) {
			console.error('Custom strategy not set');
		}
		return Math.floor(this.lastCustomStrategyResult);
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

		// getRecentPrioritizationFees returns results unsorted
		const results: { slot: number; prioritizationFee: number }[] =
			rpcJSONResponse?.result;
		if (!results.length) return;
		const descResults = results.sort((a, b) => b.slot - a.slot);

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
