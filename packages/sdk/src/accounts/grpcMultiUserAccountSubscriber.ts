import {
	DataAndSlot,
	GrpcConfigs,
	NotSubscribedError,
	ResubOpts,
	UserAccountEvents,
	UserAccountSubscriber,
} from './types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Context, PublicKey } from '@solana/web3.js';
import { UserAccount } from '../types';
import { VelocityProgram } from '../config';
import { grpcMultiAccountSubscriber } from './grpcMultiAccountSubscriber';

/**
 * Multiplexes many `UserAccount` subscriptions onto a single `grpcMultiAccountSubscriber`,
 * exposing a per-user `UserAccountSubscriber` facade via `forUser()` so callers (e.g. `User`
 * instances) can interact with it as if each had its own subscription. New `forUser()` keys
 * registered while already subscribed are debounced (`debounceMs`, 20ms) and flushed in a single
 * batched `addAccounts` call rather than one gRPC round trip per user.
 */
export class grpcMultiUserAccountSubscriber {
	private program: VelocityProgram;
	private _multiSubscriber?: grpcMultiAccountSubscriber<UserAccount>;
	private get multiSubscriber(): grpcMultiAccountSubscriber<UserAccount> {
		if (!this._multiSubscriber) {
			throw new Error(
				'grpcMultiUserAccountSubscriber: multiSubscriber accessed before subscribe()'
			);
		}
		return this._multiSubscriber;
	}

	private userData = new Map<string, DataAndSlot<UserAccount>>();
	private listeners = new Map<
		string,
		Set<StrictEventEmitter<EventEmitter, UserAccountEvents>>
	>();
	private keyToPk = new Map<string, PublicKey>();
	private pendingAddKeys = new Set<string>();
	private debounceTimer?: ReturnType<typeof setTimeout>;
	private debounceMs = 20;
	/** Maximum time to wait in `subscribe()` for every registered user key to appear in the multi-subscriber's data map before giving up. */
	private static readonly SUBSCRIBE_DATA_TIMEOUT_MS = 30_000;
	private isMultiSubscribed = false;
	private userAccountSubscribers = new Map<string, UserAccountSubscriber>();
	private grpcConfigs: GrpcConfigs;
	resubOpts?: ResubOpts;

	private handleAccountChange = (
		accountId: PublicKey,
		data: UserAccount,
		context: Context,
		_buffer?: unknown,
		_accountProps?: unknown
	): void => {
		const k = accountId.toBase58();
		this.userData.set(k, { data, slot: context.slot });
		const setForKey = this.listeners.get(k);
		if (setForKey) {
			for (const emitter of setForKey) {
				emitter.emit('userAccountUpdate', data);
				emitter.emit('update');
			}
		}
	};

	/**
	 * @param program Anchor program used for the per-user `fetch()` fallback.
	 * @param grpcConfigs gRPC Geyser endpoint/token/commitment config (Yellowstone or LaserStream).
	 * @param resubOpts Resubscription watchdog options passed to the underlying `grpcMultiAccountSubscriber`.
	 * @param multiSubscriber Optional pre-constructed `grpcMultiAccountSubscriber` to reuse instead of creating a new one in `subscribe()`.
	 */
	public constructor(
		program: VelocityProgram,
		grpcConfigs: GrpcConfigs,
		resubOpts?: ResubOpts,
		multiSubscriber?: grpcMultiAccountSubscriber<UserAccount>
	) {
		this.program = program;
		if (multiSubscriber) {
			this._multiSubscriber = multiSubscriber;
		}
		this.grpcConfigs = grpcConfigs;
		this.resubOpts = resubOpts;
	}

	/**
	 * Creates the shared `grpcMultiAccountSubscriber` (if not injected at construction),
	 * subscribes every per-user facade already registered via `forUser()`, flushes any pending
	 * user keys into the underlying gRPC stream, and blocks until the multi-subscriber's account
	 * data map contains an entry for every registered user key (polling at `debounceMs` intervals),
	 * up to `SUBSCRIBE_DATA_TIMEOUT_MS`.
	 * @throws if any registered user key is still missing from the data map once the timeout elapses.
	 */
	public async subscribe(): Promise<void> {
		if (!this._multiSubscriber) {
			this._multiSubscriber =
				await grpcMultiAccountSubscriber.create<UserAccount>(
					this.grpcConfigs,
					'user',
					this.program,
					undefined,
					this.resubOpts
				);
		}

		// Subscribe all per-user subscribers first
		await Promise.all(
			Array.from(this.userAccountSubscribers.values()).map((subscriber) =>
				subscriber.subscribe()
			)
		);
		// Ensure we immediately register any pending keys and kick off underlying subscription/fetch
		await this.flushPending();
		// Proactively fetch once to populate data for all subscribed accounts
		await this.multiSubscriber.fetch();
		// Wait until the underlying multi-subscriber has data for every registered user key
		const targetKeys = Array.from(this.listeners.keys());
		if (targetKeys.length === 0) return;
		// Poll until all keys are present in dataMap, bounded by a deadline so a key that never
		// arrives (e.g. dropped subscription) fails loudly instead of hanging forever.
		// Use debounceMs as the polling cadence to avoid introducing new magic numbers
		const deadline =
			Date.now() + grpcMultiUserAccountSubscriber.SUBSCRIBE_DATA_TIMEOUT_MS;
		let missingKeys = targetKeys.filter(
			(k) => !this.multiSubscriber.getAccountDataMap().has(k)
		);
		while (missingKeys.length > 0) {
			if (Date.now() >= deadline) {
				throw new Error(
					`grpcMultiUserAccountSubscriber: timed out after ${
						grpcMultiUserAccountSubscriber.SUBSCRIBE_DATA_TIMEOUT_MS
					}ms waiting for account data for keys: ${missingKeys.join(', ')}`
				);
			}
			await new Promise((resolve) => setTimeout(resolve, this.debounceMs));
			missingKeys = targetKeys.filter(
				(k) => !this.multiSubscriber.getAccountDataMap().has(k)
			);
		}
	}

	/**
	 * Returns a `UserAccountSubscriber` facade for `userAccountPublicKey`, creating one on first
	 * call (subsequent calls for the same pubkey return the same instance). The facade's
	 * `subscribe()`/`unsubscribe()` register/deregister interest in this shared multi-subscriber
	 * rather than opening their own gRPC stream; the underlying account is only actually removed
	 * from the shared stream once every facade sharing that key has unsubscribed. Its `fetch()`
	 * bypasses the shared stream and issues a direct one-off `program.account.user.fetch` call.
	 * @param userAccountPublicKey Address of the `UserAccount` to get (or create) a facade for.
	 */
	public forUser(userAccountPublicKey: PublicKey): UserAccountSubscriber {
		if (this.userAccountSubscribers.has(userAccountPublicKey.toBase58())) {
			return this.userAccountSubscribers.get(userAccountPublicKey.toBase58())!;
		}
		const key = userAccountPublicKey.toBase58();
		const perUserEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents> =
			new EventEmitter();
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const parent = this;
		let isSubscribed = false;

		const registerHandlerIfNeeded = async () => {
			if (!this.listeners.has(key)) {
				this.listeners.set(key, new Set());
				this.keyToPk.set(key, userAccountPublicKey);
				this.pendingAddKeys.add(key);
				if (this.isMultiSubscribed) {
					// only schedule flush if already subscribed to the multi-subscriber
					this.scheduleFlush();
				}
			}
		};

		const perUser: UserAccountSubscriber = {
			get eventEmitter() {
				return perUserEmitter;
			},
			set eventEmitter(_v) {},

			get isSubscribed() {
				return isSubscribed;
			},
			set isSubscribed(_v: boolean) {
				isSubscribed = _v;
			},

			async subscribe(userAccount?: UserAccount): Promise<boolean> {
				if (isSubscribed) return true;
				if (userAccount) {
					this.updateData(userAccount, 0);
				}
				await registerHandlerIfNeeded();
				const setForKey = parent.listeners.get(key)!;
				setForKey.add(perUserEmitter);
				isSubscribed = true;
				return true;
			},

			async fetch(): Promise<void> {
				if (!isSubscribed) {
					throw new NotSubscribedError(
						'Must subscribe before fetching account updates'
					);
				}
				const account = (await (parent.program.account as any).user.fetch(
					userAccountPublicKey
				)) as UserAccount;
				this.updateData(account, 0);
			},

			updateData(userAccount: UserAccount, slot: number): void {
				const existingData = parent.userData.get(key);
				if (existingData && existingData.slot > slot) {
					return;
				}
				parent.userData.set(key, { data: userAccount, slot });
				perUserEmitter.emit('userAccountUpdate', userAccount);
				perUserEmitter.emit('update');
			},

			async unsubscribe(): Promise<void> {
				if (!isSubscribed) return;
				const setForKey = parent.listeners.get(key);
				if (setForKey) {
					setForKey.delete(perUserEmitter);
					if (setForKey.size === 0) {
						parent.listeners.delete(key);
						await parent.multiSubscriber.removeAccounts([userAccountPublicKey]);
						parent.userData.delete(key);
						parent.keyToPk.delete(key);
						parent.pendingAddKeys.delete(key);
					}
				}
				isSubscribed = false;
			},

			getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined {
				if (!isSubscribed) {
					throw new NotSubscribedError(
						'You must call `subscribe` before using this function'
					);
				}
				return parent.userData.get(key);
			},
		};

		this.userAccountSubscribers.set(userAccountPublicKey.toBase58(), perUser);
		return perUser;
	}

	private scheduleFlush(): void {
		if (this.debounceTimer) return;
		this.debounceTimer = setTimeout(() => {
			void this.flushPending();
		}, this.debounceMs);
	}

	private async flushPending(): Promise<void> {
		const hasPending = this.pendingAddKeys.size > 0;
		if (!hasPending) {
			this.debounceTimer = undefined;
			return;
		}

		const allPks: PublicKey[] = [];
		for (const k of this.listeners.keys()) {
			const pk = this.keyToPk.get(k);
			if (pk) allPks.push(pk);
		}
		if (allPks.length === 0) {
			this.pendingAddKeys.clear();
			this.debounceTimer = undefined;
			return;
		}

		if (!this.isMultiSubscribed) {
			await this.multiSubscriber.subscribe(allPks, this.handleAccountChange);
			this.isMultiSubscribed = true;
			await this.multiSubscriber.fetch();
			for (const k of this.pendingAddKeys) {
				const pk = this.keyToPk.get(k);
				if (pk) {
					const data = this.multiSubscriber.getAccountData(k);
					if (data) {
						this.handleAccountChange(
							pk,
							data.data,
							{ slot: data.slot },
							undefined,
							undefined
						);
					}
				}
			}
		} else {
			const ms = this.multiSubscriber as unknown as {
				onChangeMap: Map<
					string,
					(
						data: UserAccount,
						context: Context,
						buffer: unknown,
						accountProps: unknown
					) => void
				>;
			};
			for (const k of this.pendingAddKeys) {
				ms.onChangeMap.set(k, (data, ctx, buffer, accountProps) => {
					this.multiSubscriber.setAccountData(k, data, ctx.slot);
					this.handleAccountChange(
						new PublicKey(k),
						data,
						ctx,
						buffer,
						accountProps
					);
				});
			}
			await this.multiSubscriber.addAccounts(allPks);
		}

		this.pendingAddKeys.clear();
		this.debounceTimer = undefined;
	}
}
