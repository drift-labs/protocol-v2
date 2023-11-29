import { OrderSubscriber } from './OrderSubscriber';
import { getNonIdleUserFilter, getUserFilter } from '../memcmp';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';
import { UserAccount } from '../types';
import { Context, PublicKey } from '@solana/web3.js';

export class WebsocketSubscription {
	private orderSubscriber: OrderSubscriber;
	private skipInitialLoad: boolean;
	private resubTimeoutMs?: number;
	private useWhirligig?: boolean;

	private subscriber: WebSocketProgramAccountSubscriber<UserAccount>;

	constructor({
		orderSubscriber,
		skipInitialLoad = false,
		resubTimeoutMs,
		useWhirligig = false,
	}: {
		orderSubscriber: OrderSubscriber;
		skipInitialLoad?: boolean;
		resubTimeoutMs?: number;
		useWhirligig?: boolean;
	}) {
		this.orderSubscriber = orderSubscriber;
		this.skipInitialLoad = skipInitialLoad;
		this.resubTimeoutMs = resubTimeoutMs;
		this.useWhirligig = useWhirligig;
	}

	public async subscribe(): Promise<void> {
		if (!this.subscriber) {
			this.subscriber = new WebSocketProgramAccountSubscriber<UserAccount>(
				'OrderSubscriber',
				'User',
				this.orderSubscriber.driftClient.program,
				this.orderSubscriber.driftClient.program.account.user.coder.accounts.decode.bind(
					this.orderSubscriber.driftClient.program.account.user.coder.accounts
				),
				{
					filters: [getUserFilter(), getNonIdleUserFilter()],
					commitment: this.orderSubscriber.driftClient.opts.commitment,
				},
				this.resubTimeoutMs,
				this.useWhirligig
			);
		}

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
		this.subscriber.unsubscribe();
	}
}
