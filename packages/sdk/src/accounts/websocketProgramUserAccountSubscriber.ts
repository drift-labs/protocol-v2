import {
	DataAndSlot,
	NotSubscribedError,
	UserAccountEvents,
	UserAccountSubscriber,
} from './types';
import { VelocityProgram } from '../config';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Context, PublicKey } from '@solana/web3.js';
import { WebSocketProgramAccountSubscriber } from './webSocketProgramAccountSubscriber';
import { UserAccount } from '../types';

/**
 * `UserAccountSubscriber` that filters a *shared* `WebSocketProgramAccountSubscriber` (subscribed
 * once, program-wide, by the caller) down to a single `UserAccount` by pubkey, instead of opening
 * its own dedicated subscription. Overwrites the shared subscriber's `onChange` callback in
 * `subscribe()` — only one `WebSocketProgramUserAccountSubscriber` can usefully attach to a given
 * `programSubscriber` at a time, since each `subscribe()` call replaces the previous `onChange`.
 */
export class WebSocketProgramUserAccountSubscriber
	implements UserAccountSubscriber
{
	isSubscribed: boolean;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;

	private userAccountPublicKey: PublicKey;
	private program: VelocityProgram;
	private programSubscriber: WebSocketProgramAccountSubscriber<UserAccount>;
	private userAccountAndSlot?: DataAndSlot<UserAccount>;

	/**
	 * @param program Anchor program used for the one-off `fetch()` fallback.
	 * @param userAccountPublicKey Address of the `UserAccount` to filter for.
	 * @param programSubscriber Shared, already-created program-account subscriber (not subscribed by this constructor — see `subscribe()`).
	 */
	public constructor(
		program: VelocityProgram,
		userAccountPublicKey: PublicKey,
		programSubscriber: WebSocketProgramAccountSubscriber<UserAccount>
	) {
		this.isSubscribed = false;
		this.program = program;
		this.userAccountPublicKey = userAccountPublicKey;
		this.eventEmitter = new EventEmitter();
		this.programSubscriber = programSubscriber;
	}

	/**
	 * Installs (overwriting) an `onChange` handler on the shared `programSubscriber` that filters
	 * updates down to this instance's `userAccountPublicKey`. Does not itself call
	 * `programSubscriber.subscribe()` — the caller is responsible for starting the shared program
	 * subscription separately.
	 * @param userAccount Optional pre-fetched account data to seed with immediately (at slot 0).
	 */
	async subscribe(userAccount?: UserAccount): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (userAccount) {
			this.updateData(userAccount, 0);
		}

		this.programSubscriber.onChange = (
			accountId: PublicKey,
			data: UserAccount,
			context: Context
		) => {
			// the shared programSubscriber callback isn't detached on unsubscribe(), so
			// guard here to stop delivering updates once this facade is unsubscribed
			if (!this.isSubscribed) {
				return;
			}
			if (accountId.equals(this.userAccountPublicKey)) {
				this.updateData(data, context.slot);
				this.eventEmitter.emit('userAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		};

		this.isSubscribed = true;
		return true;
	}

	/** Fetches the account once directly via `program.account.user.fetch` (independent of the shared program subscription), storing the result at slot 0 (not the fetch's actual slot). Throws `NotSubscribedError` if not subscribed. */
	async fetch(): Promise<void> {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'Must subscribe before fetching account updates'
			);
		}

		const account = await (this.program.account as any).user.fetch(
			this.userAccountPublicKey
		);
		this.updateData(account as UserAccount, 0);
	}

	/**
	 * Overwrites the cached data unconditionally — unlike most other `updateData` implementations
	 * in this directory, there is no slot-ordering guard here, so a caller must not pass stale data.
	 * @param userAccount Decoded account data to store.
	 * @param slot Slot the data was observed at.
	 */
	updateData(userAccount: UserAccount, slot: number): void {
		this.userAccountAndSlot = {
			data: userAccount,
			slot,
		};
	}

	/** Marks this facade unsubscribed. Does not touch the shared `programSubscriber`'s `onChange` handler or its subscription state. */
	async unsubscribe(): Promise<void> {
		this.isSubscribed = false;
	}

	/** Throws `NotSubscribedError` if not subscribed. Returns undefined only if subscribed but no data has loaded yet. */
	getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
		return this.userAccountAndSlot;
	}
}
