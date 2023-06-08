import { AuctionSubscriberConfig, AuctionSubscriberEvents } from './types';
import { DriftClient } from '../driftClient';
import { getUserFilter, getUserWithAuctionFilter } from '../memcmp';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { UserAccount } from '../types';
import { ConfirmOptions } from '@solana/web3.js';

export class AuctionSubscriber {
	private driftClient: DriftClient;
	private opts: ConfirmOptions;

	eventEmitter: StrictEventEmitter<EventEmitter, AuctionSubscriberEvents>;

	private websocketId: number;

	constructor({ driftClient, opts }: AuctionSubscriberConfig) {
		this.driftClient = driftClient;
		this.opts = opts || this.driftClient.opts;
		this.eventEmitter = new EventEmitter();
	}

	public async subscribe() {
		this.websocketId = this.driftClient.connection.onProgramAccountChange(
			this.driftClient.program.programId,
			(keyAccountInfo, context) => {
				const userAccount =
					this.driftClient.program.account.user.coder.accounts.decode(
						'User',
						keyAccountInfo.accountInfo.data
					) as UserAccount;
				this.eventEmitter.emit(
					'onAccountUpdate',
					userAccount,
					keyAccountInfo.accountId,
					context.slot
				);
			},
			this.driftClient.opts.commitment,
			[getUserFilter(), getUserWithAuctionFilter()]
		);
	}

	public async unsubscribe() {
		if (this.websocketId) {
			await this.driftClient.connection.removeProgramAccountChangeListener(
				this.websocketId
			);
		}
	}
}
