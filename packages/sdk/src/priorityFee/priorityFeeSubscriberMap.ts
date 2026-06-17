import {
	VelocityMarketInfo,
	VelocityPriorityFeeLevels,
	VelocityPriorityFeeResponse,
	fetchVelocityPriorityFee,
} from './velocityPriorityFeeMethod';
import {
	DEFAULT_PRIORITY_FEE_MAP_FREQUENCY_MS,
	PriorityFeeSubscriberMapConfig,
} from './types';

/**
 * takes advantage of /batchPriorityFees endpoint from Velocity hosted priority fee service
 */
export class PriorityFeeSubscriberMap {
	frequencyMs: number;
	intervalId?: ReturnType<typeof setTimeout>;

	velocityMarkets?: VelocityMarketInfo[];
	velocityPriorityFeeEndpoint: string;
	feesMap: Map<string, Map<number, VelocityPriorityFeeLevels>>; // marketType -> marketIndex -> priority fee

	public constructor(config: PriorityFeeSubscriberMapConfig) {
		this.frequencyMs =
			config.frequencyMs ?? DEFAULT_PRIORITY_FEE_MAP_FREQUENCY_MS;
		// Type-system guarantees at least one of the two is supplied.
		this.velocityPriorityFeeEndpoint = (config.velocityPriorityFeeEndpoint ??
			config.velocityPriorityFeeEndpoint)!;
		this.velocityMarkets = config.velocityMarkets;
		this.feesMap = new Map<string, Map<number, VelocityPriorityFeeLevels>>();
		this.feesMap.set('perp', new Map<number, VelocityPriorityFeeLevels>());
		this.feesMap.set('spot', new Map<number, VelocityPriorityFeeLevels>());
	}

	private updateFeesMap(
		velocityPriorityFeeResponse: VelocityPriorityFeeResponse
	) {
		velocityPriorityFeeResponse.forEach((fee: VelocityPriorityFeeLevels) => {
			this.feesMap.get(fee.marketType)!.set(fee.marketIndex, fee);
		});
	}

	public async subscribe(): Promise<void> {
		if (this.intervalId) {
			return;
		}

		await this.load();
		this.intervalId = setInterval(this.load.bind(this), this.frequencyMs);
	}

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}

	public async load(): Promise<void> {
		try {
			if (!this.velocityMarkets) {
				return;
			}
			const fees = await fetchVelocityPriorityFee(
				this.velocityPriorityFeeEndpoint,
				this.velocityMarkets.map((m) => m.marketType),
				this.velocityMarkets.map((m) => m.marketIndex)
			);
			this.updateFeesMap(fees);
		} catch (e) {
			console.error('Error fetching priority fees', e);
		}
	}

	public updateMarketTypeAndIndex(velocityMarkets: VelocityMarketInfo[]) {
		this.velocityMarkets = velocityMarkets;
	}

	public getPriorityFees(
		marketType: string,
		marketIndex: number
	): VelocityPriorityFeeLevels | undefined {
		return this.feesMap.get(marketType)?.get(marketIndex);
	}
}

/** Example usage:
async function main() {
    const velocityMarkets: VelocityMarketInfo[] = [
        { marketType: 'perp', marketIndex: 0 },
        { marketType: 'perp', marketIndex: 1 },
        { marketType: 'spot', marketIndex: 2 }
    ];

    const subscriber = new PriorityFeeSubscriberMap({
        velocityPriorityFeeEndpoint: 'https://dlob.velocity.trade',
        frequencyMs: 5000,
        velocityMarkets
    });
    await subscriber.subscribe();

    for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        velocityMarkets.forEach(market => {
            const fees = subscriber.getPriorityFees(market.marketType, market.marketIndex);
            console.log(`Priority fees for ${market.marketType} market ${market.marketIndex}:`, fees);
        });
    }


    await subscriber.unsubscribe();
}

main().catch(console.error);
*/
