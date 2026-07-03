import { AuctionSubscriberConfig, AuctionSubscriberEvents } from './types';
import { VelocityClient } from '../velocityClient';
import { getUserFilter, getUserWithAuctionFilter } from '../memcmp';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { UserAccount } from '../types';
import { ConfirmOptions, Context, PublicKey } from '@solana/web3.js';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';
import { ResubOpts } from '../accounts/types';

/**
 * AuctionSubscriber — websocket program-account subscription scoped to
 * `User` accounts that currently have at least one order in its auction
 * window (`getUserWithAuctionFilter`). Used by keepers/fillers to react to
 * auction-eligible orders (JIT-fillable or approaching the end of a Dutch
 * auction) without scanning every user account.
 */
export class AuctionSubscriber {
	private velocityClient: VelocityClient;
	private opts: ConfirmOptions;
	private resubOpts?: ResubOpts;

	eventEmitter: StrictEventEmitter<EventEmitter, AuctionSubscriberEvents>;
	private subscriber?: WebSocketProgramAccountSubscriber<UserAccount>;

	/**
	 * @param velocityClient Client whose `program`/`connection` back the subscription; also supplies default `opts` if `opts` is omitted.
	 * @param opts Confirm options (commitment) for the subscription; defaults to `velocityClient.opts`.
	 * @param resubTimeoutMs Max time with no update before resubscribing.
	 * @param logResubMessages Whether to log resubscribe attempts.
	 */
	constructor({
		velocityClient,
		opts,
		resubTimeoutMs,
		logResubMessages,
	}: AuctionSubscriberConfig) {
		// Type-system guarantees at least one of the two is supplied.
		this.velocityClient = velocityClient!;
		this.opts = opts || this.velocityClient.opts || {};
		this.eventEmitter = new EventEmitter();
		this.resubOpts = { resubTimeoutMs, logResubMessages };
	}

	/** Establishes the filtered program-account subscription (idempotent — reuses the existing subscriber if already created) and emits `onAccountUpdate` for each matching account update. */
	public async subscribe() {
		let subscriber = this.subscriber;
		if (!subscriber) {
			subscriber = new WebSocketProgramAccountSubscriber<UserAccount>(
				'AuctionSubscriber',
				'user',
				this.velocityClient.program,
				(
					this.velocityClient.program.account as any
				).user.coder.accounts.decode.bind(
					(this.velocityClient.program.account as any).user.coder.accounts
				),
				{
					filters: [getUserFilter(), getUserWithAuctionFilter()],
					commitment: this.opts.commitment,
				},
				this.resubOpts
			);
			this.subscriber = subscriber;
		}

		await subscriber.subscribe(
			(accountId: PublicKey, data: UserAccount, context: Context) => {
				this.eventEmitter.emit(
					'onAccountUpdate',
					data,
					accountId,
					context.slot
				);
			}
		);
	}

	/** Tears down the subscription. No-op if never subscribed. */
	public async unsubscribe() {
		if (!this.subscriber) {
			return;
		}
		this.subscriber.unsubscribe();
	}
}
