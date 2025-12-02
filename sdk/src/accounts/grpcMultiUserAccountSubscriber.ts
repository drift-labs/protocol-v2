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
import { Program } from '@coral-xyz/anchor';
import { UserAccount } from '../types';
import { grpcMultiAccountSubscriber } from './grpcMultiAccountSubscriber';

export class grpcMultiUserAccountSubscriber {
	private program: Program;
	private multiSubscriber: grpcMultiAccountSubscriber<UserAccount>;

	private userData = new Map<string, DataAndSlot<UserAccount>>();
	private listeners = new Map<
		string,
		Set<StrictEventEmitter<EventEmitter, UserAccountEvents>>
	>();
	private keyToPk = new Map<string, PublicKey>();
	private pendingAddKeys = new Set<string>();
	private debounceTimer?: ReturnType<typeof setTimeout>;
	private debounceMs = 20;
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

	public constructor(
		program: Program,
		grpcConfigs: GrpcConfigs,
		resubOpts?: ResubOpts,
		multiSubscriber?: grpcMultiAccountSubscriber<UserAccount>
	) {
		this.program = program;
		this.multiSubscriber = multiSubscriber;
		this.grpcConfigs = grpcConfigs;
		this.resubOpts = resubOpts;
	}

	public async subscribe(): Promise<void> {
		if (!this.multiSubscriber) {
			this.multiSubscriber =
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
		// Poll until all keys are present in dataMap
		// Use debounceMs as the polling cadence to avoid introducing new magic numbers
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const map = this.multiSubscriber.getAccountDataMap();
			let allPresent = true;
			for (const k of targetKeys) {
				if (!map.has(k)) {
					allPresent = false;
					break;
				}
			}
			if (allPresent) break;
			await new Promise((resolve) => setTimeout(resolve, this.debounceMs));
		}
	}

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
				const account = (await parent.program.account.user.fetch(
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

			getUserAccountAndSlot(): DataAndSlot<UserAccount> {
				const das = parent.userData.get(key);
				if (!das) {
					throw new NotSubscribedError(
						'Must subscribe before getting user account data'
					);
				}
				return das;
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
