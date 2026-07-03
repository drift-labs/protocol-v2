import { BufferAndSlot, ProgramAccountSubscriber, ResubOpts } from './types';
import { AnchorProvider } from '../isomorphic/anchor';
import {
	Commitment,
	Context,
	KeyedAccountInfo,
	MemcmpFilter,
	PublicKey,
} from '@solana/web3.js';
import { VelocityProgram } from '../config';
import * as Buffer from 'buffer';

/**
 * Default `ProgramAccountSubscriber` implementation: tracks every account owned by the program
 * (optionally narrowed by `options.filters`) via `connection.onProgramAccountChange`, decoding
 * each notification with `decodeBufferFn`. Maintains a per-account (not single, unlike
 * `WebSocketAccountSubscriber`) `bufferAndSlotMap`, since one program subscription covers many
 * accounts; updates are applied per-account only when the notification's slot is not older than
 * that account's last-seen slot and its buffer actually changed. If `resubOpts.resubTimeoutMs`
 * is set, a watchdog timer resubscribes the whole program subscription whenever no notification
 * (for *any* account) arrives within that window. This is the base class extended by
 * `grpcProgramAccountSubscriber` and `LaserstreamProgramAccountSubscriber` for gRPC Geyser-backed
 * tracking.
 */
export class WebSocketProgramAccountSubscriber<T>
	implements ProgramAccountSubscriber<T>
{
	subscriptionName: string;
	accountDiscriminator: string;
	bufferAndSlot?: BufferAndSlot;
	bufferAndSlotMap: Map<string, BufferAndSlot> = new Map();
	program: VelocityProgram;
	decodeBuffer: (accountName: string, ix: Buffer) => T;
	private _onChange?: (
		accountId: PublicKey,
		data: T,
		context: Context,
		buffer: Buffer
	) => void;
	get onChange(): (
		accountId: PublicKey,
		data: T,
		context: Context,
		buffer: Buffer
	) => void {
		if (!this._onChange) {
			throw new Error('onChange callback function must be set');
		}
		return this._onChange;
	}
	set onChange(
		onChange: (
			accountId: PublicKey,
			data: T,
			context: Context,
			buffer: Buffer
		) => void
	) {
		this._onChange = onChange;
	}
	listenerId?: number;
	resubOpts?: ResubOpts;
	isUnsubscribing = false;
	timeoutId?: ReturnType<typeof setTimeout>;
	options: { filters: MemcmpFilter[]; commitment?: Commitment };

	receivingData = false;

	/**
	 * @param subscriptionName Human-readable name for logging.
	 * @param accountDiscriminator Anchor account type name passed to `decodeBufferFn` for each update.
	 * @param program Anchor program whose accounts to watch (filtered to `program.programId` as owner).
	 * @param decodeBufferFn Decode function for each account's raw buffer.
	 * @param options `filters` narrowing which program accounts are watched (empty watches every account owned by the program); `commitment` for the subscription, defaulting to the provider's configured commitment.
	 * @param resubOpts Resubscription watchdog options; omit to disable the inactivity timer.
	 */
	public constructor(
		subscriptionName: string,
		accountDiscriminator: string,
		program: VelocityProgram,
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
		if (
			this.resubOpts?.resubTimeoutMs != null &&
			this.resubOpts.resubTimeoutMs < 1000
		) {
			console.log(
				'resubTimeoutMs should be at least 1000ms to avoid spamming resub'
			);
		}
		this.options = options;
		this.receivingData = false;
	}

	/**
	 * Attaches the `onProgramAccountChange` WebSocket listener. Idempotent: a no-op if already
	 * subscribed or mid-unsubscribe. Does not perform an initial fetch of matching accounts — the
	 * caller must fetch any pre-existing accounts separately if needed.
	 * @param onChange Invoked once per changed account with its pubkey, decoded data, the notification's `Context`, and the raw buffer.
	 */
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
		if (!this._onChange) {
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

	/**
	 * Applies a raw notification for one account within the program subscription: decodes and
	 * stores it (updating that account's entry in `bufferAndSlotMap` and invoking `onChange`) only
	 * if the slot is not older than the cached one for that specific account and the buffer's
	 * bytes actually changed (or this is the first observation of that account).
	 */
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

	/**
	 * Tears down the `onProgramAccountChange` listener and cancels any pending resub timeout.
	 * @param onResub Internal flag set to `true` when called as part of an automatic resubscribe cycle, which preserves `resubOpts.resubTimeoutMs` instead of clearing it. Callers should omit this.
	 */
	unsubscribe(onResub = false): Promise<void> {
		if (!onResub && this.resubOpts) {
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
			return Promise.resolve();
		}
	}
}
