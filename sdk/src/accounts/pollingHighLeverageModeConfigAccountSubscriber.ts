import {
	DataAndSlot,
	NotSubscribedError,
	HighLeverageModeConfigAccountEvents,
	HighLeverageModeConfigAccountSubscriber,
} from './types';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { BulkAccountLoader } from './bulkAccountLoader';
import { HighLeverageModeConfig } from '../types';

export class PollingHighLeverageModeConfigAccountSubscriber
	implements HighLeverageModeConfigAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<
		EventEmitter,
		HighLeverageModeConfigAccountEvents
	>;
	highLeverageModeConfigAccountPublicKey: PublicKey;

	accountLoader: BulkAccountLoader;
	callbackId?: string;
	errorCallbackId?: string;

	highLeverageModeConfigAccountAndSlot?: DataAndSlot<HighLeverageModeConfig>;

	public constructor(
		program: Program,
		publicKey: PublicKey,
		accountLoader: BulkAccountLoader
	) {
		this.isSubscribed = false;
		this.program = program;
		this.highLeverageModeConfigAccountPublicKey = publicKey;
		this.accountLoader = accountLoader;
		this.eventEmitter = new EventEmitter();
	}

	async subscribe(
		highLeverageModeConfig?: HighLeverageModeConfig
	): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (highLeverageModeConfig) {
			this.highLeverageModeConfigAccountAndSlot = {
				data: highLeverageModeConfig,
				slot: undefined,
			};
		}

		await this.addToAccountLoader();

		await this.fetchIfUnloaded();

		if (this.doesAccountExist()) {
			this.eventEmitter.emit('update');
		}

		this.isSubscribed = true;
		return true;
	}

	async addToAccountLoader(): Promise<void> {
		if (this.callbackId) {
			return;
		}

		this.callbackId = await this.accountLoader.addAccount(
			this.highLeverageModeConfigAccountPublicKey,
			(buffer, slot: number) => {
				if (!buffer) {
					return;
				}

				if (
					this.highLeverageModeConfigAccountAndSlot &&
					this.highLeverageModeConfigAccountAndSlot.slot > slot
				) {
					return;
				}

				const account = this.program.account.user.coder.accounts.decode(
					'HighLeverageModeConfig',
					buffer
				);
				this.highLeverageModeConfigAccountAndSlot = { data: account, slot };
				this.eventEmitter.emit('highLeverageModeConfigAccountUpdate', account);
				this.eventEmitter.emit('update');
			}
		);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	async fetchIfUnloaded(): Promise<void> {
		if (this.highLeverageModeConfigAccountAndSlot === undefined) {
			await this.fetch();
		}
	}

	async fetch(): Promise<void> {
		try {
			const dataAndContext =
				await this.program.account.highLeverageModeConfig.fetchAndContext(
					this.highLeverageModeConfigAccountPublicKey,
					this.accountLoader.commitment
				);
			if (
				dataAndContext.context.slot >
				(this.highLeverageModeConfigAccountAndSlot?.slot ?? 0)
			) {
				this.highLeverageModeConfigAccountAndSlot = {
					data: dataAndContext.data as HighLeverageModeConfig,
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			console.log(
				`PollingHighLeverageModeConfigAccountSubscriber.fetch() HighLeverageModeConfig does not exist: ${e.message}`
			);
		}
	}

	doesAccountExist(): boolean {
		return this.highLeverageModeConfigAccountAndSlot !== undefined;
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		this.accountLoader.removeAccount(
			this.highLeverageModeConfigAccountPublicKey,
			this.callbackId
		);
		this.callbackId = undefined;

		this.accountLoader.removeErrorCallbacks(this.errorCallbackId);
		this.errorCallbackId = undefined;

		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getHighLeverageModeConfigAccountAndSlot(): DataAndSlot<HighLeverageModeConfig> {
		this.assertIsSubscribed();
		return this.highLeverageModeConfigAccountAndSlot;
	}

	didSubscriptionSucceed(): boolean {
		return !!this.highLeverageModeConfigAccountAndSlot;
	}

	public updateData(
		highLeverageModeConfig: HighLeverageModeConfig,
		slot: number
	): void {
		if (
			!this.highLeverageModeConfigAccountAndSlot ||
			this.highLeverageModeConfigAccountAndSlot.slot < slot
		) {
			this.highLeverageModeConfigAccountAndSlot = {
				data: highLeverageModeConfig,
				slot,
			};
			this.eventEmitter.emit(
				'highLeverageModeConfigAccountUpdate',
				highLeverageModeConfig
			);
			this.eventEmitter.emit('update');
		}
	}
}
