import { getSignedMsgUserOrdersFilter } from '../memcmp';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';
import { SignedMsgOrderId, SignedMsgUserOrdersAccount } from '../types';
import { Commitment, Context, MemcmpFilter, PublicKey } from '@solana/web3.js';
import { ResubOpts } from '../accounts/types';
import { DriftClient } from '../driftClient';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';

export interface SignedMsgUserOrdersAccountSubscriberEvents {
	onAccountUpdate: (
		activeSignedMsgOrderIds: SignedMsgOrderId[],
		authorityPubkey: PublicKey,
		slot: number
	) => void;
}

export class SignedMsgUserOrdersAccountSubscriber {
	private driftClient: DriftClient;
	private commitment: Commitment;
	private resubOpts?: ResubOpts;
	private decodeFn: (name: string, data: Buffer) => SignedMsgUserOrdersAccount;

	private subscriber: WebSocketProgramAccountSubscriber<SignedMsgUserOrdersAccount>;
	public eventEmitter: StrictEventEmitter<
		EventEmitter,
		SignedMsgUserOrdersAccountSubscriberEvents
	>;

	constructor({
		driftClient,
		commitment,
		resubOpts,
		decodeFn,
	}: {
		driftClient: DriftClient;
		commitment: Commitment;
		resubOpts?: ResubOpts;
		decodeFn: (name: string, data: Buffer) => SignedMsgUserOrdersAccount;
		additionalFilters?: MemcmpFilter[];
	}) {
		this.commitment = commitment;
		this.resubOpts = resubOpts;
		this.decodeFn = decodeFn;
		this.driftClient = driftClient;
		this.eventEmitter = new EventEmitter();
	}

	public async subscribe(): Promise<void> {
		if (!this.subscriber) {
			const filters = [getSignedMsgUserOrdersFilter()];
			this.subscriber =
				new WebSocketProgramAccountSubscriber<SignedMsgUserOrdersAccount>(
					'SingedMsgUserOrdersAccountMap',
					'SignedMsgUserOrders',
					this.driftClient.program,
					this.decodeFn,
					{
						filters,
						commitment: this.commitment,
					},
					this.resubOpts
				);
		}

		await this.subscriber.subscribe(
			(
				_accountId: PublicKey,
				account: SignedMsgUserOrdersAccount,
				context: Context
			) => {
				console.log(account.signedMsgOrderData);
				const authority = account.authorityPubkey;
				this.eventEmitter.emit(
					'onAccountUpdate',
					account.signedMsgOrderData.filter(
						(signedMsgOrderId) => signedMsgOrderId.orderId !== 0
					),
					authority,
					context.slot
				);
			}
		);
	}

	public async unsubscribe(): Promise<void> {
		if (!this.subscriber) return;
		await this.subscriber.unsubscribe();
		this.subscriber = undefined;
	}
}
