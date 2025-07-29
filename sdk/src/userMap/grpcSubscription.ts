import { getNonIdleUserFilter, getUserFilter } from '../memcmp';
import { WebSocketProgramAccountSubscriber } from '../accounts/programAccount/webSocketProgramAccountSubscriber';
import { UserAccount } from '../types';
import { Context, MemcmpFilter, PublicKey } from '@solana/web3.js';
import { GrpcConfigs, ResubOpts } from '../accounts/types';
import { grpcProgramAccountSubscriber } from '../accounts/programAccount/grpcProgramAccountSubscriber';
import { IUserMap } from './types';

export class grpcSubscription {
	private grpcConfigs: GrpcConfigs;
	private userMap: IUserMap;
	private skipInitialLoad: boolean;
	private resubOpts?: ResubOpts;
	private includeIdle?: boolean;
	private additionalFilters?: MemcmpFilter[];
	private decodeFn: (name: string, data: Buffer) => UserAccount;

	private subscriber: WebSocketProgramAccountSubscriber<UserAccount>;

	constructor({
		grpcConfigs,
		userMap,
		skipInitialLoad = false,
		resubOpts,
		includeIdle = false,
		decodeFn,
		additionalFilters = undefined,
	}: {
		grpcConfigs: GrpcConfigs;
		userMap: IUserMap;
		skipInitialLoad?: boolean;
		resubOpts?: ResubOpts;
		includeIdle?: boolean;
		decodeFn: (name: string, data: Buffer) => UserAccount;
		additionalFilters?: MemcmpFilter[];
	}) {
		this.userMap = userMap;
		this.skipInitialLoad = skipInitialLoad;
		this.resubOpts = resubOpts;
		this.includeIdle = includeIdle || false;
		this.decodeFn = decodeFn;
		this.grpcConfigs = grpcConfigs;
		this.additionalFilters = additionalFilters;
	}

	public async subscribe(): Promise<void> {
		if (!this.subscriber) {
			const filters = [getUserFilter()];
			if (!this.includeIdle) {
				filters.push(getNonIdleUserFilter());
			}
			if (this.additionalFilters) {
				filters.push(...this.additionalFilters);
			}
			this.subscriber = await grpcProgramAccountSubscriber.create<UserAccount>(
				this.grpcConfigs,
				'UserMap',
				'User',
				this.userMap.driftClient.program,
				this.decodeFn,
				{
					filters,
				},
				this.resubOpts
			);
		}

		await this.subscriber.subscribe(
			(accountId: PublicKey, account: UserAccount, context: Context) => {
				const userKey = accountId.toBase58();
				this.userMap.updateUserAccount(userKey, account, context.slot);
			}
		);

		if (!this.skipInitialLoad) {
			await this.userMap.sync();
		}
	}

	public async unsubscribe(): Promise<void> {
		if (!this.subscriber) return;
		await this.subscriber.unsubscribe();
		this.subscriber = undefined;
	}
}
