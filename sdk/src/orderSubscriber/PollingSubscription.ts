import { OrderSubscriber } from './OrderSubscriber';

export class PollingSubscription {
	private orderSubscriber: OrderSubscriber;
	private frequency: number;

	intervalId?: ReturnType<typeof setTimeout>;

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

	public async unsubscribe(): Promise<void> {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
