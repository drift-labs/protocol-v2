import { Context, PublicKey } from '@solana/web3.js';
import { grpcProgramAccountSubscriber } from '../accounts/grpcProgramAccountSubscriber';
import { GrpcConfigs } from '../accounts/types';
import { SignedMsgUserOrdersAccount } from '../types';
import { getSignedMsgUserOrdersFilter } from '../memcmp';
import {
	SignedMsgUserOrdersAccountSubscriber,
	SignedMsgUserOrdersAccountSubscriberConfig,
} from './signedMsgUserAccountSubscriber';

export class grpcSignedMsgUserOrdersAccountSubscriber extends SignedMsgUserOrdersAccountSubscriber {
	private grpcConfigs: GrpcConfigs;

	constructor({
		grpcConfigs,
		...rest
	}: SignedMsgUserOrdersAccountSubscriberConfig & {
		grpcConfigs: GrpcConfigs;
	}) {
		super(rest);
		this.grpcConfigs = grpcConfigs;
	}

	public async subscribe(): Promise<void> {
		if (!this._subscriber) {
			this._subscriber =
				await grpcProgramAccountSubscriber.create<SignedMsgUserOrdersAccount>(
					this.grpcConfigs,
					'SingedMsgUserOrdersAccountMap',
					'signedMsgUserOrders',
					this.velocityClient.program,
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
		if (!this._subscriber) return;
		await this._subscriber.unsubscribe();
		this._subscriber = undefined;
		if (this.resyncTimeoutId !== undefined) {
			clearTimeout(this.resyncTimeoutId);
			this.resyncTimeoutId = undefined;
		}
	}
}
