import { OrderSubscriber } from './OrderSubscriber';
import { getNonIdleUserFilter, getUserFilter } from '../memcmp';

export class WebsocketSubscription {
	private orderSubscriber: OrderSubscriber;
	private skipInitialLoad: boolean;

	private websocketId: number;

	constructor({
		orderSubscriber,
		skipInitialLoad = false,
	}: {
		orderSubscriber: OrderSubscriber;
		skipInitialLoad?: boolean;
	}) {
		this.orderSubscriber = orderSubscriber;
		this.skipInitialLoad = skipInitialLoad;
	}

	public async subscribe(): Promise<void> {
		if (this.websocketId) {
			return;
		}

		this.websocketId =
			this.orderSubscriber.driftClient.connection.onProgramAccountChange(
				this.orderSubscriber.driftClient.program.programId,
				(keyAccountInfo, context) => {
					const userKey = keyAccountInfo.accountId.toBase58();
					this.orderSubscriber.tryUpdateUserAccount(
						userKey,
						keyAccountInfo.accountInfo.data,
						context.slot
					);
				},
				this.orderSubscriber.driftClient.opts.commitment,
				[getUserFilter(), getNonIdleUserFilter()]
			);

		if (!this.skipInitialLoad) {
			await this.orderSubscriber.fetch();
		}
	}

	public async unsubscribe(): Promise<void> {
		if (this.websocketId) {
			await this.orderSubscriber.driftClient.connection.removeProgramAccountChangeListener(
				this.websocketId
			);
			this.websocketId = undefined;
		}
	}
}
