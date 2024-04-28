import { UserMap } from './userMap';
import { getNonIdleUserFilter, getUserFilter } from '../memcmp';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';
import { UserAccount } from '../types';
import { Commitment, Context, PublicKey } from '@solana/web3.js';
import { ResubOpts } from '../accounts/types';

export class WebsocketSubscription {
	private userMap: UserMap;
	private commitment: Commitment;
	private skipInitialLoad: boolean;
	private resubOpts?: ResubOpts;
	private includeIdle?: boolean;
	private decodeFn: (name: string, data: Buffer) => UserAccount;

	private subscriber: WebSocketProgramAccountSubscriber<UserAccount>;

	constructor({
		userMap,
		commitment,
		skipInitialLoad = false,
		resubOpts,
		includeIdle = false,
		decodeFn,
	}: {
		userMap: UserMap;
		commitment: Commitment;
		skipInitialLoad?: boolean;
		resubOpts?: ResubOpts;
		includeIdle?: boolean;
		decodeFn: (name: string, data: Buffer) => UserAccount;
	}) {
		this.userMap = userMap;
		this.commitment = commitment;
		this.skipInitialLoad = skipInitialLoad;
		this.resubOpts = resubOpts;
		this.includeIdle = includeIdle || false;
		this.decodeFn = decodeFn;
	}

	public async subscribe(): Promise<void> {
		if (!this.subscriber) {
			const filters = [getUserFilter()];
			if (!this.includeIdle) {
				filters.push(getNonIdleUserFilter());
			}
			this.subscriber = new WebSocketProgramAccountSubscriber<UserAccount>(
				'UserMap',
				'User',
				this.userMap.driftClient.program,
				this.decodeFn,
				{
					filters,
					commitment: this.commitment,
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
