import { BN } from '../isomorphic/anchor';
import { User } from '../user';
import { VelocityClient } from '../velocityClient';
import {
	UserAccount,
	OrderRecord,
	DepositRecord,
	FundingPaymentRecord,
	LiquidationRecord,
	OrderActionRecord,
	SettlePnlRecord,
	NewUserRecord,
	StateAccount,
} from '../types';
import { WrappedEvent } from '../events/types';
import { DLOB } from '../dlob/DLOB';
import { UserSubscriptionConfig } from '../userConfig';
import { DataAndSlot, UserEvents } from '../accounts/types';
import { OneShotUserAccountSubscriber } from '../accounts/oneShotUserAccountSubscriber';

import {
	Commitment,
	Connection,
	MemcmpFilter,
	PublicKey,
	RpcResponseAndContext,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import { ZSTDDecoder } from 'zstddec';
import {
	getNonIdleUserFilter,
	getUserFilter,
	getUsersWithPoolId,
} from '../memcmp';
import {
	SyncConfig,
	UserAccountFilterCriteria as UserFilterCriteria,
	UserMapConfig,
} from './userMapConfig';
import { WebsocketSubscription } from './WebsocketSubscription';
import { PollingSubscription } from './PollingSubscription';
import { decodeUser } from '../decode/user';
import { grpcSubscription } from './grpcSubscription';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';

// Velocity's User account is 4496 bytes (8-byte discriminator + 4488 struct);
// drift's was 4376. This caps the zstd-decompressed buffer in defaultSync — if it's
// smaller than the real account, the buffer is truncated and decodeUser reads past
// the end (RangeError: ERR_BUFFER_OUT_OF_BOUNDS). Must be >= the on-chain User size.
const MAX_USER_ACCOUNT_SIZE_BYTES = 4496;

/** Public surface implemented by `UserMap`. */
export interface UserMapInterface {
	eventEmitter: StrictEventEmitter<EventEmitter, UserEvents>;
	subscribe(): Promise<void>;
	unsubscribe(): Promise<void>;
	addPubkey(
		userAccountPublicKey: PublicKey,
		userAccount?: UserAccount,
		slot?: number,
		accountSubscription?: UserSubscriptionConfig
	): Promise<void>;
	has(key: string): boolean;
	get(key: string): User | undefined;
	getWithSlot(key: string): DataAndSlot<User> | undefined;
	mustGet(
		key: string,
		accountSubscription?: UserSubscriptionConfig
	): Promise<User>;
	mustGetWithSlot(
		key: string,
		accountSubscription?: UserSubscriptionConfig
	): Promise<DataAndSlot<User>>;
	getUserAuthority(key: string): PublicKey | undefined;
	updateWithOrderRecord(record: OrderRecord): Promise<void>;
	values(): IterableIterator<User>;
	valuesWithSlot(): IterableIterator<DataAndSlot<User>>;
	entries(): IterableIterator<[string, User]>;
	entriesWithSlot(): IterableIterator<[string, DataAndSlot<User>]>;
}

/**
 * In-memory cache of every `User` account on the program, keyed by the
 * `User` account's own public key.
 *
 * Sync/subscription filtering (see `getFilters`) is built from memcmp
 * filters: the base `getUserFilter()` (matches the `User` account
 * discriminator — required, or every account on chain would match) is always
 * present; `getNonIdleUserFilter()` is added unless `includeIdle` is set (idle
 * accounts are excluded by default to reduce subscription volume);
 * `getUsersWithPoolId(filterByPoolId)` is added when `filterByPoolId` is set;
 * and any `additionalFilters` from the config are appended last. The same
 * filter set is used for the initial `getProgramAccounts` sync and for the
 * live websocket/gRPC subscription, so what you sync is what you keep getting
 * updates for.
 *
 * Automatically does a full `sync()` whenever the program's
 * `StateAccount.numberOfSubAccounts` changes (new/deleted user accounts),
 * unless `disableSyncOnTotalAccountsChange` is set.
 */
export class UserMap implements UserMapInterface {
	private userMap = new Map<string, DataAndSlot<User>>();
	velocityClient: VelocityClient;
	eventEmitter: StrictEventEmitter<EventEmitter, UserEvents>;
	private connection: Connection;
	private commitment: Commitment;
	private includeIdle: boolean;
	private filterByPoolId?: number;
	private additionalFilters?: MemcmpFilter[];
	private disableSyncOnTotalAccountsChange: boolean;
	private lastNumberOfSubAccounts?: BN;
	private subscription:
		| PollingSubscription
		| WebsocketSubscription
		| grpcSubscription;
	private stateAccountUpdateCallback = async (state: StateAccount) => {
		if (
			this.lastNumberOfSubAccounts === undefined ||
			!state.numberOfSubAccounts.eq(this.lastNumberOfSubAccounts)
		) {
			await this.sync();
			this.lastNumberOfSubAccounts = state.numberOfSubAccounts;
		}
	};
	private decode: (name: string, buffer: Buffer) => UserAccount;
	private mostRecentSlot = 0;
	private syncConfig: SyncConfig;

	private syncPromise?: Promise<void>;
	private syncPromiseResolver: () => void = () => {};

	private throwOnFailedSync: boolean;

	/**
	 * Constructs a new UserMap instance.
	 */
	constructor(config: UserMapConfig) {
		// Type-system guarantees at least one of the two is supplied.
		this.velocityClient = config.velocityClient!;
		if (config.connection) {
			this.connection = config.connection;
		} else {
			this.connection = this.velocityClient.connection;
		}
		this.commitment =
			(config.subscriptionConfig.type === 'websocket' ||
			config.subscriptionConfig.type === 'polling'
				? config.subscriptionConfig.commitment ??
				  this.velocityClient.opts?.commitment
				: this.velocityClient.opts?.commitment) ?? 'confirmed';
		this.includeIdle = config.includeIdle ?? false;
		this.filterByPoolId = config.filterByPoolId;
		this.additionalFilters = config.additionalFilters;
		this.disableSyncOnTotalAccountsChange =
			config.disableSyncOnTotalAccountsChange ?? false;

		let decodeFn: (name: string, buffer: Buffer) => UserAccount;
		if (config.fastDecode ?? true) {
			decodeFn = (_name: string, buffer: Buffer) => decodeUser(buffer);
		} else {
			decodeFn = (
				this.velocityClient.program.account as any
			).user.coder.accounts.decodeUnchecked.bind(
				(this.velocityClient.program.account as any).user.coder.accounts
			);
		}
		this.decode = decodeFn;

		if (config.subscriptionConfig.type === 'polling') {
			this.subscription = new PollingSubscription({
				userMap: this,
				frequency: config.subscriptionConfig.frequency,
				skipInitialLoad: config.skipInitialLoad,
			});
		} else if (config.subscriptionConfig.type === 'grpc') {
			this.subscription = new grpcSubscription({
				userMap: this,
				grpcConfigs: config.subscriptionConfig.grpcConfigs,
				resubOpts: {
					resubTimeoutMs: config.subscriptionConfig.resubTimeoutMs,
					logResubMessages: config.subscriptionConfig.logResubMessages,
				},
				skipInitialLoad: config.skipInitialLoad,
				decodeFn,
			});
		} else {
			this.subscription = new WebsocketSubscription({
				userMap: this,
				commitment: this.commitment,
				resubOpts: {
					resubTimeoutMs: config.subscriptionConfig.resubTimeoutMs,
					logResubMessages: config.subscriptionConfig.logResubMessages,
				},
				skipInitialLoad: config.skipInitialLoad,
				decodeFn,
			});
		}

		this.syncConfig = config.syncConfig ?? {
			type: 'default',
		};

		// Whether to throw an error if the userMap fails to sync. Defaults to false.
		this.throwOnFailedSync = config.throwOnFailedSync ?? false;
		this.eventEmitter = new EventEmitter();
	}

	/**
	 * Populates the map with a full initial `sync()` (no-op if already
	 * populated) and starts the configured live subscription
	 * (`'websocket'`/`'polling'`/`'grpc'`), plus (unless
	 * `disableSyncOnTotalAccountsChange`) a listener that triggers a full
	 * re-sync whenever `StateAccount.numberOfSubAccounts` changes.
	 */
	public async subscribe() {
		if (this.size() > 0) {
			return;
		}

		await this.velocityClient.subscribe();
		this.lastNumberOfSubAccounts =
			this.velocityClient.getStateAccount().numberOfSubAccounts;
		if (!this.disableSyncOnTotalAccountsChange) {
			this.velocityClient.eventEmitter.on(
				'stateAccountUpdate',
				this.stateAccountUpdateCallback
			);
		}

		await this.subscription.subscribe();
	}

	/**
	 * Adds `userAccountPublicKey` to the map, creating a `User` for it.
	 *
	 * By default (`accountSubscription` omitted), subscribes it with a
	 * `OneShotUserAccountSubscriber` seeded from `userAccount`/`slot` rather
	 * than a live per-account websocket subscription — the map already gets
	 * live updates in bulk via its own subscription (`WebsocketSubscription`/
	 * `PollingSubscription`/`grpcSubscription`), so per-`User` subscriptions
	 * here would needlessly multiply RPC load.
	 * @param userAccount Optional pre-fetched account data to seed with, skipping an RPC fetch.
	 * @param slot Optional slot the data was observed at. Required (directly or via `userAccount`'s subscriber) — throws if no slot can be determined after subscribing.
	 * @param accountSubscription Optional override for how the created `User` subscribes; defaults to the one-shot subscriber described above.
	 * @throws If no slot is available after subscribing.
	 */
	public async addPubkey(
		userAccountPublicKey: PublicKey,
		userAccount?: UserAccount,
		slot?: number,
		accountSubscription?: UserSubscriptionConfig
	) {
		const user = new User({
			velocityClient: this.velocityClient,
			userAccountPublicKey,
			accountSubscription: accountSubscription ?? {
				type: 'custom',
				// OneShotUserAccountSubscriber used here so we don't load up the RPC with AccountSubscribes
				userAccountSubscriber: new OneShotUserAccountSubscriber(
					this.velocityClient.program,
					userAccountPublicKey,
					userAccount,
					slot,
					this.commitment
				),
			},
		});
		await user.subscribe(userAccount);
		const resolvedSlot = slot ?? user.getUserAccountAndSlot()?.slot;
		if (resolvedSlot === undefined) {
			throw new Error(
				'UserMap.addPubkey: no slot available after subscribing user account'
			);
		}
		this.userMap.set(userAccountPublicKey.toString(), {
			data: user,
			slot: resolvedSlot,
		});
		this.eventEmitter.emit('userUpdate', user);
	}

	/** Returns true if a `User` account keyed by `key` (the `User` account pubkey, base58) is cached in the map. */
	public has(key: string): boolean {
		return this.userMap.has(key);
	}

	/**
	 * gets the User for a particular userAccountPublicKey, if no User exists, undefined is returned
	 * @param key userAccountPublicKey to get User for
	 * @returns user User | undefined
	 */
	public get(key: string): User | undefined {
		return this.userMap.get(key)?.data;
	}
	/** Like `get`, but also returns the slot at which the `User` account was last observed. */
	public getWithSlot(key: string): DataAndSlot<User> | undefined {
		return this.userMap.get(key);
	}

	/**
	 * gets the User for a particular userAccountPublicKey, if no User exists, new one is created
	 * @param key userAccountPublicKey to get User for
	 * @returns  User
	 */
	public async mustGet(
		key: string,
		accountSubscription?: UserSubscriptionConfig
	): Promise<User> {
		if (!this.has(key)) {
			await this.addPubkey(
				new PublicKey(key),
				undefined,
				undefined,
				accountSubscription
			);
		}
		const userWithSlot = this.userMap.get(key);
		if (!userWithSlot) {
			throw new Error(`UserMap.mustGet: no user found for ${key}`);
		}
		return userWithSlot.data;
	}
	/** Like `mustGet`, but also returns the slot at which the `User` account was observed. */
	public async mustGetWithSlot(
		key: string,
		accountSubscription?: UserSubscriptionConfig
	): Promise<DataAndSlot<User>> {
		if (!this.has(key)) {
			await this.addPubkey(
				new PublicKey(key),
				undefined,
				undefined,
				accountSubscription
			);
		}
		const userWithSlot = this.userMap.get(key);
		if (!userWithSlot) {
			throw new Error(`UserMap.mustGetWithSlot: no user found for ${key}`);
		}
		return userWithSlot;
	}

	/** Like `mustGet`, but returns the underlying `UserAccount` data directly (throws if the `User`'s account is not loaded). */
	public async mustGetUserAccount(key: string): Promise<UserAccount> {
		const user = await this.mustGet(key);
		return user.getUserAccountOrThrow();
	}

	/**
	 * gets the Authority for a particular userAccountPublicKey, if no User exists, undefined is returned
	 * @param key userAccountPublicKey to get User for
	 * @returns authority PublicKey | undefined
	 */
	public getUserAuthority(key: string): PublicKey | undefined {
		const user = this.userMap.get(key);
		if (!user) {
			return undefined;
		}
		return user.data.getUserAccount()?.authority;
	}

	/**
	 * Implements the `DLOBSource` interface: builds a `DLOB` from every
	 * subscribed user's open orders.
	 * @param slot Slot to consider orders "current" as of (auction/trigger timing).
	 */
	public async getDLOB(slot: number): Promise<DLOB> {
		const dlob = new DLOB();
		await dlob.initFromUserMap(this, slot);
		return dlob;
	}

	/** Ensures an entry exists in the map for `record.user`, adding it via `addPubkey` if not already present. */
	public async updateWithOrderRecord(record: OrderRecord) {
		if (!this.has(record.user.toString())) {
			await this.addPubkey(record.user);
		}
	}

	/**
	 * Incrementally updates the map in response to a single program event,
	 * ensuring an entry exists for every `User` account the event references
	 * (deposit/funding/liquidation/order/order-action/settle-pnl/new-user
	 * records). Unrecognized event types are silently ignored.
	 */
	public async updateWithEventRecord(record: WrappedEvent<any>) {
		if (record.eventType === 'DepositRecord') {
			const depositRecord = record as DepositRecord;
			await this.mustGet(depositRecord.user.toString());
		} else if (record.eventType === 'FundingPaymentRecord') {
			const fundingPaymentRecord = record as FundingPaymentRecord;
			await this.mustGet(fundingPaymentRecord.user.toString());
		} else if (record.eventType === 'LiquidationRecord') {
			const liqRecord = record as LiquidationRecord;

			await this.mustGet(liqRecord.user.toString());
			await this.mustGet(liqRecord.liquidator.toString());
		} else if (record.eventType === 'OrderRecord') {
			const orderRecord = record as OrderRecord;
			await this.updateWithOrderRecord(orderRecord);
		} else if (record.eventType === 'OrderActionRecord') {
			const actionRecord = record as OrderActionRecord;

			if (actionRecord.taker) {
				await this.mustGet(actionRecord.taker.toString());
			}
			if (actionRecord.maker) {
				await this.mustGet(actionRecord.maker.toString());
			}
		} else if (record.eventType === 'SettlePnlRecord') {
			const settlePnlRecord = record as SettlePnlRecord;
			await this.mustGet(settlePnlRecord.user.toString());
		} else if (record.eventType === 'NewUserRecord') {
			const newUserRecord = record as NewUserRecord;
			await this.mustGet(newUserRecord.user.toString());
		}
	}

	/** Iterates all cached `User` instances. */
	public *values(): IterableIterator<User> {
		for (const dataAndSlot of this.userMap.values()) {
			yield dataAndSlot.data;
		}
	}
	/** Like `values`, but paired with the slot each `User` was last observed at. */
	public valuesWithSlot(): IterableIterator<DataAndSlot<User>> {
		return this.userMap.values();
	}

	/** Iterates all `[userAccountPublicKey, User]` pairs in the map. */
	public *entries(): IterableIterator<[string, User]> {
		for (const [key, dataAndSlot] of this.userMap.entries()) {
			yield [key, dataAndSlot.data];
		}
	}
	/** Like `entries`, but paired with the slot each `User` was last observed at. */
	public entriesWithSlot(): IterableIterator<[string, DataAndSlot<User>]> {
		return this.userMap.entries();
	}

	/** Number of `User` accounts currently cached in the map. */
	public size(): number {
		return this.userMap.size;
	}

	/**
	 * Returns a unique list of authorities for all users in the UserMap that meet the filter criteria
	 * @param filterCriteria: Users must meet these criteria to be included
	 * @returns
	 */
	public getUniqueAuthorities(
		filterCriteria?: UserFilterCriteria
	): PublicKey[] {
		const usersMeetingCriteria = Array.from(this.values()).filter((user) => {
			const userAccount = user.getUserAccountOrThrow();
			if (filterCriteria && filterCriteria.hasOpenOrders) {
				return userAccount.hasOpenOrder;
			}
			return true;
		});
		const userAuths = new Set(
			usersMeetingCriteria.map((user) =>
				user.getUserAccountOrThrow().authority.toBase58()
			)
		);
		const userAuthKeys = Array.from(userAuths).map(
			(userAuth) => new PublicKey(userAuth)
		);
		return userAuthKeys;
	}

	/** Runs a full sync using the strategy configured in `UserMapConfig.syncConfig` (`'default'` or `'paginated'` — see `SyncConfig`). */
	public async sync() {
		if (this.syncConfig.type === 'default') {
			return this.defaultSync();
		} else {
			return this.paginatedSync();
		}
	}

	/**
	 * Builds the memcmp filter set for both the initial sync and the live
	 * subscription: always the `User`-account discriminator filter; plus a
	 * non-idle filter unless `includeIdle`; plus a pool-id filter if
	 * `filterByPoolId` is set; plus any caller-supplied `additionalFilters`.
	 */
	private getFilters(): MemcmpFilter[] {
		const filters = [getUserFilter()];
		if (!this.includeIdle) {
			filters.push(getNonIdleUserFilter());
		}
		if (this.filterByPoolId !== undefined) {
			filters.push(getUsersWithPoolId(this.filterByPoolId));
		}
		if (this.additionalFilters) {
			filters.push(...this.additionalFilters);
		}
		return filters;
	}

	/**
	 * Syncs the UserMap using the default sync method (single getProgramAccounts call with filters).
	 * This method may fail when velocity has too many users. (nodejs response size limits)
	 * @returns
	 */
	private async defaultSync() {
		if (this.syncPromise) {
			return this.syncPromise;
		}
		this.syncPromise = new Promise((resolver) => {
			this.syncPromiseResolver = resolver;
		});

		try {
			const rpcRequestArgs = [
				this.velocityClient.program.programId.toBase58(),
				{
					commitment: this.commitment,
					filters: this.getFilters(),
					encoding: 'base64+zstd',
					withContext: true,
				},
			];

			// @ts-ignore
			const rpcJSONResponse: any = await this.connection._rpcRequest(
				'getProgramAccounts',
				rpcRequestArgs
			);
			const rpcResponseAndContext: RpcResponseAndContext<
				Array<{ pubkey: PublicKey; account: { data: [string, string] } }>
			> = rpcJSONResponse.result;
			const slot = rpcResponseAndContext.context.slot;

			this.updateLatestSlot(slot);

			const programAccountBufferMap = new Map<string, Buffer>();
			const decodingPromises = rpcResponseAndContext.value.map(
				async (programAccount) => {
					const compressedUserData = Buffer.from(
						programAccount.account.data[0],
						'base64'
					);
					const decoder = new ZSTDDecoder();
					await decoder.init();
					const userBuffer = decoder.decode(
						compressedUserData,
						MAX_USER_ACCOUNT_SIZE_BYTES
					);
					programAccountBufferMap.set(
						programAccount.pubkey.toString(),
						Buffer.from(userBuffer)
					);
				}
			);

			await Promise.all(decodingPromises);

			const promises = Array.from(programAccountBufferMap.entries()).map(
				([key, buffer]) =>
					(async () => {
						const currAccountWithSlot = this.getWithSlot(key);
						if (currAccountWithSlot) {
							if (slot >= currAccountWithSlot.slot) {
								const userAccount = this.decode('user', buffer);
								this.updateUserAccount(key, userAccount, slot);
							}
						} else {
							const userAccount = this.decode('user', buffer);
							await this.addPubkey(new PublicKey(key), userAccount, slot);
						}
					})()
			);

			await Promise.all(promises);

			for (const [key] of this.entries()) {
				if (!programAccountBufferMap.has(key)) {
					const user = this.get(key);
					if (user) {
						await user.unsubscribe();
						this.userMap.delete(key);
					}
				}
			}
		} catch (err) {
			const e = err as Error;
			console.error(`Error in UserMap.sync(): ${e.message} ${e.stack ?? ''}`);
			if (this.throwOnFailedSync) {
				throw e;
			}
		} finally {
			this.syncPromiseResolver();
			this.syncPromise = undefined;
		}
	}

	/**
	 * Syncs the UserMap using the paginated sync method (multiple getMultipleAccounts calls with filters).
	 * This method is more reliable when velocity has many users.
	 * @returns
	 */
	private async paginatedSync() {
		if (this.syncPromise) {
			return this.syncPromise;
		}

		this.syncPromise = new Promise<void>((resolve) => {
			this.syncPromiseResolver = resolve;
		});

		try {
			const accountsPrefetch = await this.connection.getProgramAccounts(
				this.velocityClient.program.programId,
				{
					dataSlice: { offset: 0, length: 0 },
					filters: this.getFilters(),
				}
			);
			const accountPublicKeys = accountsPrefetch.map(
				(account) => account.pubkey
			);

			const limitConcurrency = async (
				tasks: Array<() => Promise<void>>,
				limit: number
			) => {
				const executing: Promise<void>[] = [];
				const results: Promise<void>[] = [];

				for (let i = 0; i < tasks.length; i++) {
					const executor = Promise.resolve().then(tasks[i]);
					results.push(executor);

					if (executing.length < limit) {
						executing.push(executor);
						executor.finally(() => {
							const index = executing.indexOf(executor);
							if (index > -1) {
								executing.splice(index, 1);
							}
						});
					} else {
						await Promise.race(executing);
					}
				}

				return Promise.all(results);
			};

			const programAccountBufferMap = new Map<string, Buffer>();

			// @ts-ignore
			const chunkSize = this.syncConfig.chunkSize ?? 100;
			const tasks: Array<() => Promise<void>> = [];
			for (let i = 0; i < accountPublicKeys.length; i += chunkSize) {
				const chunk = accountPublicKeys.slice(i, i + chunkSize);
				tasks.push(async () => {
					const accountInfos =
						await this.connection.getMultipleAccountsInfoAndContext(chunk, {
							commitment: this.commitment,
						});

					const accountInfosSlot = accountInfos.context.slot;

					for (let j = 0; j < accountInfos.value.length; j += 1) {
						const accountInfo = accountInfos.value[j];
						if (accountInfo === null) continue;

						const publicKeyString = chunk[j].toString();
						const buffer = Buffer.from(accountInfo.data);
						programAccountBufferMap.set(publicKeyString, buffer);

						const decodedUser = this.decode('user', buffer);

						const currAccountWithSlot = this.getWithSlot(publicKeyString);
						if (
							currAccountWithSlot &&
							currAccountWithSlot.slot <= accountInfosSlot
						) {
							this.updateUserAccount(
								publicKeyString,
								decodedUser,
								accountInfosSlot
							);
						} else {
							await this.addPubkey(
								new PublicKey(publicKeyString),
								decodedUser,
								accountInfosSlot
							);
						}
					}
				});
			}

			// @ts-ignore
			const concurrencyLimit = this.syncConfig.concurrencyLimit ?? 10;
			await limitConcurrency(tasks, concurrencyLimit);

			for (const [key] of this.entries()) {
				if (!programAccountBufferMap.has(key)) {
					const user = this.get(key);
					if (user) {
						await user.unsubscribe();
						this.userMap.delete(key);
					}
				}
			}
		} catch (err) {
			console.error(`Error in UserMap.sync():`, err);
			if (this.throwOnFailedSync) {
				throw err;
			}
		} finally {
			this.syncPromiseResolver();
			this.syncPromise = undefined;
		}
	}

	/**
	 * Tears down the live subscription, unsubscribes and removes every cached
	 * `User`, and (if registered) removes the `stateAccountUpdate` listener
	 * that triggers auto-resync on `numberOfSubAccounts` changes.
	 */
	public async unsubscribe() {
		await this.subscription.unsubscribe();

		for (const [key, user] of this.entries()) {
			await user.unsubscribe();
			this.userMap.delete(key);
		}

		if (this.lastNumberOfSubAccounts) {
			if (!this.disableSyncOnTotalAccountsChange) {
				this.velocityClient.eventEmitter.removeListener(
					'stateAccountUpdate',
					this.stateAccountUpdateCallback
				);
			}

			this.lastNumberOfSubAccounts = undefined;
		}
	}

	/**
	 * Applies a fresh `userAccount` observation for `key` at `slot`. If the
	 * user is already cached, updates in place only if `slot` is at least as
	 * new as the cached slot (stale/out-of-order updates are dropped) and
	 * emits `'userUpdate'`. If not cached yet, adds it via `addPubkey`.
	 * Also advances `getSlot()`'s tracked most-recent slot.
	 */
	public async updateUserAccount(
		key: string,
		userAccount: UserAccount,
		slot: number
	) {
		const userWithSlot = this.getWithSlot(key);
		this.updateLatestSlot(slot);
		if (userWithSlot) {
			if (slot >= userWithSlot.slot) {
				userWithSlot.data.accountSubscriber.updateData(userAccount, slot);
				this.userMap.set(key, {
					data: userWithSlot.data,
					slot,
				});
				this.eventEmitter.emit('userUpdate', userWithSlot.data);
			}
		} else {
			await this.addPubkey(new PublicKey(key), userAccount, slot);
		}
	}

	/** Advances the map's tracked most-recent slot to `slot` if it's newer. */
	updateLatestSlot(slot: number): void {
		this.mostRecentSlot = Math.max(slot, this.mostRecentSlot);
	}

	/** Returns the most recent slot at which any account update has been observed. */
	public getSlot(): number {
		return this.mostRecentSlot;
	}
}
