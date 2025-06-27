import {
	Commitment,
	MemcmpFilter,
	PublicKey,
	RpcResponseAndContext,
} from '@solana/web3.js';
import { ConstituentAccountSubscriber, DataAndSlot } from '../accounts/types';
import { ConstituentAccount } from '../types';
import { PollingConstituentAccountSubscriber } from './pollingConstituentAccountSubscriber';
import { WebSocketConstituentAccountSubscriber } from './webSocketConstituentAccountSubscriber';
import { DriftClient } from '../driftClient';
import { ProgramAccount } from '@coral-xyz/anchor';
import { getConstituentFilter } from '../memcmp';
import { ZSTDDecoder } from 'zstddec';

const MAX_CONSTITUENT_SIZE_BYTES = 272; // TODO: update this when account is finalized

export type ConstituentMapConfig = {
	driftClient: DriftClient;
	subscriptionConfig:
		| {
				type: 'polling';
				frequency: number;
				commitment?: Commitment;
		  }
		| {
				type: 'websocket';
				resubTimeoutMs?: number;
				logResubMessages?: boolean;
				commitment?: Commitment;
		  };
	// potentially use these to filter Constituent accounts
	additionalFilters?: MemcmpFilter[];
};

export interface ConstituentMapInterface {
	subscribe(): Promise<void>;
	unsubscribe(): Promise<void>;
	has(key: string): boolean;
	get(key: string): ConstituentAccount | undefined;
	getWithSlot(key: string): DataAndSlot<ConstituentAccount> | undefined;
	mustGet(key: string): Promise<ConstituentAccount>;
	mustGetWithSlot(key: string): Promise<DataAndSlot<ConstituentAccount>>;
}

export class ConstituentMap implements ConstituentMapInterface {
	private driftClient: DriftClient;
	private constituentMap = new Map<string, DataAndSlot<ConstituentAccount>>();
	private constituentAccountSubscriber: ConstituentAccountSubscriber;
	private additionalFilters?: MemcmpFilter[];
	private commitment?: Commitment;

	constructor(config: ConstituentMapConfig) {
		this.driftClient = config.driftClient;
		this.additionalFilters = config.additionalFilters;
		this.commitment = config.subscriptionConfig.commitment;

		if (config.subscriptionConfig.type === 'polling') {
			this.constituentAccountSubscriber =
				new PollingConstituentAccountSubscriber(
					this,
					this.driftClient.program,
					config.subscriptionConfig.frequency,
					config.subscriptionConfig.commitment,
					config.additionalFilters
				);
		} else if (config.subscriptionConfig.type === 'websocket') {
			this.constituentAccountSubscriber =
				new WebSocketConstituentAccountSubscriber(
					this,
					this.driftClient.program,
					config.subscriptionConfig.resubTimeoutMs,
					config.subscriptionConfig.commitment,
					config.additionalFilters
				);
		}

		// Listen for account updates from the subscriber
		this.constituentAccountSubscriber.eventEmitter.on(
			'onAccountUpdate',
			(account: ConstituentAccount, pubkey: PublicKey, slot: number) => {
				this.updateConstituentAccount(pubkey.toString(), account, slot);
			}
		);
	}

	private getFilters(): MemcmpFilter[] {
		const filters = [getConstituentFilter()];
		if (this.additionalFilters) {
			filters.push(...this.additionalFilters);
		}
		return filters;
	}

	private decode(name: string, buffer: Buffer): ConstituentAccount {
		return this.driftClient.program.account.constituent.coder.accounts.decodeUnchecked(
			name,
			buffer
		);
	}

	public async sync(): Promise<void> {
		try {
			const rpcRequestArgs = [
				this.driftClient.program.programId.toBase58(),
				{
					commitment: this.commitment,
					filters: this.getFilters(),
					encoding: 'base64+zstd',
					withContext: true,
				},
			];

			// @ts-ignore
			const rpcJSONResponse: any = await this.connection._rpcRequest(
				'getProgramAccounts',
				rpcRequestArgs
			);
			const rpcResponseAndContext: RpcResponseAndContext<
				Array<{ pubkey: PublicKey; account: { data: [string, string] } }>
			> = rpcJSONResponse.result;
			const slot = rpcResponseAndContext.context.slot;

			const promises = rpcResponseAndContext.value.map(
				async (programAccount) => {
					const compressedUserData = Buffer.from(
						programAccount.account.data[0],
						'base64'
					);
					const decoder = new ZSTDDecoder();
					await decoder.init();
					const buffer = Buffer.from(
						decoder.decode(compressedUserData, MAX_CONSTITUENT_SIZE_BYTES)
					);
					const key = programAccount.pubkey.toString();
					const currAccountWithSlot = this.getWithSlot(key);

					if (currAccountWithSlot) {
						if (slot >= currAccountWithSlot.slot) {
							const constituentAcc = this.decode('Constituent', buffer);
							this.updateConstituentAccount(key, constituentAcc, slot);
						}
					} else {
						const constituentAcc = this.decode('Constituent', buffer);
						this.updateConstituentAccount(key, constituentAcc, slot);
					}
				}
			);
			await Promise.all(promises);
		} catch (error) {
			console.log(`ConstituentMap.sync() error: ${error.message}`);
		}
	}

	public async subscribe(): Promise<void> {
		await this.constituentAccountSubscriber.subscribe();
	}

	public async unsubscribe(): Promise<void> {
		await this.constituentAccountSubscriber.unsubscribe();
		this.constituentMap.clear();
	}

	public has(key: string): boolean {
		return this.constituentMap.has(key);
	}

	public get(key: string): ConstituentAccount | undefined {
		return this.constituentMap.get(key)?.data;
	}

	public getWithSlot(key: string): DataAndSlot<ConstituentAccount> | undefined {
		return this.constituentMap.get(key);
	}

	public async mustGet(key: string): Promise<ConstituentAccount> {
		if (!this.has(key)) {
			await this.sync();
		}
		const result = this.constituentMap.get(key);
		if (!result) {
			throw new Error(`ConstituentAccount not found for key: ${key}`);
		}
		return result.data;
	}

	public async mustGetWithSlot(
		key: string
	): Promise<DataAndSlot<ConstituentAccount>> {
		if (!this.has(key)) {
			await this.sync();
		}
		const result = this.constituentMap.get(key);
		if (!result) {
			throw new Error(`ConstituentAccount not found for key: ${key}`);
		}
		return result;
	}

	public size(): number {
		return this.constituentMap.size;
	}

	public *values(): IterableIterator<ConstituentAccount> {
		for (const dataAndSlot of this.constituentMap.values()) {
			yield dataAndSlot.data;
		}
	}

	public valuesWithSlot(): IterableIterator<DataAndSlot<ConstituentAccount>> {
		return this.constituentMap.values();
	}

	public *entries(): IterableIterator<[string, ConstituentAccount]> {
		for (const [key, dataAndSlot] of this.constituentMap.entries()) {
			yield [key, dataAndSlot.data];
		}
	}

	public entriesWithSlot(): IterableIterator<
		[string, DataAndSlot<ConstituentAccount>]
	> {
		return this.constituentMap.entries();
	}

	public updateConstituentAccount(
		key: string,
		constituentAccount: ConstituentAccount,
		slot: number
	): void {
		const existingData = this.getWithSlot(key);
		if (existingData) {
			if (slot >= existingData.slot) {
				this.constituentMap.set(key, {
					data: constituentAccount,
					slot,
				});
			}
		} else {
			this.constituentMap.set(key, {
				data: constituentAccount,
				slot,
			});
		}
	}
}
