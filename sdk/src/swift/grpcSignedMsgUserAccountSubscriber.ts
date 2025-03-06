import { Commitment, Context, PublicKey } from '@solana/web3.js';
import { grpcProgramAccountSubscriber } from '../accounts/grpcProgramAccountSubscriber';
import { GrpcConfigs, ResubOpts } from '../accounts/types';
import { SignedMsgUserOrdersAccount } from '../types';
import { getSignedMsgUserOrdersFilter } from '../memcmp';
import { SignedMsgUserOrdersAccountSubscriber } from './signedMsgUserAccountSubscriber';
import { DriftClient } from '../driftClient';

export class grpcSignedMsgUserOrdersAccountSubscriber extends SignedMsgUserOrdersAccountSubscriber {
	private grpcConfigs: GrpcConfigs;
	override subscriber: grpcProgramAccountSubscriber<SignedMsgUserOrdersAccount>;

	constructor({
		grpcConfigs,
		driftClient,
		commitment,
		resubOpts,
		decodeFn,
		resyncIntervalMs,
	}: {
		grpcConfigs: GrpcConfigs;
		driftClient: DriftClient;
		commitment: Commitment;
		resubOpts?: ResubOpts;
		decodeFn: (name: string, data: Buffer) => SignedMsgUserOrdersAccount;
		resyncIntervalMs?: number;
	}) {
		super({
			driftClient,
			commitment,
			resubOpts,
			decodeFn,
			resyncIntervalMs,
		});
		this.grpcConfigs = grpcConfigs;
	}

	public async subscribe(): Promise<void> {
		if (!this.subscriber) {
			this.subscriber =
				await grpcProgramAccountSubscriber.create<SignedMsgUserOrdersAccount>(
					this.grpcConfigs,
					'OrderSubscriber',
					'User',
					this.driftClient.program,
					this.decodeFn,
					{
						filters: [getSignedMsgUserOrdersFilter()],
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
