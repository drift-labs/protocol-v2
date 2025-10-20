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
	private listeners = new Map<string, Set<StrictEventEmitter<EventEmitter, UserAccountEvents>>>();
	private keyToPk = new Map<string, PublicKey>();
	private pendingAddKeys = new Set<string>();
	private debounceTimer?: ReturnType<typeof setTimeout>;
	private debounceMs = 50;
	private isMultiSubscribed = false;
	private resubOpts?: ResubOpts;

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
		resubOpts?: ResubOpts
	) {
		this.program = program;
		grpcMultiAccountSubscriber.create<UserAccount>(
			grpcConfigs,
			'user',
			program,
			undefined,
			resubOpts,
		).then((multiSubscriber) => {
			this.multiSubscriber = multiSubscriber;
		});
	}

	public forUser(userAccountPublicKey: PublicKey): UserAccountSubscriber {
		const key = userAccountPublicKey.toBase58();
		const perUserEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents> =
			new EventEmitter();
		const parent = this;
		let isSubscribed = false;

		const registerHandlerIfNeeded = async () => {
			if (!this.listeners.has(key)) {
				this.listeners.set(key, new Set());
				this.keyToPk.set(key, userAccountPublicKey);
				this.pendingAddKeys.add(key);
				this.scheduleFlush();
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
					this.handleAccountChange(new PublicKey(k), data, ctx, buffer, accountProps);
				});
			}
			await this.multiSubscriber.addAccounts(allPks);
		}

		this.pendingAddKeys.clear();
		this.debounceTimer = undefined;
	}
}


