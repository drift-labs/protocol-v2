import { IUserMap } from './types';

export class PollingSubscription {
	private userMap: IUserMap;
	private frequency: number;
	private skipInitialLoad: boolean;

	intervalId?: ReturnType<typeof setTimeout>;

	constructor({
		userMap,
		frequency,
		skipInitialLoad = false,
	}: {
		userMap: IUserMap;
		frequency: number;
		skipInitialLoad?: boolean;
		includeIdle?: boolean;
	}) {
		this.userMap = userMap;
		this.frequency = frequency;
		this.skipInitialLoad = skipInitialLoad;
	}

	public async subscribe(): Promise<void> {
		if (this.intervalId || this.frequency <= 0) {
			return;
		}

		const executeSync = async () => {
			await this.userMap.sync();
			this.intervalId = setTimeout(executeSync, this.frequency);
		};

		if (!this.skipInitialLoad) {
			await this.userMap.sync();
		}
		executeSync();
	}

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
