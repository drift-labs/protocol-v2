import {
	PollingDriftClientAccountSubscriber
} from './pollingDriftClientAccountSubscriber';

import {
	OraclePriceData,
	OracleInfo
} from '../oracles/types';

import { getOracleId } from '../oracles/oracleId';


// allowing app UI state to incrementally replace RPC fetched acconut data with data from our infra that is pre-indexed and decoded
export class ExternalDataDriftClientSubscriber extends PollingDriftClientAccountSubscriber {
	private oracleLastUpdate = new Map<string, number>();
	private pollingOracles = new Map<string, boolean>();
	private oraclePollIntervalId: NodeJS.Timeout;

	constructor(...args: ConstructorParameters<typeof PollingDriftClientAccountSubscriber>) {
		super(...args);
		
	}

	/** Override to prevent oracles from being automatically polled later */
	public override updateOraclesToPoll(): boolean {
		return true;
	}

	/** Public method to be called externally with fresh oracle data */
	public feedOracle(oracleInfo: OracleInfo, priceData: OraclePriceData, slot: number) {
		const oracleId = getOracleId(oracleInfo.publicKey, oracleInfo.source);
		this.oracles.set(oracleId, { data: priceData, slot });
		this.oracleLastUpdate.set(oracleId, Date.now());
		if (this.pollingOracles.has(oracleId) || this.accountLoader.accountsToLoad.has(oracleInfo.publicKey.toBase58())) {
			const oracleToPoll = this.oraclesToPoll.get(oracleId);
			if (oracleToPoll) {
				this.accountLoader.removeAccount(
					oracleToPoll.publicKey,
					oracleToPoll.callbackId
				);
				this.pollingOracles.delete(oracleId);
			}
		}
	}

	public override async subscribe(): Promise<boolean> {
		await super.subscribe();
		this.startOraclePollingWatchdog();
		return true;
	}

	private startOraclePollingWatchdog() {
		if(this.oraclePollIntervalId) {
			clearInterval(this.oraclePollIntervalId);
		}
		// how do we handle not polling bet markets every 1s from this change?
		this.oraclePollIntervalId = setInterval(async () => {
			for (const [oracleId, lastUpdate] of this.oracleLastUpdate.entries()) {
				const oracleToPoll = this.oraclesToPoll.get(oracleId);
				if(!oracleToPoll) continue;
				const now = Date.now();
				if (now - lastUpdate > 130_000 && !this.pollingOracles.has(oracleId)) {
					await this.addOracleToAccountLoader(oracleToPoll);
					this.pollingOracles.set(oracleId, true);
				}
			}
		}, 60_000);
	}

	public override async unsubscribe(): Promise<void> {
		clearInterval(this.oraclePollIntervalId);
		await super.unsubscribe();
		this.oracleLastUpdate.clear();
		this.pollingOracles.clear();
	}
}
