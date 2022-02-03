import {
	AccountToPoll,
	NotSubscribedError,
	UserAccountEvents,
	UserAccountSubscriber,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { getUserAccountPublicKey } from '../addresses';
import { UserAccount, UserPositionsAccount } from '../types';
import { BulkAccountLoader } from './bulkAccountLoader';
import { capitalize } from './utils';

export class PollingUserAccountSubscriber implements UserAccountSubscriber {
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	authority: PublicKey;

	accountLoader: BulkAccountLoader;
	accountsToPoll = new Map<string, AccountToPoll>();
	onAccountUpdate?: (publicKey: PublicKey, buffer: Buffer) => void;
	onError?: (e: Error) => void;

	user?: UserAccount;
	userPositions?: UserPositionsAccount;

	type: 'polling';

	public constructor(
		program: Program,
		authority: PublicKey,
		accountLoader: BulkAccountLoader
	) {
		this.isSubscribed = false;
		this.program = program;
		this.authority = authority;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		await this.updateAccountsToPoll();
		this.addToAccountLoader();
		await this.fetch();
		this.eventEmitter.emit('update');

		this.isSubscribed = true;
		return true;
	}

	async updateAccountsToPoll(): Promise<void> {
		if (this.accountsToPoll.size > 0) {
			return;
		}

		const userPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority
		);

		const userAccount = (await this.program.account.user.fetch(
			userPublicKey
		)) as UserAccount;

		this.accountsToPoll.set(userPublicKey.toString(), {
			key: 'user',
			publicKey: userPublicKey,
			eventType: 'userAccountData',
		});

		this.accountsToPoll.set(userAccount.positions.toString(), {
			key: 'userPositions',
			publicKey: userAccount.positions,
			eventType: 'userPositionsData',
		});
	}

	addToAccountLoader(): void {
		this.onAccountUpdate = (publicKey: PublicKey, buffer: Buffer) => {
			const accountToPoll = this.accountsToPoll.get(publicKey.toString());
			if (!accountToPoll) {
				return;
			}

			const account = this.program.account[
				accountToPoll.key
			].coder.accounts.decode(capitalize(accountToPoll.key), buffer);
			this[accountToPoll.key] = account;
			// @ts-ignore
			this.eventEmitter.emit(accountToPoll.eventType, account);
			this.eventEmitter.emit('update');
		};
		this.accountLoader.eventEmitter.on('accountUpdate', this.onAccountUpdate);

		this.onError = (e) => {
			this.eventEmitter.emit('error', e);
		};
		this.accountLoader.eventEmitter.on('error', this.onError);

		for (const [_, accountToPoll] of this.accountsToPoll) {
			this.accountLoader.addAccount(accountToPoll.publicKey);
		}
	}

	async fetch(): Promise<void> {
		await this.accountLoader.load();
		for (const [_, accountToPoll] of this.accountsToPoll) {
			const buffer = this.accountLoader.getAccountData(accountToPoll.publicKey);
			if (buffer) {
				this[accountToPoll.key] = this.program.account[
					accountToPoll.key
				].coder.accounts.decode(capitalize(accountToPoll.key), buffer);
			}
		}
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		for (const [_, accountToPoll] of this.accountsToPoll) {
			this.accountLoader.removeAccount(accountToPoll.publicKey);
		}
		this.accountLoader.eventEmitter.removeListener(
			'accountUpdate',
			this.onAccountUpdate
		);
		this.onAccountUpdate = undefined;
		this.accountLoader.eventEmitter.removeListener('error', this.onError);
		this.onError = undefined;

		this.accountsToPoll.clear();

		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getUserAccount(): UserAccount {
		this.assertIsSubscribed();
		return this.user;
	}

	public getUserPositionsAccount(): UserPositionsAccount {
		this.assertIsSubscribed();
		return this.userPositions;
	}
}
