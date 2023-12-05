import { UserMap } from './userMap';
import { getNonIdleUserFilter, getUserFilter } from '../memcmp';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';
import { UserAccount } from '../types';
import { Commitment, Context, PublicKey } from '@solana/web3.js';

export class WebsocketSubscription {
	private userMap: UserMap;
	private commitment: Commitment;
	private skipInitialLoad: boolean;
	private resubTimeoutMs?: number;
	private includeIdle?: boolean;

	private subscriber: WebSocketProgramAccountSubscriber<UserAccount>;

	constructor({
		userMap,
		commitment,
		skipInitialLoad = false,
		resubTimeoutMs,
		includeIdle = false,
	}: {
		userMap: UserMap;
		commitment: Commitment;
		skipInitialLoad?: boolean;
		resubTimeoutMs?: number;
		includeIdle?: boolean;
	}) {
		this.userMap = userMap;
		this.commitment = commitment;
		this.skipInitialLoad = skipInitialLoad;
		this.resubTimeoutMs = resubTimeoutMs;
		this.includeIdle = includeIdle || false;
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
				this.userMap.driftClient.program.account.user.coder.accounts.decode.bind(
					this.userMap.driftClient.program.account.user.coder.accounts
				),
				{
					filters,
					commitment: this.commitment,
				},
				this.resubTimeoutMs
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
