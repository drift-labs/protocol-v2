import { Connection, PublicKey } from '@solana/web3.js';
import { PriorityFeeStrategy } from './types';
import { AverageOverSlotsStrategy } from './averageOverSlotsStrategy';

export class PriorityFeeSubscriber {
	connection: Connection;
	frequencyMs: number;
	addresses: PublicKey[];
	strategy: PriorityFeeStrategy;
	lookbackDistance : number;

	intervalId?: ReturnType<typeof setTimeout>;

	latestPriorityFee = 0;
	private _latestStrategyResult = 0;
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
			this.strategy = new AverageOverSlotsStrategy();
		} else {
			this.strategy=customStrategy;
		}
		this.lookbackDistance = slotsToCheck;
	}

	public get latestStrategyResult(): number {
		return Math.floor(this._latestStrategyResult);
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
		const cutoffSlot = mostRecentResult.slot - this.lookbackDistance;

		const resultsToUse = descResults.filter(result => result.slot >= cutoffSlot);

		this.latestPriorityFee = mostRecentResult.prioritizationFee;
		this.lastSlotSeen = mostRecentResult.slot;
		this._latestStrategyResult = this.strategy.calculate(resultsToUse);
	}

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
