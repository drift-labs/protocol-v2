import { Program } from '@coral-xyz/anchor';
import { Context, PublicKey } from '@solana/web3.js';
import * as Buffer from 'buffer';
import bs58 from 'bs58';

import {
	Client,
	ClientDuplexStream,
	CommitmentLevel,
	SubscribeRequest,
	SubscribeUpdate,
	createClient,
} from '../isomorphic/grpc';
import { DataAndSlot, GrpcConfigs, ResubOpts } from './types';

interface AccountInfoLike {
	owner: PublicKey;
	lamports: number;
	data: Buffer;
	executable: boolean;
	rentEpoch: number;
}

export class grpcMultiAccountSubscriber<T> {
	private client: Client;
	private stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
	private commitmentLevel: CommitmentLevel;
	private program: Program;
	private accountName: string;
	private decodeBufferFn?: (buffer: Buffer, pubkey?: string) => T;
	private resubOpts?: ResubOpts;
	private onUnsubscribe?: () => Promise<void>;

	public listenerId?: number;
	public isUnsubscribing = false;
	private timeoutId?: ReturnType<typeof setTimeout>;
	private receivingData = false;

	private subscribedAccounts = new Set<string>();
	private onChangeMap = new Map<
		string,
		(data: T, context: Context, buffer: Buffer) => void
	>();

	private dataMap = new Map<string, DataAndSlot<T>>();

	private constructor(
		client: Client,
		commitmentLevel: CommitmentLevel,
		accountName: string,
		program: Program,
		decodeBuffer?: (buffer: Buffer, pubkey?: string) => T,
		resubOpts?: ResubOpts,
		onUnsubscribe?: () => Promise<void>
	) {
		this.client = client;
		this.commitmentLevel = commitmentLevel;
		this.accountName = accountName;
		this.program = program;
		this.decodeBufferFn = decodeBuffer;
		this.resubOpts = resubOpts;
		this.onUnsubscribe = onUnsubscribe;
	}

	public static async create<U>(
		grpcConfigs: GrpcConfigs,
		accountName: string,
		program: Program,
		decodeBuffer?: (buffer: Buffer, pubkey?: string) => U,
		resubOpts?: ResubOpts,
		clientProp?: Client,
		onUnsubscribe?: () => Promise<void>
	): Promise<grpcMultiAccountSubscriber<U>> {
		const client = clientProp
			? clientProp
			: await createClient(
					grpcConfigs.endpoint,
					grpcConfigs.token,
					grpcConfigs.channelOptions ?? {}
			  );
		const commitmentLevel =
			// @ts-ignore :: isomorphic exported enum fails typescript but will work at runtime
			grpcConfigs.commitmentLevel ?? CommitmentLevel.CONFIRMED;

		return new grpcMultiAccountSubscriber(
			client,
			commitmentLevel,
			accountName,
			program,
			decodeBuffer,
			resubOpts,
			onUnsubscribe
		);
	}

	setAccountData(accountPubkey: PublicKey, data: T, slot?: number): void {
		this.dataMap.set(accountPubkey.toBase58(), { data, slot });
	}

	getAccountData(accountPubkey: string): DataAndSlot<T> | undefined {
		return this.dataMap.get(accountPubkey);
	}

	getAccountDataMap(): Map<string, DataAndSlot<T>> {
		return this.dataMap;
	}

	async subscribe(
		accounts: PublicKey[],
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

		// Track accounts and single onChange for all
		for (const pk of accounts) {
			const key = pk.toBase58();
			this.subscribedAccounts.add(key);
			this.onChangeMap.set(key, (data, ctx, buffer) =>
				onChange(new PublicKey(key), data, ctx, buffer)
			);
		}

		this.stream =
			(await this.client.subscribe()) as unknown as typeof this.stream;
		const request: SubscribeRequest = {
			slots: {},
			accounts: {
				account: {
					account: accounts.map((a) => a.toBase58()),
					owner: [],
					filters: [],
				},
			},
			transactions: {},
			blocks: {},
			blocksMeta: {},
			accountsDataSlice: [],
			commitment: this.commitmentLevel,
			entry: {},
			transactionsStatus: {},
		};

		this.stream.on('data', (chunk: SubscribeUpdate) => {
			if (!chunk.account) {
				return;
			}
			const slot = Number(chunk.account.slot);
			const accountPubkeyBytes = chunk.account.account.pubkey;
			const accountPubkey = bs58.encode(
				accountPubkeyBytes as unknown as Uint8Array
			);
			if (!accountPubkey || !this.subscribedAccounts.has(accountPubkey)) {
				return;
			}
			const accountInfo: AccountInfoLike = {
				owner: new PublicKey(chunk.account.account.owner),
				lamports: Number(chunk.account.account.lamports),
				data: Buffer.Buffer.from(chunk.account.account.data),
				executable: chunk.account.account.executable,
				rentEpoch: Number(chunk.account.account.rentEpoch),
			};

			const context = { slot } as Context;
			const buffer = accountInfo.data;
			const data = this.decodeBufferFn
				? this.decodeBufferFn(buffer, accountPubkey)
				: this.program.account[this.accountName].coder.accounts.decode(
						this.capitalize(this.accountName),
						buffer
				  );

			const handler = this.onChangeMap.get(accountPubkey);
			if (handler) {
				if (this.resubOpts?.resubTimeoutMs) {
					this.receivingData = true;
					clearTimeout(this.timeoutId);
					handler(data, context, buffer);
					this.setTimeout();
				} else {
					handler(data, context, buffer);
				}
			}
		});

		return new Promise<void>((resolve, reject) => {
			this.stream.write(request, (err) => {
				if (err === null || err === undefined) {
					this.listenerId = 1;
					if (this.resubOpts?.resubTimeoutMs) {
						this.receivingData = true;
						this.setTimeout();
					}
					resolve();
				} else {
					reject(err);
				}
			});
		}).catch((reason) => {
			console.error(reason);
			throw reason;
		});
	}

	async addAccounts(accounts: PublicKey[]): Promise<void> {
		for (const pk of accounts) {
			this.subscribedAccounts.add(pk.toBase58());
		}
		const request: SubscribeRequest = {
			slots: {},
			accounts: {
				account: {
					account: Array.from(this.subscribedAccounts.values()),
					owner: [],
					filters: [],
				},
			},
			transactions: {},
			blocks: {},
			blocksMeta: {},
			accountsDataSlice: [],
			commitment: this.commitmentLevel,
			entry: {},
			transactionsStatus: {},
		};

		await new Promise<void>((resolve, reject) => {
			this.stream.write(request, (err) => {
				if (err === null || err === undefined) {
					resolve();
				} else {
					reject(err);
				}
			});
		});
	}

	async removeAccounts(accounts: PublicKey[]): Promise<void> {
		for (const pk of accounts) {
			const k = pk.toBase58();
			this.subscribedAccounts.delete(k);
			this.onChangeMap.delete(k);
		}
		const request: SubscribeRequest = {
			slots: {},
			accounts: {
				account: {
					account: Array.from(this.subscribedAccounts.values()),
					owner: [],
					filters: [],
				},
			},
			transactions: {},
			blocks: {},
			blocksMeta: {},
			accountsDataSlice: [],
			commitment: this.commitmentLevel,
			entry: {},
			transactionsStatus: {},
		};

		await new Promise<void>((resolve, reject) => {
			this.stream.write(request, (err) => {
				if (err === null || err === undefined) {
					resolve();
				} else {
					reject(err);
				}
			});
		});
	}

	async unsubscribe(): Promise<void> {
		this.isUnsubscribing = true;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;

		if (this.listenerId != null) {
			const promise = new Promise<void>((resolve, reject) => {
				const request: SubscribeRequest = {
					slots: {},
					accounts: {},
					transactions: {},
					blocks: {},
					blocksMeta: {},
					accountsDataSlice: [],
					entry: {},
					transactionsStatus: {},
				};
				this.stream.write(request, (err) => {
					if (err === null || err === undefined) {
						this.listenerId = undefined;
						this.isUnsubscribing = false;
						resolve();
					} else {
						reject(err);
					}
				});
			}).catch((reason) => {
				console.error(reason);
				throw reason;
			});
			return promise;
		} else {
			this.isUnsubscribing = false;
		}

		if (this.onUnsubscribe) {
			try {
				await this.onUnsubscribe();
			} catch (e) {
				console.error(e);
			}
		}
	}

	private setTimeout(): void {
		this.timeoutId = setTimeout(
			async () => {
				if (this.isUnsubscribing) {
					return;
				}
				if (this.receivingData) {
					await this.unsubscribe();
					this.receivingData = false;
				}
			},
			this.resubOpts?.resubTimeoutMs
		);
	}

	private capitalize(value: string): string {
		if (!value) return value;
		return value.charAt(0).toUpperCase() + value.slice(1);
	}
}
