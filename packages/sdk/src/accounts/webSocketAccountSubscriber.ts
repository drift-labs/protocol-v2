import {
	DataAndSlot,
	BufferAndSlot,
	AccountSubscriber,
	ResubOpts,
} from './types';
import { AnchorProvider } from '../isomorphic/anchor';
import { AccountInfo, Commitment, Context, PublicKey } from '@solana/web3.js';
import { VelocityProgram } from '../config';
import * as Buffer from 'buffer';

/**
 * Default `AccountSubscriber` implementation: tracks a single account via
 * `connection.onAccountChange`, decoding each notification with either a supplied
 * `decodeBuffer` function or the program's Anchor coder for `accountName`. Updates are applied
 * only when the notification's slot is not older than the last-seen slot and the raw buffer
 * actually changed, so `onChange` never fires twice for the same bytes. If `resubOpts.resubTimeoutMs`
 * is set, a watchdog timer resubscribes to the WebSocket whenever no notification arrives within
 * that window — see `ResubOpts` for tuning. This is the base class extended by
 * `grpcAccountSubscriber` for gRPC Geyser-backed tracking.
 */
export class WebSocketAccountSubscriber<T> implements AccountSubscriber<T> {
	dataAndSlot?: DataAndSlot<T>;
	bufferAndSlot?: BufferAndSlot;
	accountName: string;
	logAccountName: string;
	program: VelocityProgram;
	accountPublicKey: PublicKey;
	decodeBufferFn?: (buffer: Buffer) => T;
	private _onChange?: (data: T) => void;
	get onChange(): (data: T) => void {
		if (!this._onChange) {
			throw new Error('onChange callback function must be set');
		}
		return this._onChange;
	}
	set onChange(onChange: (data: T) => void) {
		this._onChange = onChange;
	}
	listenerId?: number;

	resubOpts?: ResubOpts;

	commitment?: Commitment;
	isUnsubscribing = false;

	timeoutId?: ReturnType<typeof setTimeout>;

	receivingData: boolean;

	/**
	 * @param accountName Anchor account type name (used for logging and, absent `decodeBuffer`, for decoding via the program coder).
	 * @param program Anchor program providing the connection and coder.
	 * @param accountPublicKey Address of the account to track.
	 * @param decodeBuffer Optional custom decode function; defaults to `program.coder.accounts.decode(accountName, buffer)`.
	 * @param resubOpts Resubscription watchdog options; omit to disable the inactivity timer.
	 * @param commitment Commitment for both the initial fetch and the `onAccountChange` subscription; defaults to the provider's configured commitment.
	 */
	public constructor(
		accountName: string,
		program: VelocityProgram,
		accountPublicKey: PublicKey,
		decodeBuffer?: (buffer: Buffer) => T,
		resubOpts?: ResubOpts,
		commitment?: Commitment
	) {
		this.accountName = accountName;
		this.logAccountName = `${accountName}-${accountPublicKey.toBase58()}`;
		this.program = program;
		this.accountPublicKey = accountPublicKey;
		this.decodeBufferFn = decodeBuffer;
		this.resubOpts = resubOpts;
		if (
			this.resubOpts?.resubTimeoutMs != null &&
			this.resubOpts.resubTimeoutMs < 1000
		) {
			console.log(
				`resubTimeoutMs should be at least 1000ms to avoid spamming resub ${this.logAccountName}`
			);
		}
		this.receivingData = false;
		this.commitment =
			commitment ?? (this.program.provider as AnchorProvider).opts.commitment;
	}

	/**
	 * Seeds `dataAndSlot` with an initial `fetch()` (if not already set via `setData`) and then
	 * attaches the `onAccountChange` WebSocket listener. Returning early (no-op) if already
	 * subscribed or mid-unsubscribe.
	 * @param onChange Invoked with the newly decoded account data on each accepted update.
	 */
	async subscribe(onChange: (data: T) => void): Promise<void> {
		if (this.listenerId != null || this.isUnsubscribing) {
			if (this.resubOpts?.logResubMessages) {
				console.log(
					`[${this.logAccountName}] Subscribe returning early - listenerId=${this.listenerId}, isUnsubscribing=${this.isUnsubscribing}`
				);
			}
			return;
		}

		this.onChange = onChange;
		if (!this.dataAndSlot) {
			await this.fetch();
		}

		this.listenerId = this.program.provider.connection.onAccountChange(
			this.accountPublicKey,
			(accountInfo, context) => {
				if (this.resubOpts?.resubTimeoutMs) {
					this.receivingData = true;
					clearTimeout(this.timeoutId);
					this.handleRpcResponse(context, accountInfo);
					this.setTimeout();
				} else {
					this.handleRpcResponse(context, accountInfo);
				}
			},
			this.commitment
		);

		if (this.resubOpts?.resubTimeoutMs) {
			this.receivingData = true;
			this.setTimeout();
		}
	}

	/**
	 * Seeds or overwrites `dataAndSlot` directly, bypassing RPC. A no-op if the currently cached
	 * slot is already newer than `slot`.
	 * @param data Decoded account data to store.
	 * @param slot Slot the data was observed at; defaults to 0 (the seeded sentinel) if omitted.
	 */
	setData(data: T, slot?: number): void {
		const newSlot = slot || 0;
		if (this.dataAndSlot && this.dataAndSlot.slot > newSlot) {
			return;
		}

		this.dataAndSlot = {
			data,
			slot: newSlot,
		};
	}

	protected setTimeout(): void {
		if (!this._onChange) {
			throw new Error('onChange callback function must be set');
		}
		this.timeoutId = setTimeout(
			async () => {
				if (this.isUnsubscribing) {
					// If we are in the process of unsubscribing, do not attempt to resubscribe
					if (this.resubOpts?.logResubMessages) {
						console.log(
							`[${this.logAccountName}] Timeout fired but isUnsubscribing=true, skipping resubscribe`
						);
					}
					return;
				}

				if (this.receivingData) {
					if (this.resubOpts?.logResubMessages) {
						console.log(
							`No ws data from ${this.logAccountName} in ${this.resubOpts.resubTimeoutMs}ms, resubscribing - listenerId=${this.listenerId}, isUnsubscribing=${this.isUnsubscribing}`
						);
					}
					await this.unsubscribe(true);
					this.receivingData = false;
					await this.subscribe(this.onChange);
					if (this.resubOpts?.logResubMessages) {
						console.log(
							`[${this.logAccountName}] Resubscribe completed - receivingData=${this.receivingData}, listenerId=${this.listenerId}, isUnsubscribing=${this.isUnsubscribing}`
						);
					}
				} else {
					if (this.resubOpts?.logResubMessages) {
						console.log(
							`[${this.logAccountName}] Timeout fired but receivingData=false, skipping resubscribe`
						);
					}
				}
			},
			this.resubOpts?.resubTimeoutMs
		);
	}

	/** Fetches the account once via `getAccountInfoAndContext` and routes the result through `handleRpcResponse`, applying it if newer than the cached slot. */
	async fetch(): Promise<void> {
		const rpcResponse =
			await this.program.provider.connection.getAccountInfoAndContext(
				this.accountPublicKey,
				(this.program.provider as AnchorProvider).opts.commitment
			);
		this.handleRpcResponse(
			rpcResponse.context,
			rpcResponse?.value ?? undefined
		);
	}

	/**
	 * Applies a raw RPC/WS response: decodes and stores it (updating `bufferAndSlot`/`dataAndSlot`
	 * and invoking `onChange`) only if the slot is not older than the cached one and the buffer's
	 * bytes actually changed (or this is the first observation).
	 */
	handleRpcResponse(context: Context, accountInfo?: AccountInfo<Buffer>): void {
		const newSlot = context.slot;
		let newBuffer: Buffer | undefined = undefined;
		if (accountInfo) {
			newBuffer = accountInfo.data;
		}

		if (!this.bufferAndSlot) {
			this.bufferAndSlot = {
				buffer: newBuffer,
				slot: newSlot,
			};
			if (newBuffer) {
				const account = this.decodeBuffer(newBuffer);
				this.dataAndSlot = {
					data: account,
					slot: newSlot,
				};
				this.onChange(account);
			}
			return;
		}

		if (newSlot < this.bufferAndSlot.slot) {
			return;
		}

		const oldBuffer = this.bufferAndSlot.buffer;
		if (newBuffer && (!oldBuffer || !newBuffer.equals(oldBuffer))) {
			this.bufferAndSlot = {
				buffer: newBuffer,
				slot: newSlot,
			};
			const account = this.decodeBuffer(newBuffer);
			this.dataAndSlot = {
				data: account,
				slot: newSlot,
			};
			this.onChange(account);
		}
	}

	/** Decodes a raw account buffer using the constructor-supplied `decodeBufferFn`, or the program's Anchor coder for `accountName` if none was supplied. */
	decodeBuffer(buffer: Buffer): T {
		if (this.decodeBufferFn) {
			return this.decodeBufferFn(buffer);
		} else {
			return this.program.coder.accounts.decode(this.accountName, buffer);
		}
	}

	/**
	 * Tears down the WebSocket listener and cancels any pending resub timeout.
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
			const promise = Promise.race([
				this.program.provider.connection.removeAccountChangeListener(
					this.listenerId
				),
				new Promise((_, reject) =>
					setTimeout(
						() =>
							reject(
								new Error(
									`Unsubscribe timeout for account ${this.logAccountName}`
								)
							),
						10000
					)
				),
			])
				.then(() => {
					this.listenerId = undefined;
					this.isUnsubscribing = false;
				})
				.catch((error) => {
					console.error(
						`[${this.logAccountName}] Unsubscribe failed, forcing cleanup - listenerId=${this.listenerId}, isUnsubscribing=${this.isUnsubscribing}`,
						error
					);
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
