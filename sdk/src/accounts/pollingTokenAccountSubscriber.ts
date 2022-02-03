import {
	NotSubscribedError,
	TokenAccountEvents,
	TokenAccountSubscriber,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './bulkAccountLoader';
import { AccountInfo } from '@solana/spl-token';
import { parseTokenAccount } from '../token';

export class PollingTokenAccountSubscriber implements TokenAccountSubscriber {
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, TokenAccountEvents>;
	publicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	onAccountUpdate?: (publicKey: PublicKey, buffer: Buffer) => void;
	onError?: (e: Error) => void;

	tokenAccount?: AccountInfo;

	public constructor(publicKey: PublicKey, accountLoader: BulkAccountLoader) {
		this.isSubscribed = false;
		this.publicKey = publicKey;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.addToAccountLoader();
		await this.fetch();
		this.eventEmitter.emit('update');

		this.isSubscribed = true;
		return true;
	}

	addToAccountLoader(): void {
		this.onAccountUpdate = (publicKey: PublicKey, buffer: Buffer) => {
			if (!publicKey.equals(this.publicKey)) {
				return;
			}

			const tokenAccount = parseTokenAccount(buffer);
			this.tokenAccount = tokenAccount;
			// @ts-ignore
			this.eventEmitter.emit('tokenAccountUpdate', tokenAccount);
			this.eventEmitter.emit('update');
		};
		this.accountLoader.eventEmitter.on('accountUpdate', this.onAccountUpdate);

		this.onError = (e) => {
			this.eventEmitter.emit('error', e);
		};
		this.accountLoader.eventEmitter.on('error', this.onError);

		this.accountLoader.addAccount(this.publicKey);
	}

	async fetch(): Promise<void> {
		await this.accountLoader.load();
		const buffer = this.accountLoader.getAccountData(this.publicKey);
		this.tokenAccount = parseTokenAccount(buffer);
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		this.accountLoader.removeAccount(this.publicKey);
		this.accountLoader.eventEmitter.removeListener(
			'accountUpdate',
			this.onAccountUpdate
		);
		this.onAccountUpdate = undefined;
		this.accountLoader.eventEmitter.removeListener('error', this.onError);
		this.onError = undefined;

		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getTokenAccount(): AccountInfo {
		this.assertIsSubscribed();
		return this.tokenAccount;
	}
}
