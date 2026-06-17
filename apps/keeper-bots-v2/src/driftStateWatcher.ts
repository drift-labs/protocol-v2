import {
	decodeName,
	DriftClient,
	getVariant,
	PerpMarketAccount,
	SpotMarketAccount,
	StateAccount,
} from '@drift-labs/sdk';

export type StateChecks = {
	/// set true to check for new perp markets
	newPerpMarkets: boolean;
	/// set true to check for new spot markets
	newSpotMarkets: boolean;
	/// set true to check for changes in perp market statuses
	perpMarketStatus: boolean;
	/// set true to check for changes in spot market statuses
	spotMarketStatus: boolean;
	/// optional callback for if any of the state checks fail
	onStateChange?: (message: string, changes: StateChecks) => void;
};

export type DriftStateWatcherConfig = {
	/// access drift program
	driftClient: DriftClient;
	/// interval to check for updates
	intervalMs: number;
	/// state checks to perform
	stateChecks: StateChecks;
};

/**
 * Watches for updates on the DriftClient
 */
export class DriftStateWatcher {
	private lastStateAccount?: StateAccount;
	private lastSpotMarketAccounts: Map<number, SpotMarketAccount> = new Map();
	private lastPerpMarketAccounts: Map<number, PerpMarketAccount> = new Map();
	private interval?: NodeJS.Timeout;

	private _lastTriggered: boolean;
	private _lastTriggeredStates: StateChecks;

	constructor(private config: DriftStateWatcherConfig) {
		this._lastTriggeredStates = {
			newPerpMarkets: false,
			newSpotMarkets: false,
			perpMarketStatus: false,
			spotMarketStatus: false,
		};
		this._lastTriggered = false;
	}

	get triggered() {
		return this._lastTriggered;
	}

	get triggeredStates(): StateChecks {
		return this._lastTriggeredStates;
	}

	public subscribe() {
		if (!this.config.driftClient.isSubscribed) {
			throw new Error(
				'DriftClient must be subscribed before calling DriftStateWatcher.subscribe()'
			);
		}
		this.lastStateAccount = this.config.driftClient.getStateAccount();

		for (const perpMarket of this.config.driftClient.getPerpMarketAccounts()) {
			this.lastPerpMarketAccounts.set(perpMarket.marketIndex, perpMarket);
		}

		for (const spotMarket of this.config.driftClient.getSpotMarketAccounts()) {
			this.lastSpotMarketAccounts.set(spotMarket.marketIndex, spotMarket);
		}

		this.interval = setInterval(
			() => this.checkForUpdates(),
			this.config.intervalMs ?? 10_000
		);
	}

	public unsubscribe() {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
	}

	private checkForUpdates() {
		let newPerpMarkets = false;
		let newSpotMarkets = false;
		let perpMarketStatus = false;
		let spotMarketStatus = false;
		let message = '';

		const newStateAccount = this.config.driftClient.getStateAccount();
		if (this.config.stateChecks.newPerpMarkets) {
			if (
				newStateAccount.numberOfMarkets !==
				this.lastStateAccount!.numberOfMarkets
			) {
				newPerpMarkets = true;
				message += `Number of perp markets changed: ${
					this.lastStateAccount!.numberOfMarkets
				} -> ${newStateAccount.numberOfMarkets}\n`;
			}

			if (this.config.stateChecks.perpMarketStatus) {
				const perpMarkets = this.config.driftClient.getPerpMarketAccounts();
				for (const perpMarket of perpMarkets) {
					const symbol = decodeName(perpMarket.name);
					const lastPerpMarket = this.lastPerpMarketAccounts.get(
						perpMarket.marketIndex
					);
					if (!lastPerpMarket) {
						newPerpMarkets = true;
						message += `Found a new perp market: (marketIndex: ${perpMarket.marketIndex} ${symbol})\n`;
						break;
					}

					const newPerpStatus = getVariant(perpMarket.status);
					const lastPerpStatus = getVariant(lastPerpMarket.status);
					if (newPerpStatus !== lastPerpStatus) {
						perpMarketStatus = true;
						message += `Perp market status changed: (marketIndex: ${perpMarket.marketIndex} ${symbol}) ${lastPerpStatus} -> ${newPerpStatus}\n`;
						break;
					}

					const newPausedOps = perpMarket.pausedOperations;
					const lastPausedOps = lastPerpMarket.pausedOperations;
					if (newPausedOps !== lastPausedOps) {
						perpMarketStatus = true;
						message += `Perp market paused operations changed: (marketIndex: ${perpMarket.marketIndex} ${symbol}) ${lastPausedOps} -> ${newPausedOps}\n`;
						break;
					}

					const newPerpOracle = perpMarket.amm.oracle;
					const lastPerpOracle = lastPerpMarket.amm.oracle;
					if (!newPerpOracle.equals(lastPerpOracle)) {
						perpMarketStatus = true;
						message += `Perp oracle changed: (marketIndex: ${
							perpMarket.marketIndex
						} ${symbol}) ${lastPerpOracle.toBase58()} -> ${newPerpOracle.toBase58()}\n`;
						break;
					}
				}
			}
		}

		if (this.config.stateChecks.newSpotMarkets) {
			if (
				newStateAccount.numberOfSpotMarkets !==
				this.lastStateAccount!.numberOfSpotMarkets
			) {
				newSpotMarkets = true;
				message += `Number of spot markets changed: ${
					this.lastStateAccount!.numberOfSpotMarkets
				} -> ${newStateAccount.numberOfSpotMarkets}\n`;
			}

			if (this.config.stateChecks.spotMarketStatus) {
				const spotMarkets = this.config.driftClient.getSpotMarketAccounts();
				for (const spotMarket of spotMarkets) {
					const symbol = decodeName(spotMarket.name);
					const lastSpotMarket = this.lastSpotMarketAccounts.get(
						spotMarket.marketIndex
					);
					if (!lastSpotMarket) {
						newSpotMarkets = true;
						message += `Found a new spot market: (marketIndex: ${spotMarket.marketIndex} ${symbol})\n`;
						break;
					}

					const newSpotStatus = getVariant(spotMarket.status);
					const lastSpotStatus = getVariant(lastSpotMarket.status);
					if (newSpotStatus !== lastSpotStatus) {
						spotMarketStatus = true;
						message += `Spot market status changed: (marketIndex: ${spotMarket.marketIndex} ${symbol}) ${lastSpotStatus} -> ${newSpotStatus}\n`;
						break;
					}

					const newPausedOps = spotMarket.pausedOperations;
					const lastPausedOps = lastSpotMarket.pausedOperations;
					if (newPausedOps !== lastPausedOps) {
						spotMarketStatus = true;
						message += `Spot market paused operations changed: (marketIndex: ${spotMarket.marketIndex} ${symbol}) ${lastPausedOps} -> ${newPausedOps}\n`;
						break;
					}

					const newSpotOracle = spotMarket.oracle;
					const lastSpotOracle = lastSpotMarket.oracle;
					if (!newSpotOracle.equals(lastSpotOracle)) {
						spotMarketStatus = true;
						message += `Spot oracle changed: (marketIndex: ${
							spotMarket.marketIndex
						} ${symbol}) ${lastSpotOracle.toBase58()} -> ${newSpotOracle.toBase58()}\n`;
						break;
					}
				}
			}
		}

		this._lastTriggeredStates = {
			newPerpMarkets,
			newSpotMarkets,
			perpMarketStatus,
			spotMarketStatus,
		};
		if (
			newPerpMarkets ||
			newSpotMarkets ||
			perpMarketStatus ||
			spotMarketStatus
		) {
			this._lastTriggered = true;
			if (this.config.stateChecks.onStateChange) {
				this.config.stateChecks.onStateChange(message, {
					newPerpMarkets,
					newSpotMarkets,
					perpMarketStatus,
					spotMarketStatus,
				});
			}
		} else {
			this._lastTriggered = false;
		}
	}
}
