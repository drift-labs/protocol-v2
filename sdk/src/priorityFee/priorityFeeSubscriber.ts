import { Connection, PublicKey } from '@solana/web3.js';
import {
	DEFAULT_PRIORITY_FEE_MAP_FREQUENCY_MS,
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
import {
	fetchDriftPriorityFee,
	DriftMarketInfo,
} from './driftPriorityFeeMethod';

export class PriorityFeeSubscriber {
	connection: Connection;
	frequencyMs: number;
	addresses: string[];
	driftMarkets?: DriftMarketInfo[];
	customStrategy?: PriorityFeeStrategy;
	averageStrategy = new AverageOverSlotsStrategy();
	maxStrategy = new MaxOverSlotsStrategy();
	priorityFeeMethod = PriorityFeeMethod.SOLANA;
	lookbackDistance: number;
	maxFeeMicroLamports?: number;
	priorityFeeMultiplier?: number;

	driftPriorityFeeEndpoint?: string;
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
		this.frequencyMs =
			config.frequencyMs ?? DEFAULT_PRIORITY_FEE_MAP_FREQUENCY_MS;
		this.addresses = config.addresses
			? config.addresses.map((address) => address.toBase58())
			: [];
		this.driftMarkets = config.driftMarkets;

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
			} else if (this.priorityFeeMethod === PriorityFeeMethod.DRIFT) {
				this.driftPriorityFeeEndpoint = config.driftPriorityFeeEndpoint;
			}
		}

		if (this.priorityFeeMethod === PriorityFeeMethod.SOLANA) {
			if (this.connection === undefined) {
				throw new Error(
					'connection must be provided to use SOLANA priority fee API'
				);
			}
		}

		this.maxFeeMicroLamports = config.maxFeeMicroLamports;
		this.priorityFeeMultiplier = config.priorityFeeMultiplier ?? 1.0;
	}

	public async subscribe(): Promise<void> {
		if (this.intervalId) {
			return;
		}

		this.intervalId = setInterval(this.load.bind(this), this.frequencyMs); // we set the intervalId first, preventing a side effect of unsubscribing failing during the race condition where unsubscribes happens before subscribe is finished
		await this.load();
	}

	private async loadForSolana(): Promise<void> {
		const samples = await fetchSolanaPriorityFee(
			this.connection!,
			this.lookbackDistance,
			this.addresses
		);
		if (samples.length > 0) {
			this.latestPriorityFee = samples[0].prioritizationFee;
			this.lastSlotSeen = samples[0].slot;

			this.lastAvgStrategyResult = this.averageStrategy.calculate(samples);
			this.lastMaxStrategyResult = this.maxStrategy.calculate(samples);
			if (this.customStrategy) {
				this.lastCustomStrategyResult = this.customStrategy.calculate(samples);
			}
		}
	}

	private async loadForHelius(): Promise<void> {
		const sample = await fetchHeliusPriorityFee(
			this.heliusRpcUrl,
			this.lookbackDistance,
			this.addresses
		);
		this.lastHeliusSample = sample?.result?.priorityFeeLevels ?? undefined;

		if (this.lastHeliusSample) {
			this.lastAvgStrategyResult =
				this.lastHeliusSample[HeliusPriorityLevel.MEDIUM];
			this.lastMaxStrategyResult =
				this.lastHeliusSample[HeliusPriorityLevel.UNSAFE_MAX];
			if (this.customStrategy) {
				this.lastCustomStrategyResult = this.customStrategy.calculate(sample!);
			}
		}
	}

	private async loadForDrift(): Promise<void> {
		if (!this.driftMarkets) {
			return;
		}
		const sample = await fetchDriftPriorityFee(
			this.driftPriorityFeeEndpoint!,
			this.driftMarkets.map((m) => m.marketType),
			this.driftMarkets.map((m) => m.marketIndex)
		);
		if (sample.length > 0) {
			this.lastAvgStrategyResult = sample[HeliusPriorityLevel.MEDIUM];
			this.lastMaxStrategyResult = sample[HeliusPriorityLevel.UNSAFE_MAX];
			if (this.customStrategy) {
				this.lastCustomStrategyResult = this.customStrategy.calculate(sample);
			}
		}
	}

	public getMaxPriorityFee(): number | undefined {
		return this.maxFeeMicroLamports;
	}

	public updateMaxPriorityFee(newMaxFee: number | undefined) {
		this.maxFeeMicroLamports = newMaxFee;
	}

	public getPriorityFeeMultiplier(): number {
		return this.priorityFeeMultiplier ?? 1.0;
	}

	public updatePriorityFeeMultiplier(newPriorityFeeMultiplier: number) {
		this.priorityFeeMultiplier = newPriorityFeeMultiplier;
	}

	public updateCustomStrategy(newStrategy: PriorityFeeStrategy) {
		this.customStrategy = newStrategy;
	}

	public getHeliusPriorityFeeLevel(
		level: HeliusPriorityLevel = HeliusPriorityLevel.MEDIUM
	): number {
		if (this.lastHeliusSample === undefined) {
			return 0;
		}
		if (this.maxFeeMicroLamports !== undefined) {
			return Math.min(this.maxFeeMicroLamports, this.lastHeliusSample[level]);
		}
		return this.lastHeliusSample[level];
	}

	public getCustomStrategyResult(): number {
		const result =
			this.lastCustomStrategyResult * this.getPriorityFeeMultiplier();
		if (this.maxFeeMicroLamports !== undefined) {
			return Math.min(this.maxFeeMicroLamports, result);
		}
		return result;
	}

	public getAvgStrategyResult(): number {
		const result = this.lastAvgStrategyResult * this.getPriorityFeeMultiplier();
		if (this.maxFeeMicroLamports !== undefined) {
			return Math.min(this.maxFeeMicroLamports, result);
		}
		return result;
	}

	public getMaxStrategyResult(): number {
		const result = this.lastMaxStrategyResult * this.getPriorityFeeMultiplier();
		if (this.maxFeeMicroLamports !== undefined) {
			return Math.min(this.maxFeeMicroLamports, result);
		}
		return result;
	}

	public async load(): Promise<void> {
		try {
			if (this.priorityFeeMethod === PriorityFeeMethod.SOLANA) {
				await this.loadForSolana();
			} else if (this.priorityFeeMethod === PriorityFeeMethod.HELIUS) {
				await this.loadForHelius();
			} else if (this.priorityFeeMethod === PriorityFeeMethod.DRIFT) {
				await this.loadForDrift();
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

	public updateMarketTypeAndIndex(driftMarkets: DriftMarketInfo[]) {
		this.driftMarkets = driftMarkets;
	}
}
