import {
	DataAndSlot,
	NotSubscribedError,
	InsuranceFundStakeAccountEvents,
	InsuranceFundStakeAccountSubscriber,
} from './types';
import { VelocityProgram } from '../config';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './bulkAccountLoader';
import { InsuranceFundStake } from '../types';

/**
 * `InsuranceFundStakeAccountSubscriber` backed by a shared `BulkAccountLoader` instead of a
 * dedicated WebSocket subscription, mirroring `PollingUserAccountSubscriber` for
 * `InsuranceFundStake` accounts.
 */
export class PollingInsuranceFundStakeAccountSubscriber
	implements InsuranceFundStakeAccountSubscriber
{
	isSubscribed: boolean;
	program: VelocityProgram;
	eventEmitter: StrictEventEmitter<
		EventEmitter,
		InsuranceFundStakeAccountEvents
	>;
	insuranceFundStakeAccountPublicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	callbackId?: string;
	errorCallbackId?: string;

	insuranceFundStakeAccountAndSlot?: DataAndSlot<InsuranceFundStake>;

	/**
	 * @param program Anchor program used for the one-off `fetch()` fallback and account decoding.
	 * @param publicKey Address of the `InsuranceFundStake` account to track.
	 * @param accountLoader Shared `BulkAccountLoader` this subscriber registers its callback with.
	 */
	public constructor(
		program: VelocityProgram,
		publicKey: PublicKey,
		accountLoader: BulkAccountLoader
	) {
		this.isSubscribed = false;
		this.program = program;
		this.insuranceFundStakeAccountPublicKey = publicKey;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
	}

	/**
	 * Registers this account with the shared `BulkAccountLoader`. Note this does not wait for an
	 * initial fetch to land before returning `isSubscribed = true`, unlike the analogous
	 * `PollingUserAccountSubscriber.subscribe`; call `fetchIfUnloaded()` explicitly if data is
	 * needed immediately. Idempotent: a no-op if already subscribed.
	 * @param insuranceFundStake Optional pre-fetched account data to seed with (at slot 0) instead of an immediate fetch.
	 */
	async subscribe(insuranceFundStake?: InsuranceFundStake): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (insuranceFundStake) {
			this.insuranceFundStakeAccountAndSlot = {
				data: insuranceFundStake,
				slot: 0,
			};
		}

		await this.addToAccountLoader();

		if (this.doesAccountExist()) {
			this.eventEmitter.emit('update');
		}

		this.isSubscribed = true;
		return true;
	}

	/** Registers this account and an error callback with the `BulkAccountLoader`. A no-op if already registered. */
	async addToAccountLoader(): Promise<void> {
		if (this.callbackId) {
			return;
		}

		this.callbackId = await this.accountLoader.addAccount(
			this.insuranceFundStakeAccountPublicKey,
			(buffer, slot: number) => {
				if (!buffer) {
					return;
				}

				if (
					this.insuranceFundStakeAccountAndSlot &&
					this.insuranceFundStakeAccountAndSlot.slot > slot
				) {
					return;
				}

				const account = this.program.coder.accounts.decode(
					'insuranceFundStake',
					buffer
				);
				this.insuranceFundStakeAccountAndSlot = { data: account, slot };
				this.eventEmitter.emit('insuranceFundStakeAccountUpdate', account);
				this.eventEmitter.emit('update');
			}
		);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	/** Fetches via `fetch()` only if no data is cached yet; otherwise a no-op. */
	async fetchIfUnloaded(): Promise<void> {
		if (!this.doesAccountExist()) {
			await this.fetch();
		}
	}

	/** Fetches the account once directly via `program.account.insuranceFundStake.fetchAndContext` (independent of the account loader's poll cycle), applying it only if the response's slot is newer than what's cached. Logs and swallows errors rather than throwing. */
	async fetch(): Promise<void> {
		try {
			const dataAndContext = await (
				this.program.account as any
			).insuranceFundStake.fetchAndContext(
				this.insuranceFundStakeAccountPublicKey,
				this.accountLoader.commitment
			);
			if (
				dataAndContext.context.slot >
				(this.insuranceFundStakeAccountAndSlot?.slot ?? 0)
			) {
				this.insuranceFundStakeAccountAndSlot = {
					data: dataAndContext.data as InsuranceFundStake,
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			console.log(
				`PollingInsuranceFundStakeAccountSubscriber.fetch() InsuranceFundStake does not exist: ${
					e instanceof Error ? e.message : String(e)
				}`
			);
		}
	}

	/** Type predicate: true once `insuranceFundStakeAccountAndSlot` has loaded, narrowing it to non-undefined. */
	doesAccountExist(): this is {
		insuranceFundStakeAccountAndSlot: DataAndSlot<InsuranceFundStake>;
	} {
		return this.insuranceFundStakeAccountAndSlot !== undefined;
	}

	/** Unregisters this account (and its error callback) from the `BulkAccountLoader`. A no-op if not subscribed. */
	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		this.accountLoader.removeAccount(
			this.insuranceFundStakeAccountPublicKey,
			this.callbackId
		);
		this.callbackId = undefined;

		this.accountLoader.removeErrorCallbacks(this.errorCallbackId);
		this.errorCallbackId = undefined;

		this.isSubscribed = false;
	}

	/** Throws `NotSubscribedError` if `subscribe()` has not been called. */
	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	/** Throws `NotSubscribedError` if not subscribed. Returns undefined only if subscribed but no data has loaded yet. */
	public getInsuranceFundStakeAccountAndSlot():
		| DataAndSlot<InsuranceFundStake>
		| undefined {
		this.assertIsSubscribed();
		return this.insuranceFundStakeAccountAndSlot;
	}

	/** True once account data has been loaded, independent of `isSubscribed`. */
	didSubscriptionSucceed(): boolean {
		return !!this.insuranceFundStakeAccountAndSlot;
	}

	/**
	 * Applies an externally-obtained account update if `slot` is newer than the currently cached
	 * slot (strictly newer — unlike most other subscribers here, an equal slot is not accepted).
	 * @param insuranceFundStake Decoded account data to apply.
	 * @param slot Slot the data was observed at.
	 */
	public updateData(
		insuranceFundStake: InsuranceFundStake,
		slot: number
	): void {
		if (
			!this.insuranceFundStakeAccountAndSlot ||
			this.insuranceFundStakeAccountAndSlot.slot < slot
		) {
			this.insuranceFundStakeAccountAndSlot = {
				data: insuranceFundStake,
				slot,
			};
			this.eventEmitter.emit(
				'insuranceFundStakeAccountUpdate',
				insuranceFundStake
			);
			this.eventEmitter.emit('update');
		}
	}
}
