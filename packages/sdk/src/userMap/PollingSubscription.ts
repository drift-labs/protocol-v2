import { UserMap } from './userMap';

/**
 * `UserMap`'s `'polling'` subscription strategy: re-runs a full `userMap.sync()`
 * on a fixed `setTimeout` interval (self-rescheduling, so syncs never overlap).
 * Internal to `UserMap` — not part of the SDK's public exports.
 */
export class PollingSubscription {
	private userMap: UserMap;
	private frequency: number;
	private skipInitialLoad: boolean;

	intervalId?: ReturnType<typeof setTimeout>;
	private active = false;

	constructor({
		userMap,
		frequency,
		skipInitialLoad = false,
	}: {
		userMap: UserMap;
		/** Milliseconds to wait after one sync completes before starting the next. */
		frequency: number;
		/** If true, does not sync immediately on `subscribe()` — the first sync happens after `frequency` ms. */
		skipInitialLoad?: boolean;
		includeIdle?: boolean;
	}) {
		this.userMap = userMap;
		this.frequency = frequency;
		this.skipInitialLoad = skipInitialLoad;
	}

	/** Starts the polling loop. No-op if already started or `frequency <= 0`. */
	public async subscribe(): Promise<void> {
		if (this.active || this.frequency <= 0) {
			return;
		}
		this.active = true;

		const executeSync = async () => {
			await this.userMap.sync();
			if (this.active) {
				this.intervalId = setTimeout(executeSync, this.frequency);
			}
		};

		if (!this.skipInitialLoad) {
			await this.userMap.sync();
		}
		executeSync();
	}

	/** Stops the polling loop. */
	public async unsubscribe(): Promise<void> {
		this.active = false;
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
