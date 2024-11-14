import { BufferAndSlot, ProgramAccountSubscriber, ResubOpts } from './types';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import {
	Commitment,
	Context,
	KeyedAccountInfo,
	MemcmpFilter,
	PublicKey,
} from '@solana/web3.js';
import * as Buffer from 'buffer';

export class WebSocketProgramAccountSubscriber<T>
	implements ProgramAccountSubscriber<T>
{
	subscriptionName: string;
	accountDiscriminator: string;
	bufferAndSlot?: BufferAndSlot;
	bufferAndSlotMap: Map<string, BufferAndSlot> = new Map();
	program: Program;
	decodeBuffer: (accountName: string, ix: Buffer) => T;
	onChange: (
		accountId: PublicKey,
		data: T,
		context: Context,
		buffer: Buffer
	) => void;
	listenerId?: number;
	resubOpts?: ResubOpts;
	isUnsubscribing = false;
	timeoutId?: NodeJS.Timeout;
	options: { filters: MemcmpFilter[]; commitment?: Commitment };

	receivingData = false;

	public constructor(
		subscriptionName: string,
		accountDiscriminator: string,
		program: Program,
		decodeBufferFn: (accountName: string, ix: Buffer) => T,
		options: { filters: MemcmpFilter[]; commitment?: Commitment } = {
			filters: [],
		},
		resubOpts?: ResubOpts
	) {
		this.subscriptionName = subscriptionName;
		this.accountDiscriminator = accountDiscriminator;
		this.program = program;
		this.decodeBuffer = decodeBufferFn;
		this.resubOpts = resubOpts;
		if (this.resubOpts?.resubTimeoutMs < 1000) {
			console.log(
				'resubTimeoutMs should be at least 1000ms to avoid spamming resub'
			);
		}
		this.options = options;
		this.receivingData = false;
	}

	async subscribe(
		onChange: (
			accountId: PublicKey,
			data: T,
			context: Context,
			buffer: Buffer
		) => void
	): Promise<void> {
		if (this.listenerId != null || this.isUnsubscribing) {
			return;
		}

		this.onChange = onChange;

		this.listenerId = this.program.provider.connection.onProgramAccountChange(
			this.program.programId,
			(keyedAccountInfo, context) => {
				if (this.resubOpts?.resubTimeoutMs) {
					this.receivingData = true;
					clearTimeout(this.timeoutId);
					this.handleRpcResponse(context, keyedAccountInfo);
					this.setTimeout();
				} else {
					this.handleRpcResponse(context, keyedAccountInfo);
				}
			},
			this.options.commitment ??
				(this.program.provider as AnchorProvider).opts.commitment,
			this.options.filters
		);

		if (this.resubOpts?.resubTimeoutMs) {
			this.receivingData = true;
			this.setTimeout();
		}
	}

	protected setTimeout(): void {
		if (!this.onChange) {
			throw new Error('onChange callback function must be set');
		}
		this.timeoutId = setTimeout(
			async () => {
				if (this.isUnsubscribing) {
					// If we are in the process of unsubscribing, do not attempt to resubscribe
					return;
				}

				if (this.receivingData) {
					if (this.resubOpts?.logResubMessages) {
						console.log(
							`No ws data from ${this.subscriptionName} in ${this.resubOpts?.resubTimeoutMs}ms, resubscribing`
						);
					}
					await this.unsubscribe(true);
					this.receivingData = false;
					await this.subscribe(this.onChange);
				}
			},
			this.resubOpts?.resubTimeoutMs
		);
	}

	handleRpcResponse(
		context: Context,
		keyedAccountInfo: KeyedAccountInfo
	): void {
		const newSlot = context.slot;
		let newBuffer: Buffer | undefined = undefined;
		if (keyedAccountInfo) {
			newBuffer = keyedAccountInfo.accountInfo.data;
		}

		const accountId = keyedAccountInfo.accountId.toBase58();
		const existingBufferAndSlot = this.bufferAndSlotMap.get(accountId);

		if (!existingBufferAndSlot) {
			if (newBuffer) {
				this.bufferAndSlotMap.set(accountId, {
					buffer: newBuffer,
					slot: newSlot,
				});
				const account = this.decodeBuffer(this.accountDiscriminator, newBuffer);
				this.onChange(keyedAccountInfo.accountId, account, context, newBuffer);
			}
			return;
		}

		if (newSlot < existingBufferAndSlot.slot) {
			return;
		}

		const oldBuffer = existingBufferAndSlot.buffer;
		if (newBuffer && (!oldBuffer || !newBuffer.equals(oldBuffer))) {
			this.bufferAndSlotMap.set(accountId, {
				buffer: newBuffer,
				slot: newSlot,
			});
			const account = this.decodeBuffer(this.accountDiscriminator, newBuffer);
			this.onChange(keyedAccountInfo.accountId, account, context, newBuffer);
		}
	}

	unsubscribe(onResub = false): Promise<void> {
		if (!onResub) {
			this.resubOpts.resubTimeoutMs = undefined;
		}
		this.isUnsubscribing = true;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;

		if (this.listenerId != null) {
			const promise = this.program.provider.connection
				.removeAccountChangeListener(this.listenerId)
				.then(() => {
					this.listenerId = undefined;
					this.isUnsubscribing = false;
				});
			return promise;
		} else {
			this.isUnsubscribing = false;
		}
	}
}
