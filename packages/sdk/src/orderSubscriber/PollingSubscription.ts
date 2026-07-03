import { OrderSubscriber } from './OrderSubscriber';

/**
 * `OrderSubscriber` transport that repeatedly calls `OrderSubscriber.fetch()`
 * (a full `getProgramAccounts` snapshot) on a fixed interval. Simplest and
 * most RPC-expensive transport; prefer websocket or grpc for large user sets.
 */
export class PollingSubscription {
	private orderSubscriber: OrderSubscriber;
	private frequency: number;

	intervalId?: ReturnType<typeof setTimeout>;

	/**
	 * @param orderSubscriber The `OrderSubscriber` to feed with each poll.
	 * @param frequency Poll interval in milliseconds.
	 */
	constructor({
		orderSubscriber,
		frequency,
	}: {
		orderSubscriber: OrderSubscriber;
		frequency: number;
	}) {
		this.orderSubscriber = orderSubscriber;
		this.frequency = frequency;
	}

	/** Starts the polling interval and performs one immediate `fetch()` before returning. Idempotent while already subscribed. */
	public async subscribe(): Promise<void> {
		if (this.intervalId) {
			return;
		}

		this.intervalId = setInterval(
			this.orderSubscriber.fetch.bind(this.orderSubscriber),
			this.frequency
		);

		await this.orderSubscriber.fetch();
	}

	/** Stops the polling interval. */
	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
