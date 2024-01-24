import { Connection, PublicKey } from '@solana/web3.js';
import {
	PriorityFeeMethod,
	PriorityFeeStrategy,
	PriorityFeeSubscriberConfig,
} from './types';
import { AverageOverSlotsStrategy } from './averageOverSlotsStrategy';
import { MaxOverSlotsStrategy } from './maxOverSlotsStrategy';
import { fetchSolanaPriorityFee } from './solanaPriorityFeeMethod';
import {
	HeliusPriorityFeeLevels,
	HeliusPriorityLevel,
	fetchHeliusPriorityFee,
} from './heliusPriorityFeeMethod';

export class PriorityFeeSubscriber {
	connection: Connection;
	frequencyMs: number;
	addresses: string[];
	customStrategy?: PriorityFeeStrategy;
	averageStrategy = new AverageOverSlotsStrategy();
	maxStrategy = new MaxOverSlotsStrategy();
	priorityFeeMethod = PriorityFeeMethod.SOLANA;
	lookbackDistance: number;

	heliusApiKey?: string;
	lastHeliusSample?: HeliusPriorityFeeLevels;

	intervalId?: ReturnType<typeof setTimeout>;

	latestPriorityFee = 0;
	lastCustomStrategyResult = 0;
	lastAvgStrategyResult = 0;
	lastMaxStrategyResult = 0;
	lastSlotSeen = 0;

	/**
	 * @param props
	 * customStrategy : strategy to return the priority fee to use based on recent samples. defaults to AVERAGE.
	 */
	public constructor(config: PriorityFeeSubscriberConfig) {
		this.connection = config.connection;
		this.frequencyMs = config.frequencyMs;
		this.addresses = config.addresses.map((address) => address.toBase58());
		if (config.customStrategy) {
			this.customStrategy = config.customStrategy;
		}
		this.lookbackDistance = config.slotsToCheck ?? 50;
		if (config.priorityFeeMethod) {
			this.priorityFeeMethod = config.priorityFeeMethod;

			if (
				this.priorityFeeMethod === PriorityFeeMethod.HELIUS &&
				config.heliusApiKey === undefined
			) {
				throw new Error(
					'Helius API key must be provided to use HELIUS priority fee API'
				);
			}
			this.heliusApiKey = config.heliusApiKey;
		}

		if (this.priorityFeeMethod === PriorityFeeMethod.SOLANA) {
			if (this.connection === undefined) {
				throw new Error(
					'connection must be provided to use SOLANA priority fee API'
				);
			}
		}
	}

	public async subscribe(): Promise<void> {
		if (this.intervalId) {
			return;
		}

		this.intervalId = setInterval(this.load.bind(this), this.frequencyMs);
	}

	private async loadForSolana(): Promise<void> {
		const samples = await fetchSolanaPriorityFee(
			this.connection!,
			this.lookbackDistance,
			this.addresses
		);
		console.log(samples);
		this.latestPriorityFee = samples[0].prioritizationFee;
		this.lastSlotSeen = samples[0].slot;

		this.lastAvgStrategyResult = this.averageStrategy.calculate(samples);
		this.lastMaxStrategyResult = this.maxStrategy.calculate(samples);
		if (this.customStrategy) {
			this.lastCustomStrategyResult = this.customStrategy.calculate(samples);
		}
	}

	private async loadForHelius(): Promise<void> {
		const sample = await fetchHeliusPriorityFee(
			this.heliusApiKey,
			this.lookbackDistance,
			this.addresses
		);
		this.lastHeliusSample = sample.result.priorityFeeLevels;
	}

	public getHeliusPriorityFeeLevel(
		level: HeliusPriorityLevel = HeliusPriorityLevel.MEDIUM
	): number {
		if (this.lastHeliusSample === undefined) {
			return 0;
		}
		return this.lastHeliusSample[level];
	}

	public getCustomStrategyResult(): number {
		return this.lastCustomStrategyResult;
	}

	public getAvgStrategyResult(): number {
		return this.lastAvgStrategyResult;
	}

	public getMaxStrategyResult(): number {
		return this.lastMaxStrategyResult;
	}

	public async load(): Promise<void> {
		if (this.priorityFeeMethod === PriorityFeeMethod.SOLANA) {
			await this.loadForSolana();
		} else if (this.priorityFeeMethod === PriorityFeeMethod.HELIUS) {
			await this.loadForHelius();
		} else {
			throw new Error(`${this.priorityFeeMethod} load not implemented`);
		}
	}

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
