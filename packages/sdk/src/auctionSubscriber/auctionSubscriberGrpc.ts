import { AuctionSubscriberConfig, AuctionSubscriberEvents } from './types';
import { VelocityClient } from '../velocityClient';
import { getUserFilter, getUserWithAuctionFilter } from '../memcmp';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { UserAccount } from '../types';
import { ConfirmOptions, Context, PublicKey } from '@solana/web3.js';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';
import { GrpcConfigs, ResubOpts } from '../accounts/types';
import { grpcProgramAccountSubscriber } from '../accounts/grpcProgramAccountSubscriber';

/**
 * Same as `AuctionSubscriber` (auction-eligible `User` accounts via
 * `getUserWithAuctionFilter`) but sourced from a gRPC/Geyser stream
 * (`grpcProgramAccountSubscriber`) instead of a websocket program-account
 * subscription. Requires `grpcConfigs`.
 */
export class AuctionSubscriberGrpc {
	private velocityClient: VelocityClient;
	private opts: ConfirmOptions;
	private resubOpts?: ResubOpts;
	private grpcConfigs?: GrpcConfigs;

	eventEmitter: StrictEventEmitter<EventEmitter, AuctionSubscriberEvents>;
	private subscriber?: WebSocketProgramAccountSubscriber<UserAccount>;

	/**
	 * @param velocityClient Client whose `program` backs the subscription; also supplies default `opts` if `opts` is omitted.
	 * @param opts Confirm options (commitment) for the subscription; defaults to `velocityClient.opts`.
	 * @param grpcConfigs gRPC/Geyser endpoint config; required to call `subscribe()`.
	 * @param resubTimeoutMs Max time with no update before resubscribing.
	 * @param logResubMessages Whether to log resubscribe attempts.
	 */
	constructor({
		velocityClient,
		opts,
		grpcConfigs,
		resubTimeoutMs,
		logResubMessages,
	}: AuctionSubscriberConfig) {
		// Type-system guarantees at least one of the two is supplied.
		this.velocityClient = velocityClient!;
		this.opts = opts || this.velocityClient.opts || {};
		this.eventEmitter = new EventEmitter();
		this.resubOpts = { resubTimeoutMs, logResubMessages };
		this.grpcConfigs = grpcConfigs;
	}

	/**
	 * Establishes the filtered gRPC subscription (idempotent) and emits
	 * `onAccountUpdate` for each matching account update.
	 * @throws If `grpcConfigs` was not provided at construction.
	 */
	public async subscribe() {
		let subscriber = this.subscriber;
		if (!subscriber) {
			if (!this.grpcConfigs) {
				throw new Error(
					'grpcConfigs must be provided to use AuctionSubscriberGrpc'
				);
			}
			subscriber = await grpcProgramAccountSubscriber.create<UserAccount>(
				this.grpcConfigs,
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
