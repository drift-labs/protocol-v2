import {
	NotSubscribedError,
	ConstituentAccountEvents,
	ConstituentAccountSubscriber,
} from '../accounts/types';
import { VelocityProgram } from '../config';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { Commitment, Context, MemcmpFilter, PublicKey } from '@solana/web3.js';
import { ConstituentAccount } from '../types';
import { WebSocketProgramAccountSubscriber } from '../accounts/webSocketProgramAccountSubscriber';
import { getConstituentFilter } from '../memcmp';
import { ConstituentMap } from './constituentMap';

export class WebSocketConstituentAccountSubscriber
	implements ConstituentAccountSubscriber
{
	isSubscribed: boolean;
	resubTimeoutMs?: number;
	commitment?: Commitment;
	program: VelocityProgram;
	eventEmitter: StrictEventEmitter<EventEmitter, ConstituentAccountEvents>;

	private _constituentDataAccountSubscriber?: WebSocketProgramAccountSubscriber<ConstituentAccount>;
	private get constituentDataAccountSubscriber(): WebSocketProgramAccountSubscriber<ConstituentAccount> {
		if (!this._constituentDataAccountSubscriber) {
			throw new Error(
				'WebSocketConstituentAccountSubscriber: constituentDataAccountSubscriber accessed before subscribe()'
			);
		}
		return this._constituentDataAccountSubscriber;
	}
	constituentMap: ConstituentMap;
	private additionalFilters?: MemcmpFilter[];

	public constructor(
		constituentMap: ConstituentMap,
		program: VelocityProgram,
		resubTimeoutMs?: number,
		commitment?: Commitment,
		additionalFilters?: MemcmpFilter[]
	) {
		this.constituentMap = constituentMap;
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.resubTimeoutMs = resubTimeoutMs;
		this.commitment = commitment;
		this.additionalFilters = additionalFilters;
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}
		this._constituentDataAccountSubscriber =
			new WebSocketProgramAccountSubscriber<ConstituentAccount>(
				'LpPoolConstituent',
				'constituent',
				this.program,
				(this.program.account as any).constituent.coder.accounts.decode.bind(
					(this.program.account as any).constituent.coder.accounts
				),
				{
					filters: [getConstituentFilter(), ...(this.additionalFilters || [])],
					commitment: this.commitment,
				}
			);

		await this.constituentDataAccountSubscriber.subscribe(
			(accountId: PublicKey, account: ConstituentAccount, context: Context) => {
				this.constituentMap.updateConstituentAccount(
					accountId.toBase58(),
					account,
					context.slot
				);
				this.eventEmitter.emit(
					'onAccountUpdate',
					account,
					accountId,
					context.slot
				);
			}
		);

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	async sync(): Promise<void> {
		try {
			await this.constituentMap.sync();
			this.eventEmitter.emit('update');
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			console.log(
				`WebSocketConstituentAccountSubscriber.sync() error: ${err.message}`
			);
			this.eventEmitter.emit('error', err);
		}
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([this.constituentDataAccountSubscriber.unsubscribe()]);

		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}
}
