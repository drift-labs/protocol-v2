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
	lookbackDistance : number;

	intervalId?: ReturnType<typeof setTimeout>;

	latestPriorityFee = 0;
	lastStrategyResult = 0;
	lastCustomStrategyResult = 0;
	lastAvgStrategyResult = 0;
	lastMaxStrategyResult = 0;
	lastSlotSeen = 0;

	/**
	 * @param props 
	 * customStrategy : strategy to return the priority fee to use based on recent samples. defaults to AVERAGE.
	 */
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
		if (!customStrategy) {
			this.customStrategy = new AverageOverSlotsStrategy();
		} else {
			this.customStrategy=customStrategy;
		}
		this.lookbackDistance = slotsToCheck;
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

		const results: { slot: number; prioritizationFee: number }[] =
			rpcJSONResponse?.result;
		
		if (!results.length) return;

		// # Sort and filter results based on the slot lookback setting
		const descResults = results.sort((a, b) => b.slot - a.slot);
		const mostRecentResult = descResults[0];
		const cutoffSlot = mostRecentResult.slot - this.lookbackDistance;

		const resultsToUse = descResults.filter(result => result.slot >= cutoffSlot);

		// # Handle results
		this.latestPriorityFee = mostRecentResult.prioritizationFee;
		this.lastSlotSeen = mostRecentResult.slot;

		this.lastAvgStrategyResult = this.averageStrategy.calculate(resultsToUse);
		this.lastMaxStrategyResult = this.maxStrategy.calculate(resultsToUse);
		if (this.customStrategy) {
			this.lastCustomStrategyResult =
				this.customStrategy.calculate(resultsToUse);
		}

	}

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
