import { AuctionSubscriberConfig, AuctionSubscriberEvents } from './types';
import { DriftClient } from '../driftClient';
import { getUserFilter, getUserWithAuctionFilter } from '../memcmp';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { UserAccount } from '../types';
import { ConfirmOptions, Context, PublicKey } from '@solana/web3.js';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';

export class AuctionSubscriber {
	private driftClient: DriftClient;
	private opts: ConfirmOptions;
	private resubTimeoutMs?: number;

	eventEmitter: StrictEventEmitter<EventEmitter, AuctionSubscriberEvents>;
	private subscriber: WebSocketProgramAccountSubscriber<UserAccount>;

	constructor({ driftClient, opts, resubTimeoutMs }: AuctionSubscriberConfig) {
		this.driftClient = driftClient;
		this.opts = opts || this.driftClient.opts;
		this.eventEmitter = new EventEmitter();
		this.resubTimeoutMs = resubTimeoutMs;
	}

	public async subscribe() {
		if (!this.subscriber) {
			this.subscriber = new WebSocketProgramAccountSubscriber<UserAccount>(
				'AuctionSubscriber',
				'User',
				this.driftClient.program,
				this.driftClient.program.account.user.coder.accounts.decode.bind(
					this.driftClient.program.account.user.coder.accounts
				),
				{
					filters: [getUserFilter(), getUserWithAuctionFilter()],
					commitment: this.opts.commitment,
				},
				this.resubTimeoutMs
			);
		}

		await this.subscriber.subscribe(
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
