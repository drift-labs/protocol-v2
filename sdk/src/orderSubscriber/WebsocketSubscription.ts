import { OrderSubscriber } from './OrderSubscriber';
import { getNonIdleUserFilter, getUserFilter } from '../memcmp';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';
import { UserAccount } from '../types';
import { Commitment, Context, PublicKey } from '@solana/web3.js';

export class WebsocketSubscription {
	private orderSubscriber: OrderSubscriber;
	private commitment: Commitment;
	private skipInitialLoad: boolean;
	private resubTimeoutMs?: number;

	private subscriber?: WebSocketProgramAccountSubscriber<UserAccount>;

	constructor({
		orderSubscriber,
		commitment,
		skipInitialLoad = false,
		resubTimeoutMs,
	}: {
		orderSubscriber: OrderSubscriber;
		commitment: Commitment;
		skipInitialLoad?: boolean;
		resubTimeoutMs?: number;
	}) {
		this.orderSubscriber = orderSubscriber;
		this.commitment = commitment;
		this.skipInitialLoad = skipInitialLoad;
		this.resubTimeoutMs = resubTimeoutMs;
	}

	public async subscribe(): Promise<void> {
		if (this.subscriber) {
			return;
		}

		this.subscriber = new WebSocketProgramAccountSubscriber<UserAccount>(
			'OrderSubscriber',
			'User',
			this.orderSubscriber.driftClient.program,
			this.orderSubscriber.decodeFn,
			{
				filters: [getUserFilter(), getNonIdleUserFilter()],
				commitment: this.commitment,
			},
			this.resubTimeoutMs
		);

		await this.subscriber.subscribe(
			(accountId: PublicKey, account: UserAccount, context: Context) => {
				const userKey = accountId.toBase58();
				this.orderSubscriber.tryUpdateUserAccount(
					userKey,
					'decoded',
					account,
					context.slot
				);
			}
		);

		if (!this.skipInitialLoad) {
			await this.orderSubscriber.fetch();
		}
	}

	public async unsubscribe(): Promise<void> {
		if (!this.subscriber) return;
		await this.subscriber.unsubscribe();
		this.subscriber = undefined;
	}
}
