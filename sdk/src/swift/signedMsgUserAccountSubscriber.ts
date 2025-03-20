import { getSignedMsgUserOrdersFilter } from '../memcmp';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';
import { SignedMsgOrderId, SignedMsgUserOrdersAccount } from '../types';
import { Commitment, Context, PublicKey } from '@solana/web3.js';
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

	newSignedMsgOrderIds: (
		newSignedMsgOrderIds: SignedMsgOrderId[],
		authorityPubkey: PublicKey,
		slot: number
	) => void;
}

export class SignedMsgUserOrdersAccountSubscriber {
	protected driftClient: DriftClient;
	protected commitment: Commitment;
	protected resubOpts?: ResubOpts;
	protected resyncTimeoutId?: NodeJS.Timeout;
	protected resyncIntervalMs?: number;
	protected decodeFn: (
		name: string,
		data: Buffer
	) => SignedMsgUserOrdersAccount;
	protected signedMsgUserOrderAccounts = new Map<
		string,
		{ slot: number; signedMsgUserOrdersAccount: SignedMsgUserOrdersAccount }
	>();
	mostRecentSlot: number;

	fetchPromise?: Promise<void>;
	fetchPromiseResolver: () => void;

	protected subscriber: WebSocketProgramAccountSubscriber<SignedMsgUserOrdersAccount>;
	public eventEmitter: StrictEventEmitter<
		EventEmitter,
		SignedMsgUserOrdersAccountSubscriberEvents
	>;

	constructor({
		driftClient,
		commitment,
		resubOpts,
		decodeFn,
		resyncIntervalMs,
	}: {
		driftClient: DriftClient;
		commitment: Commitment;
		resubOpts?: ResubOpts;
		decodeFn: (name: string, data: Buffer) => SignedMsgUserOrdersAccount;
		resyncIntervalMs?: number;
	}) {
		this.commitment = commitment;
		this.resubOpts = resubOpts;
		this.decodeFn = decodeFn;
		this.driftClient = driftClient;
		this.resyncIntervalMs = resyncIntervalMs;
		this.eventEmitter = new EventEmitter();
		this.resubOpts = resubOpts;
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
				this.tryUpdateSignedMsgUserOrdersAccount(
					account,
					'decoded',
					context.slot
				);
			}
		);

		await this.fetch();

		if (this.resyncIntervalMs) {
			const recursiveResync = () => {
				this.resyncTimeoutId = setTimeout(() => {
					this.fetch()
						.catch((e) => {
							console.error('Failed to resync in OrderSubscriber');
							console.log(e);
						})
						.finally(() => {
							if (!this.resyncTimeoutId) return;
							recursiveResync();
						});
				}, this.resyncIntervalMs);
			};
			recursiveResync();
		}
	}

	async fetch(): Promise<void> {
		if (this.fetchPromise) {
			return this.fetchPromise;
		}

		this.fetchPromise = new Promise((resolver) => {
			this.fetchPromiseResolver = resolver;
		});

		const skipEventEmitting = this.signedMsgUserOrderAccounts.size === 0;

		try {
			const rpcResponseAndContext =
				await this.driftClient.connection.getProgramAccounts(
					this.driftClient.program.programId,
					{
						commitment: this.commitment,
						filters: [getSignedMsgUserOrdersFilter()],
						encoding: 'base64',
						withContext: true,
					}
				);

			const slot: number = rpcResponseAndContext.context.slot;

			for (const programAccount of rpcResponseAndContext.value) {
				this.tryUpdateSignedMsgUserOrdersAccount(
					programAccount.account.data,
					'buffer',
					slot,
					skipEventEmitting
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		} catch (e) {
			console.error(e);
		} finally {
			this.fetchPromiseResolver();
			this.fetchPromise = undefined;
		}
	}

	tryUpdateSignedMsgUserOrdersAccount(
		data: Buffer | SignedMsgUserOrdersAccount,
		dataType: 'buffer' | 'decoded',
		slot: number,
		skipEventEmitting = false
	): void {
		if (!this.mostRecentSlot || slot > this.mostRecentSlot) {
			this.mostRecentSlot = slot;
		}

		const signedMsgUserOrdersAccount =
			dataType === 'buffer'
				? this.decodeFn('SignedMsgUserOrders', data as Buffer)
				: (data as SignedMsgUserOrdersAccount);

		const key = signedMsgUserOrdersAccount.authorityPubkey.toBase58();

		const slotAndSignedMsgUserOrdersAccount =
			this.signedMsgUserOrderAccounts.get(key);
		if (
			!slotAndSignedMsgUserOrdersAccount ||
			slotAndSignedMsgUserOrdersAccount.slot <= slot
		) {
			if (!skipEventEmitting) {
				this.eventEmitter.emit(
					'onAccountUpdate',
					signedMsgUserOrdersAccount.signedMsgOrderData.filter(
						(signedMsgOrderId) => signedMsgOrderId.orderId !== 0
					),
					signedMsgUserOrdersAccount.authorityPubkey,
					slot
				);
			}

			const existingSignedMsgOrderIds =
				slotAndSignedMsgUserOrdersAccount?.signedMsgUserOrdersAccount.signedMsgOrderData.map(
					(signedMsgOrderId) => signedMsgOrderId.orderId
				) ?? [];

			const newSignedMsgOrderIds =
				signedMsgUserOrdersAccount.signedMsgOrderData.filter(
					(signedMsgOrderId: SignedMsgOrderId) =>
						!existingSignedMsgOrderIds.includes(signedMsgOrderId.orderId) &&
						signedMsgOrderId.orderId !== 0
				);
			if (newSignedMsgOrderIds.length > 0 && !skipEventEmitting) {
				this.eventEmitter.emit(
					'newSignedMsgOrderIds',
					newSignedMsgOrderIds,
					signedMsgUserOrdersAccount.authorityPubkey,
					slot
				);
			}

			this.signedMsgUserOrderAccounts.set(key, {
				slot,
				signedMsgUserOrdersAccount,
			});
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
