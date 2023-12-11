import { UserMap } from './userMap';

export class PollingSubscription {
	private userMap: UserMap;
	private frequency: number;
	private skipInitialLoad: boolean;

	intervalId?: ReturnType<typeof setTimeout>;

	constructor({
		userMap,
		frequency,
		skipInitialLoad = false,
	}: {
		userMap: UserMap;
		frequency: number;
		skipInitialLoad?: boolean;
		includeIdle?: boolean;
	}) {
		this.userMap = userMap;
		this.frequency = frequency;
		this.skipInitialLoad = skipInitialLoad;
	}

	public async subscribe(): Promise<void> {
		if (this.intervalId) {
			return;
		}

		if (this.frequency > 0) {
			this.intervalId = setInterval(
				this.userMap.sync.bind(this.userMap),
				this.frequency
			);
		}

		if (!this.skipInitialLoad) {
			await this.userMap.sync();
		}
	}

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
