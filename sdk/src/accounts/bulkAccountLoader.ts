import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { BufferAndSlot } from './types';
import { promiseTimeout } from '../util/promiseTimeout';
import {
	E_ALREADY_LOCKED,
	Mutex,
	MutexInterface,
	tryAcquire,
} from 'async-mutex';

type AccountToLoad = {
	publicKey: PublicKey;
	callbacks: Map<string, (buffer: Buffer, slot: number) => void>;
};

const GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE = 99;

export class BulkAccountLoader {
	connection: Connection;
	commitment: Commitment;
	pollingFrequency: number;
	accountsToLoad = new Map<string, AccountToLoad>();
	bufferAndSlotMap = new Map<string, BufferAndSlot>();
	errorCallbacks = new Map<string, (e) => void>();
	intervalId?: NodeJS.Timer;
	loadLock: Mutex = new Mutex();
	mostRecentSlot = 0;

	public constructor(
		connection: Connection,
		commitment: Commitment,
		pollingFrequency: number
	) {
		this.connection = connection;
		this.commitment = commitment;
		this.pollingFrequency = pollingFrequency;
	}

	public addAccount(
		publicKey: PublicKey,
		callback: (buffer: Buffer, slot: number) => void
	): string {
		console.log(`ADDING ACCOUNT: ${publicKey.toString()}`);
		const existingSize = this.accountsToLoad.size;

		const callbackId = uuidv4();
		const existingAccountToLoad = this.accountsToLoad.get(publicKey.toString());
		if (existingAccountToLoad) {
			existingAccountToLoad.callbacks.set(callbackId, callback);
			console.log(` . exists: ${publicKey.toString()}`);
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
			console.log(` . added: ${publicKey.toString()}`);
		}

		if (existingSize === 0) {
			this.startPolling();
		}

		return callbackId;
	}

	public removeAccount(publicKey: PublicKey, callbackId: string): void {
		const existingAccountToLoad = this.accountsToLoad.get(publicKey.toString());
		if (existingAccountToLoad) {
			existingAccountToLoad.callbacks.delete(callbackId);
			if (existingAccountToLoad.callbacks.size === 0) {
				this.accountsToLoad.delete(existingAccountToLoad.publicKey.toString());
			}
		}

		if (this.accountsToLoad.size === 0) {
			this.stopPolling();
		}
	}

	public addErrorCallbacks(callback: (error: Error) => void): string {
		const callbackId = uuidv4();
		this.errorCallbacks.set(callbackId, callback);
		return callbackId;
	}

	public removeErrorCallbacks(callbackId: string): void {
		this.errorCallbacks.delete(callbackId);
	}

	chunks<T>(array: readonly T[], size: number): T[][] {
		return new Array(Math.ceil(array.length / size))
			.fill(null)
			.map((_, index) => index * size)
			.map((begin) => array.slice(begin, begin + size));
	}

	public async load(mustSucceed = false): Promise<boolean> {
		let lockReleaser: MutexInterface.Releaser;
		let didGetLock = false;
		let successfulLoad = false;
		if (mustSucceed) {
			const start = Date.now();
			lockReleaser = await this.loadLock.acquire();
			didGetLock = true;
			console.log(`loadPromiseLock acquired in ${Date.now() - start}ms`);
			try {
				throw new Error(`Got lock, stack:`);
			} catch (e) {
				console.log(e.stack);
			}
		} else {
			try {
				lockReleaser = await tryAcquire(this.loadLock).acquire();
				didGetLock = true;
			} catch (e) {
				if (e === E_ALREADY_LOCKED) {
					console.warn('loadPromiseLock already taken, skipping load');
					try {
						throw new Error(`Skipped lock, stack:`);
					} catch (e) {
						console.log(e.stack);
					}
					return false;
				}
			}
		}

		if (didGetLock) {
			try {
				const chunks = this.chunks(
					Array.from(this.accountsToLoad.values()),
					GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE
				);

				await Promise.all(
					chunks.map((chunk) => {
						return this.loadChunk(chunk);
					})
				);

				successfulLoad = true;
			} catch (e) {
				console.error(`Error in bulkAccountLoader.load()`);
				console.error(e);
				for (const [_, callback] of this.errorCallbacks) {
					callback(e);
				}
			} finally {
				lockReleaser();
			}
		}

		return successfulLoad;
	}

	async loadChunk(accountsToLoad: AccountToLoad[]): Promise<void> {
		if (accountsToLoad.length === 0) {
			return;
		}

		const args = [
			accountsToLoad.map((accountToLoad) => {
				return accountToLoad.publicKey.toBase58();
			}),
			{ commitment: this.commitment },
		];

		const rpcResponse: any | null = await promiseTimeout(
			// @ts-ignore
			this.connection._rpcRequest('getMultipleAccounts', args),
			10 * 1000 // 30 second timeout
		);

		if (rpcResponse === null) {
			this.log('request to rpc timed out');
			return;
		}

		const newSlot = rpcResponse.result.context.slot;

		if (newSlot > this.mostRecentSlot) {
			this.mostRecentSlot = newSlot;
		}

		for (const i in accountsToLoad) {
			const accountToLoad = accountsToLoad[i];
			const key = accountToLoad.publicKey.toString();
			const oldRPCResponse = this.bufferAndSlotMap.get(key);

			let newBuffer: Buffer | undefined = undefined;
			if (rpcResponse.result.value[i]) {
				const raw: string = rpcResponse.result.value[i].data[0];
				const dataType = rpcResponse.result.value[i].data[1];
				newBuffer = Buffer.from(raw, dataType);
			}

			if (!oldRPCResponse) {
				this.bufferAndSlotMap.set(key, {
					slot: newSlot,
					buffer: newBuffer,
				});
				this.handleAccountCallbacks(accountToLoad, newBuffer, newSlot);
				continue;
			}

			if (newSlot <= oldRPCResponse.slot) {
				continue;
			}

			const oldBuffer = oldRPCResponse.buffer;
			if (newBuffer && (!oldBuffer || !newBuffer.equals(oldBuffer))) {
				this.bufferAndSlotMap.set(key, {
					slot: newSlot,
					buffer: newBuffer,
				});
				this.handleAccountCallbacks(accountToLoad, newBuffer, newSlot);
			}
		}
	}

	handleAccountCallbacks(
		accountToLoad: AccountToLoad,
		buffer: Buffer,
		slot: number
	): void {
		for (const [_, callback] of accountToLoad.callbacks) {
			callback(buffer, slot);
		}
	}

	public getBufferAndSlot(publicKey: PublicKey): BufferAndSlot | undefined {
		return this.bufferAndSlotMap.get(publicKey.toString());
	}

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

	public stopPolling(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}

	public log(msg: string): void {
		console.log(msg);
	}

	public updatePollingFrequency(pollingFrequency: number): void {
		this.stopPolling();
		this.pollingFrequency = pollingFrequency;
		if (this.accountsToLoad.size > 0) {
			this.startPolling();
		}
	}
}
