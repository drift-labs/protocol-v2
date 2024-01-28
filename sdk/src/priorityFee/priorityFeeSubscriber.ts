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

	heliusRpcUrl?: string;
	lastHeliusSample?: HeliusPriorityFeeLevels;

	intervalId?: ReturnType<typeof setTimeout>;

	latestPriorityFee = 0;
	lastCustomStrategyResult = 0;
	lastAvgStrategyResult = 0;
	lastMaxStrategyResult = 0;
	lastSlotSeen = 0;

	public constructor(config: PriorityFeeSubscriberConfig) {
		this.connection = config.connection;
		this.frequencyMs = config.frequencyMs;
		this.addresses = config.addresses.map((address) => address.toBase58());
		if (config.customStrategy) {
			this.customStrategy = config.customStrategy;
		} else {
			this.customStrategy = this.averageStrategy;
		}
		this.lookbackDistance = config.slotsToCheck ?? 50;
		if (config.priorityFeeMethod) {
			this.priorityFeeMethod = config.priorityFeeMethod;

			if (this.priorityFeeMethod === PriorityFeeMethod.HELIUS) {
				if (config.heliusRpcUrl === undefined) {
					if (this.connection.rpcEndpoint.includes('helius')) {
						this.heliusRpcUrl = this.connection.rpcEndpoint;
					} else {
						throw new Error(
							'Connection must be helius, or heliusRpcUrl must be provided to use PriorityFeeMethod.HELIUS'
						);
					}
				} else {
					this.heliusRpcUrl = config.heliusRpcUrl;
				}
			}
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

		await this.load();
		this.intervalId = setInterval(this.load.bind(this), this.frequencyMs);
	}

	private async loadForSolana(): Promise<void> {
		const samples = await fetchSolanaPriorityFee(
			this.connection!,
			this.lookbackDistance,
			this.addresses
		);
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
			this.heliusRpcUrl,
			this.lookbackDistance,
			this.addresses
		);
		this.lastHeliusSample = sample?.result?.priorityFeeLevels ?? undefined;
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
		try {
			if (this.priorityFeeMethod === PriorityFeeMethod.SOLANA) {
				await this.loadForSolana();
			} else if (this.priorityFeeMethod === PriorityFeeMethod.HELIUS) {
				await this.loadForHelius();
			} else {
				throw new Error(`${this.priorityFeeMethod} load not implemented`);
			}
		} catch (err) {
			const e = err as Error;
			console.error(
				`Error loading priority fee ${this.priorityFeeMethod}: ${e.message}\n${
					e.stack ? e.stack : ''
				}`
			);
			return;
		}
	}

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}

	public updateAddresses(addresses: PublicKey[]) {
		this.addresses = addresses.map((k) => k.toBase58());
	}
}
