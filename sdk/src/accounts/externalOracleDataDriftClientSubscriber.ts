import {
	PollingDriftClientAccountSubscriber
} from './pollingDriftClientAccountSubscriber';

import {
	OraclePriceData,
	OracleInfo
} from '../oracles/types';

import { getOracleId } from '../oracles/oracleId';

export class ExternalOracleDataDriftClientSubscriber extends PollingDriftClientAccountSubscriber {
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
		this.removeAllOraclesFromAccountLoader();
		this.startOraclePollingWatchdog();
		return true;
	}

	private startOraclePollingWatchdog() {
		// how do we handle not polling bet markets every 1s from this change?
		this.oraclePollIntervalId = setInterval(async () => {
			for (const [oracleId, oracleToPoll] of this.oraclesToPoll.entries()) {
				const lastUpdate = this.oracleLastUpdate.get(oracleId) || 0;
				const now = Date.now();
				if (now - lastUpdate > 70_000 && !this.pollingOracles.has(oracleId)) {
					await this.addOracleToAccountLoader(oracleToPoll);
					this.pollingOracles.set(oracleId, true);
				}
			}
		}, 60_000);
	}

	public removeAllOraclesFromAccountLoader() {
		for (const oracleInfo of this.oracleInfos) {
			const existingAccountToLoad = this.accountLoader.accountsToLoad.get(oracleInfo.publicKey.toString());
			if (existingAccountToLoad) {
				// console.log('ORACLEDATA remove from account loader', oracleInfo.publicKey.toBase58());
				for (const [callbackId] of existingAccountToLoad.callbacks) {
					this.accountLoader.removeAccount(oracleInfo.publicKey, callbackId);
				}
			}
		}
	}

	public override async unsubscribe(): Promise<void> {
		clearInterval(this.oraclePollIntervalId);
		await super.unsubscribe();
		this.oracleLastUpdate.clear();
		this.pollingOracles.clear();
	}
}