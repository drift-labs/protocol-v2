import { UserMap } from './userMap';
import { getNonIdleUserFilter, getUserFilter } from '../memcmp';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';
import { UserAccount } from '../types';
import { Commitment, Context, MemcmpFilter, PublicKey } from '@solana/web3.js';
import { ResubOpts } from '../accounts/types';

/**
 * `UserMap`'s `'websocket'` subscription strategy: uses
 * `WebSocketProgramAccountSubscriber` with the map's memcmp filters (base
 * `User` filter, plus non-idle unless `includeIdle`, plus any
 * `additionalFilters`) to receive push updates for every matching account,
 * feeding them into `userMap.updateUserAccount`. Internal to `UserMap` — not
 * part of the SDK's public exports.
 */
export class WebsocketSubscription {
	private userMap: UserMap;
	private commitment: Commitment;
	private skipInitialLoad: boolean;
	private resubOpts?: ResubOpts;
	private includeIdle?: boolean;
	private additionalFilters?: MemcmpFilter[];
	private decodeFn: (name: string, data: Buffer) => UserAccount;

	private subscriber?: WebSocketProgramAccountSubscriber<UserAccount>;

	constructor({
		userMap,
		commitment,
		skipInitialLoad = false,
		resubOpts,
		includeIdle = false,
		decodeFn,
		additionalFilters = undefined,
	}: {
		userMap: UserMap;
		commitment: Commitment;
		skipInitialLoad?: boolean;
		resubOpts?: ResubOpts;
		includeIdle?: boolean;
		decodeFn: (name: string, data: Buffer) => UserAccount;
		additionalFilters?: MemcmpFilter[];
	}) {
		this.userMap = userMap;
		this.commitment = commitment;
		this.skipInitialLoad = skipInitialLoad;
		this.resubOpts = resubOpts;
		this.includeIdle = includeIdle || false;
		this.decodeFn = decodeFn;
		this.additionalFilters = additionalFilters;
	}

	/** Starts the websocket program-account subscription, then (unless `skipInitialLoad`) runs an initial full `userMap.sync()`. */
	public async subscribe(): Promise<void> {
		if (!this.subscriber) {
			const filters = [getUserFilter()];
			if (!this.includeIdle) {
				filters.push(getNonIdleUserFilter());
			}
			if (this.additionalFilters) {
				filters.push(...this.additionalFilters);
			}
			this.subscriber = new WebSocketProgramAccountSubscriber<UserAccount>(
				'UserMap',
				'user',
				this.userMap.velocityClient.program,
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
