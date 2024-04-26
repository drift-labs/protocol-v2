import { OrderSubscriber } from './OrderSubscriber';
import { getNonIdleUserFilter, getUserFilter } from '../memcmp';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';
import { UserAccount } from '../types';
import { Commitment, Context, PublicKey } from '@solana/web3.js';
import { ResubOpts } from '../accounts/types';

export class WebsocketSubscription {
	private orderSubscriber: OrderSubscriber;
	private commitment: Commitment;
	private skipInitialLoad: boolean;
	private resubOpts?: ResubOpts;
	private resyncIntervalMs?: number;

	private subscriber?: WebSocketProgramAccountSubscriber<UserAccount>;
	private resyncTimeoutId?: NodeJS.Timeout;

	private decoded?: boolean;

	constructor({
		orderSubscriber,
		commitment,
		skipInitialLoad = false,
		resubOpts,
		resyncIntervalMs,
		decoded = true,
	}: {
		orderSubscriber: OrderSubscriber;
		commitment: Commitment;
		skipInitialLoad?: boolean;
		resubOpts?: ResubOpts;
		resyncIntervalMs?: number;
		decoded?: boolean;
	}) {
		this.orderSubscriber = orderSubscriber;
		this.commitment = commitment;
		this.skipInitialLoad = skipInitialLoad;
		this.resubOpts = resubOpts;
		this.resyncIntervalMs = resyncIntervalMs;
		this.decoded = decoded;
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
			this.resubOpts
		);

		await this.subscriber.subscribe(
			(
				accountId: PublicKey,
				account: UserAccount,
				context: Context,
				buffer: Buffer
			) => {
				const userKey = accountId.toBase58();
				if (this.decoded ?? true) {
					this.orderSubscriber.tryUpdateUserAccount(
						userKey,
						'decoded',
						account,
						context.slot
					);
				} else {
					this.orderSubscriber.tryUpdateUserAccount(
						userKey,
						'buffer',
						buffer,
						context.slot
					);
				}
			}
		);

		if (!this.skipInitialLoad) {
			await this.orderSubscriber.fetch();
		}

		if (this.resyncIntervalMs) {
			const recursiveResync = () => {
				this.resyncTimeoutId = setTimeout(() => {
					this.orderSubscriber
						.fetch()
						.catch((e) => {
							console.error('Failed to resync in OrderSubscriber');
							console.log(e);
						})
						.finally(() => {
							// eslint-disable-next-line @typescript-eslint/no-unused-vars
							if (!this.resyncTimeoutId) return;
							recursiveResync();
						});
				}, this.resyncIntervalMs);
			};
			recursiveResync();
		}
	}

	public async unsubscribe(): Promise<void> {
		if (!this.subscriber) return;
		await this.subscriber.unsubscribe();
		this.subscriber = undefined;
		if (this.resyncTimeoutId !== undefined) {
			clearTimeout(this.resyncTimeoutId);
			this.resyncTimeoutId = undefined;
		}
	}
}
