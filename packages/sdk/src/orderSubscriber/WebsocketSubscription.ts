import { OrderSubscriber } from './OrderSubscriber';
import { getNonIdleUserFilter, getUserFilter } from '../memcmp';
import { UserAccount } from '../types';
import { Commitment, Context, PublicKey } from '@solana/web3.js';
import { ResubOpts } from '../accounts/types';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';

/**
 * `OrderSubscriber` transport backed by a websocket `WebSocketProgramAccountSubscriber`
 * filtered to non-idle `User` accounts. On subscribe, optionally performs an
 * initial full `fetch()` snapshot (unless `skipInitialLoad`), then applies
 * live updates as they arrive; if `resyncIntervalMs` is set, also runs a
 * periodic full `fetch()` resync alongside the subscription to self-heal any
 * missed program-account notifications.
 */
export class WebsocketSubscription {
	private orderSubscriber: OrderSubscriber;
	private commitment: Commitment;
	private skipInitialLoad: boolean;
	private resubOpts?: ResubOpts;
	private resyncIntervalMs?: number;

	private subscriber?: WebSocketProgramAccountSubscriber<UserAccount>;
	private resyncTimeoutId?: ReturnType<typeof setTimeout>;

	private decoded?: boolean;

	/**
	 * @param orderSubscriber The `OrderSubscriber` to feed with updates.
	 * @param commitment Commitment level for the program-account subscription.
	 * @param skipInitialLoad Skip the initial full `fetch()` snapshot after subscribing; defaults to `false`.
	 * @param resubOpts Reconnect behavior for the underlying `WebSocketProgramAccountSubscriber`.
	 * @param resyncIntervalMs If set, runs a periodic full `fetch()` resync at this interval.
	 * @param decoded Whether updates are delivered already Anchor-decoded (`true`, default) or as raw buffers for `OrderSubscriber` to decode itself.
	 */
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

	/** Establishes the websocket program-account subscription (idempotent — no-op if already subscribed), optionally backfills with `fetch()`, and starts the resync timer if configured. */
	public async subscribe(): Promise<void> {
		if (this.subscriber) {
			return;
		}

		this.subscriber = new WebSocketProgramAccountSubscriber<UserAccount>(
			'OrderSubscriber',
			'user',
			this.orderSubscriber.velocityClient.program,
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

	/** Tears down the program-account subscription and cancels the resync timer, if any. No-op if not subscribed. */
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
