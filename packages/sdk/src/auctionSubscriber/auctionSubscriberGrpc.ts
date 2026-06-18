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

export class AuctionSubscriberGrpc {
	private velocityClient: VelocityClient;
	private opts: ConfirmOptions;
	private resubOpts?: ResubOpts;
	private grpcConfigs?: GrpcConfigs;

	eventEmitter: StrictEventEmitter<EventEmitter, AuctionSubscriberEvents>;
	private subscriber?: WebSocketProgramAccountSubscriber<UserAccount>;

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

	public async unsubscribe() {
		if (!this.subscriber) {
			return;
		}
		this.subscriber.unsubscribe();
	}
}
