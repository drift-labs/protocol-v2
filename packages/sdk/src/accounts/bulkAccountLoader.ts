import { Commitment, PublicKey } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { BufferAndSlot } from './types';
import { promiseTimeout } from '../util/promiseTimeout';
import { Connection } from '../bankrun/bankrunConnection';
import { GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE } from '../constants/numericConstants';

/** An account registered with a `BulkAccountLoader`, along with every callback subscribed to its updates (keyed by callback id). */
export type AccountToLoad = {
	publicKey: PublicKey;
	callbacks: Map<string, (buffer: Buffer, slot: number) => void>;
};

const oneMinute = 60 * 1000;

/**
 * Batches many accounts behind a single periodic `getMultipleAccounts` RPC poll instead of one
 * WebSocket subscription per account. Multiple independent callbacks (e.g. from different
 * `PollingUserAccountSubscriber`/`PollingVelocityClientAccountSubscriber` instances) can register
 * against the same `publicKey`; polling starts automatically on the first `addAccount` and stops
 * when the last callback for the last account is removed. A buffer is only re-delivered to
 * callbacks when its slot is not older than the last-seen slot for that account and its bytes
 * actually changed, so a callback never observes a stale or duplicate update. `load()` calls are
 * coalesced: concurrent callers share one in-flight RPC batch rather than issuing redundant
 * requests.
 */
export class BulkAccountLoader {
	connection: Connection;
	commitment: Commitment;
	pollingFrequency: number;
	accountsToLoad = new Map<string, AccountToLoad>();
	bufferAndSlotMap = new Map<string, BufferAndSlot>();
	errorCallbacks = new Map<string, (e: Error) => void>();
	intervalId?: ReturnType<typeof setTimeout>;
	// to handle clients spamming load
	loadPromise?: Promise<void>;
	private loadPromiseResolver: () => void = () => {};
	lastTimeLoadingPromiseCleared = Date.now();
	mostRecentSlot = 0;

	/**
	 * @param connection Connection (or bankrun-compatible shim) used for the batched `getMultipleAccounts` polls.
	 * @param commitment Commitment level applied to every poll.
	 * @param pollingFrequency Poll interval in ms; `0` disables automatic polling (`startPolling` becomes a no-op), useful when the loader is driven manually via `load()`.
	 */
	public constructor(
		connection: Connection,
		commitment: Commitment,
		pollingFrequency: number
	) {
		this.connection = connection;
		this.commitment = commitment;
		this.pollingFrequency = pollingFrequency;
	}

	/**
	 * Registers a callback to be invoked whenever `publicKey`'s account data changes on a poll.
	 * Multiple callbacks may be registered for the same account. Starts polling automatically if
	 * this is the loader's first account. Awaits any in-flight `load()` before returning so a
	 * caller can immediately follow with its own `load()` without racing the poll interval.
	 * @param publicKey Account to track.
	 * @param callback Invoked with the raw account buffer and the slot it was fetched at whenever the buffer changes at a non-decreasing slot.
	 * @returns A callback id to pass to `removeAccount` later.
	 */
	public async addAccount(
		publicKey: PublicKey,
		callback: (buffer: Buffer, slot: number) => void
	): Promise<string> {
		if (!publicKey) {
			console.trace(`Caught adding blank publickey to bulkAccountLoader`);
		}

		const existingSize = this.accountsToLoad.size;

		const callbackId = uuidv4();
		const existingAccountToLoad = this.accountsToLoad.get(publicKey.toString());
		if (existingAccountToLoad) {
			existingAccountToLoad.callbacks.set(callbackId, callback);
		} else {
			const callbacks = new Map<
				string,
				(buffer: Buffer, slot: number) => void
			>();
			callbacks.set(callbackId, callback);
			const newAccountToLoad = {
				publicKey,
				callbacks,
			};
			this.accountsToLoad.set(publicKey.toString(), newAccountToLoad);
		}

		if (existingSize === 0) {
			this.startPolling();
		}

		// resolve the current loadPromise in case client wants to call load
		await this.loadPromise;

		return callbackId;
	}

	/**
	 * Unregisters a callback previously returned by `addAccount`. Once an account has no
	 * remaining callbacks, its cached buffer/slot is dropped and it stops being polled; if no
	 * accounts remain at all, polling stops entirely. A no-op if `callbackId` is undefined.
	 * @param publicKey Account the callback was registered against.
	 * @param callbackId Id returned by `addAccount`.
	 */
	public removeAccount(
		publicKey: PublicKey,
		callbackId: string | undefined
	): void {
		if (callbackId === undefined) {
			return;
		}
		const existingAccountToLoad = this.accountsToLoad.get(publicKey.toString());
		if (existingAccountToLoad) {
			existingAccountToLoad.callbacks.delete(callbackId);
			if (existingAccountToLoad.callbacks.size === 0) {
				this.bufferAndSlotMap.delete(publicKey.toString());
				this.accountsToLoad.delete(existingAccountToLoad.publicKey.toString());
			}
		}

		if (this.accountsToLoad.size === 0) {
			this.stopPolling();
		}
	}

	/**
	 * Registers a callback invoked whenever a `load()` batch throws (e.g. RPC failure or timeout).
	 * The loader continues polling afterward; errors do not stop the interval.
	 * @returns A callback id to pass to `removeErrorCallbacks` later.
	 */
	public addErrorCallbacks(callback: (error: Error) => void): string {
		const callbackId = uuidv4();
		this.errorCallbacks.set(callbackId, callback);
		return callbackId;
	}

	/** Unregisters an error callback previously returned by `addErrorCallbacks`. A no-op if `callbackId` is undefined. */
	public removeErrorCallbacks(callbackId: string | undefined): void {
		if (callbackId === undefined) {
			return;
		}
		this.errorCallbacks.delete(callbackId);
	}

	chunks<T>(array: readonly T[], size: number): T[][] {
		return new Array(Math.ceil(array.length / size))
			.fill(null)
			.map((_, index) => index * size)
			.map((begin) => array.slice(begin, begin + size));
	}

	/**
	 * Fetches every registered account in one or more chunked, concurrent `getMultipleAccounts`
	 * batches (via `loadChunk`) and dispatches changed accounts to their callbacks. Concurrent
	 * calls while a load is already in flight share that same in-flight promise rather than
	 * issuing a duplicate RPC batch, unless the previous load has been running for over a minute
	 * (treated as stuck and restarted). On failure, invokes every registered error callback
	 * instead of throwing.
	 */
	public async load(): Promise<void> {
		if (this.loadPromise) {
			const now = Date.now();
			if (now - this.lastTimeLoadingPromiseCleared > oneMinute) {
				this.loadPromise = undefined;
			} else {
				return this.loadPromise;
			}
		}

		this.loadPromise = new Promise((resolver) => {
			this.loadPromiseResolver = resolver;
		});
		this.lastTimeLoadingPromiseCleared = Date.now();

		try {
			const chunks = this.chunks(
				this.chunks(
					Array.from(this.accountsToLoad.values()),
					GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE
				),
				10
			);

			await Promise.all(
				chunks.map((chunk) => {
					return this.loadChunk(chunk);
				})
			);
		} catch (e) {
			console.error(`Error in bulkAccountLoader.load()`);
			console.error(e);
			const error = e instanceof Error ? e : new Error(String(e));
			for (const [_, callback] of this.errorCallbacks) {
				callback(error);
			}
		} finally {
			this.loadPromiseResolver();
			this.loadPromise = undefined;
		}
	}

	async loadChunk(accountsToLoadChunks: AccountToLoad[][]): Promise<void> {
		if (accountsToLoadChunks.length === 0) {
			return;
		}

		const requests = new Array<{ methodName: string; args: any }>();
		for (const accountsToLoadChunk of accountsToLoadChunks) {
			const args = [
				accountsToLoadChunk
					.filter((accountToLoad) => accountToLoad.callbacks.size > 0)
					.map((accountToLoad) => {
						return accountToLoad.publicKey.toBase58();
					}),
				{ commitment: this.commitment },
			];

			requests.push({
				methodName: 'getMultipleAccounts',
				args,
			});
		}

		const rpcResponses: any | null = await promiseTimeout(
			// @ts-ignore
			this.connection._rpcBatchRequest(requests),
			10 * 1000 // 30 second timeout
		);

		if (rpcResponses === null) {
			this.log('request to rpc timed out');
			return;
		}

		rpcResponses.forEach((rpcResponse: any, i: number) => {
			if (!rpcResponse.result) {
				console.error('rpc response missing result:');
				console.log(JSON.stringify(rpcResponse));
				return;
			}
			const newSlot = rpcResponse.result.context.slot;

			if (newSlot > this.mostRecentSlot) {
				this.mostRecentSlot = newSlot;
			}

			const accountsToLoad = accountsToLoadChunks[i];
			accountsToLoad.forEach((accountToLoad, j) => {
				if (accountToLoad.callbacks.size === 0) {
					return;
				}

				const key = accountToLoad.publicKey.toBase58();
				const oldRPCResponse = this.bufferAndSlotMap.get(key);

				if (oldRPCResponse && newSlot < oldRPCResponse.slot) {
					return;
				}

				let newBuffer: Buffer | undefined = undefined;
				if (rpcResponse.result.value[j]) {
					const raw: string = rpcResponse.result.value[j].data[0];
					const dataType = rpcResponse.result.value[j].data[1];
					newBuffer = Buffer.from(raw, dataType);
				}

				if (!oldRPCResponse) {
					this.bufferAndSlotMap.set(key, {
						slot: newSlot,
						buffer: newBuffer,
					});
					this.handleAccountCallbacks(accountToLoad, newBuffer, newSlot);
					return;
				}

				const oldBuffer = oldRPCResponse.buffer;
				if (newBuffer && (!oldBuffer || !newBuffer.equals(oldBuffer))) {
					this.bufferAndSlotMap.set(key, {
						slot: newSlot,
						buffer: newBuffer,
					});
					this.handleAccountCallbacks(accountToLoad, newBuffer, newSlot);
				}
			});
		});
	}

	handleAccountCallbacks(
		accountToLoad: AccountToLoad,
		buffer: Buffer | undefined,
		slot: number
	): void {
		if (buffer === undefined) {
			return;
		}
		for (const [_, callback] of accountToLoad.callbacks) {
			try {
				callback(buffer, slot);
			} catch (e) {
				console.log('Bulk account load: error in account callback');
				console.log('accounto to load', accountToLoad.publicKey.toString());
				console.log('buffer', buffer.toString('base64'));
				for (const callback of accountToLoad.callbacks.values()) {
					console.log('account to load cb', callback);
				}
				throw e;
			}
		}
	}

	/** Returns the last-fetched raw buffer/slot for `publicKey`, or undefined if it has never been loaded. */
	public getBufferAndSlot(publicKey: PublicKey): BufferAndSlot | undefined {
		return this.bufferAndSlotMap.get(publicKey.toString());
	}

	/** Returns the highest slot number observed across any account fetched by this loader so far. */
	public getSlot(): number {
		return this.mostRecentSlot;
	}

	/** Starts the polling interval if not already running and `pollingFrequency !== 0`. Called automatically by `addAccount`. */
	public startPolling(): void {
		if (this.intervalId) {
			return;
		}

		if (this.pollingFrequency !== 0)
			this.intervalId = setInterval(
				this.load.bind(this),
				this.pollingFrequency
			);
	}

	/** Stops the polling interval, if running. Called automatically by `removeAccount` once no accounts remain. */
	public stopPolling(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}

	public log(msg: string): void {
		console.log(msg);
	}

	/** Restarts polling at a new interval (ms), preserving all registered accounts and callbacks. */
	public updatePollingFrequency(pollingFrequency: number): void {
		this.stopPolling();
		this.pollingFrequency = pollingFrequency;
		if (this.accountsToLoad.size > 0) {
			this.startPolling();
		}
	}
}
