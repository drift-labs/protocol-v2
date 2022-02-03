import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';

type AccountToLoad = {
	publicKey: PublicKey;
	uses: number;
};

type AccountData = {
	slot: number;
	buffer: Buffer | undefined;
};

const GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE = 99;

export interface BulkAccountLoaderEvents {
	accountUpdate: (publicKey: PublicKey, buffer: Buffer) => void;
	error: (e: Error) => void;
}

export class BulkAccountLoader {
	connection: Connection;
	commitment: Commitment;
	pollingFrequency: number;
	eventEmitter: StrictEventEmitter<EventEmitter, BulkAccountLoaderEvents>;
	accountsToLoad = new Map<string, AccountToLoad>();
	accountData = new Map<string, AccountData>();
	intervalId?: NodeJS.Timer;

	public constructor(
		connection: Connection,
		commitment: Commitment,
		pollingFrequency: number
	) {
		this.connection = connection;
		this.commitment = commitment;
		this.pollingFrequency = pollingFrequency;
		this.eventEmitter = new EventEmitter();
	}

	public addAccount(publicKey: PublicKey): void {
		const existingSize = this.accountsToLoad.size;
		const existingAccountToLoad = this.accountsToLoad.get(publicKey.toString());
		const updatedAccountToLoad = {
			publicKey,
			uses: existingAccountToLoad ? existingAccountToLoad.uses + 1 : 1,
		};
		this.accountsToLoad.set(publicKey.toString(), updatedAccountToLoad);

		if (existingSize === 0) {
			this.startPolling();
		}
	}

	public removeAccount(publicKey: PublicKey): void {
		const existingAccountToLoad = this.accountsToLoad.get(publicKey.toString());
		if (existingAccountToLoad) {
			if (existingAccountToLoad.uses > 1) {
				const updatedAccountToLoad = {
					publicKey,
					uses: existingAccountToLoad.uses - 1,
				};
				this.accountsToLoad.set(
					existingAccountToLoad.publicKey.toString(),
					updatedAccountToLoad
				);
			} else {
				this.accountsToLoad.delete(existingAccountToLoad.publicKey.toString());
			}
		}

		if (this.accountsToLoad.size === 0) {
			this.stopPolling();
		}
	}

	chunks<T>(array: readonly T[], size: number): T[][] {
		return new Array(Math.ceil(array.length / size))
			.fill(null)
			.map((_, index) => index * size)
			.map((begin) => array.slice(begin, begin + size));
	}

	public async load(): Promise<void> {
		const chunks = this.chunks(
			Array.from(this.accountsToLoad.values()),
			GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE
		);

		await Promise.all(
			chunks.map((chunk) => {
				return this.loadChunk(chunk);
			})
		);
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

		let rpcResponse;
		try {
			// @ts-ignore
			rpcResponse = await this.connection._rpcRequest(
				'getMultipleAccounts',
				args
			);
		} catch (e) {
			this.eventEmitter.emit('error', e);
			return;
		}

		const newSlot = rpcResponse.result.context.slot;

		for (const i in accountsToLoad) {
			const accountToLoad = accountsToLoad[i];
			const key = accountToLoad.publicKey.toString();
			const oldRPCResponse = this.accountData.get(key);

			let newBuffer: Buffer | undefined = undefined;
			if (rpcResponse.result.value[i]) {
				const raw: string = rpcResponse.result.value[i].data[0];
				const dataType = rpcResponse.result.value[i].data[1];
				newBuffer = Buffer.from(raw, dataType);
			}

			if (!oldRPCResponse) {
				this.accountData.set(key, {
					slot: newSlot,
					buffer: newBuffer,
				});
				this.eventEmitter.emit(
					'accountUpdate',
					accountToLoad.publicKey,
					newBuffer
				);
				continue;
			}

			if (newSlot <= oldRPCResponse.slot) {
				continue;
			}

			const oldBuffer = oldRPCResponse.buffer;
			if (newBuffer && (!oldBuffer || !newBuffer.equals(oldBuffer))) {
				this.accountData.set(key, {
					slot: newSlot,
					buffer: newBuffer,
				});
				this.eventEmitter.emit(
					'accountUpdate',
					accountToLoad.publicKey,
					newBuffer
				);
			}
		}
	}

	public getAccountData(publicKey: PublicKey): Buffer | undefined {
		const accountData = this.accountData.get(publicKey.toString());
		return accountData?.buffer;
	}

	public startPolling(): void {
		if (this.intervalId) {
			return;
		}

		this.intervalId = setInterval(this.load.bind(this), this.pollingFrequency);
	}

	public stopPolling(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
