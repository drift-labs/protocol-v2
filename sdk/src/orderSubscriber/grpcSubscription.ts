import { Context, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { grpcProgramAccountSubscriber } from '../accounts/grpcProgramAccountSubscriber';
import { OrderSubscriber } from './OrderSubscriber';
import { GrpcConfigs, ResubOpts } from '../accounts/types';
import { UserAccount } from '../types';
import { getUserFilter, getNonIdleUserFilter } from '../memcmp';

export class grpcSubscription {
	private orderSubscriber: OrderSubscriber;
	private skipInitialLoad: boolean;
	private resubOpts?: ResubOpts;
	private resyncIntervalMs?: number;

	private subscriber?: grpcProgramAccountSubscriber<UserAccount>;
	private resyncTimeoutId?: NodeJS.Timeout;

	private decoded?: boolean;

	private grpcConfigs: GrpcConfigs;

	constructor({
		grpcConfigs,
		orderSubscriber,
		skipInitialLoad = false,
		resubOpts,
		resyncIntervalMs,
		decoded = true,
	}: {
		grpcConfigs: GrpcConfigs;
		orderSubscriber: OrderSubscriber;
		skipInitialLoad?: boolean;
		resubOpts?: ResubOpts;
		resyncIntervalMs?: number;
		decoded?: boolean;
	}) {
		this.orderSubscriber = orderSubscriber;
		this.skipInitialLoad = skipInitialLoad;
		this.resubOpts = resubOpts;
		this.resyncIntervalMs = resyncIntervalMs;
		this.decoded = decoded;
		this.grpcConfigs = grpcConfigs;
	}

	public async subscribe(): Promise<void> {
		if (this.subscriber) {
			return;
		}

		this.subscriber = new grpcProgramAccountSubscriber<UserAccount>(
			this.grpcConfigs,
			'OrderSubscriber',
			'User',
			this.orderSubscriber.driftClient.program,
			this.orderSubscriber.decodeFn,
			{
				filters: [getUserFilter(), getNonIdleUserFilter()],
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
