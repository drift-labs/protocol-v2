import {
	DataAndSlot,
	AccountSubscriber,
	NotSubscribedError,
	HighLeverageModeConfigAccountEvents,
	HighLeverageModeConfigAccountSubscriber,
} from './types';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Commitment, PublicKey } from '@solana/web3.js';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { HighLeverageModeConfig } from '../types';

export class WebSocketHighLeverageModeConfigAccountSubscriber
	implements HighLeverageModeConfigAccountSubscriber
{
	isSubscribed: boolean;
	resubTimeoutMs?: number;
	commitment?: Commitment;
	program: Program;
	eventEmitter: StrictEventEmitter<
		EventEmitter,
		HighLeverageModeConfigAccountEvents
	>;
	highLeverageModeConfigAccountPublicKey: PublicKey;

	highLeverageModeConfigDataAccountSubscriber: AccountSubscriber<HighLeverageModeConfig>;

	public constructor(
		program: Program,
		highLeverageModeConfigAccountPublicKey: PublicKey,
		resubTimeoutMs?: number,
		commitment?: Commitment
	) {
		this.isSubscribed = false;
		this.program = program;
		this.highLeverageModeConfigAccountPublicKey =
			highLeverageModeConfigAccountPublicKey;
		this.eventEmitter = new EventEmitter();
		this.resubTimeoutMs = resubTimeoutMs;
		this.commitment = commitment;
	}

	async subscribe(
		highLeverageModeConfigAccount?: HighLeverageModeConfig
	): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		this.highLeverageModeConfigDataAccountSubscriber =
			new WebSocketAccountSubscriber(
				'highLeverageModeConfig',
				this.program,
				this.highLeverageModeConfigAccountPublicKey,
				undefined,
				{
					resubTimeoutMs: this.resubTimeoutMs,
				},
				this.commitment
			);

		if (highLeverageModeConfigAccount) {
			this.highLeverageModeConfigDataAccountSubscriber.setData(
				highLeverageModeConfigAccount
			);
		}

		await this.highLeverageModeConfigDataAccountSubscriber.subscribe(
			(data: HighLeverageModeConfig) => {
				this.eventEmitter.emit('highLeverageModeConfigAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	async fetch(): Promise<void> {
		await Promise.all([
			this.highLeverageModeConfigDataAccountSubscriber.fetch(),
		]);
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([
			this.highLeverageModeConfigDataAccountSubscriber.unsubscribe(),
		]);

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
		return this.highLeverageModeConfigDataAccountSubscriber.dataAndSlot;
	}

	public updateData(
		highLeverageModeConfig: HighLeverageModeConfig,
		slot: number
	): void {
		const currentDataSlot =
			this.highLeverageModeConfigDataAccountSubscriber.dataAndSlot?.slot || 0;
		if (currentDataSlot <= slot) {
			this.highLeverageModeConfigDataAccountSubscriber.setData(
				highLeverageModeConfig,
				slot
			);
			this.eventEmitter.emit(
				'highLeverageModeConfigAccountUpdate',
				highLeverageModeConfig
			);
			this.eventEmitter.emit('update');
		}
	}
}
