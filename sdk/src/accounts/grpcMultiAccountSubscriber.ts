import { Program } from '@coral-xyz/anchor';
import { Commitment, Context, PublicKey } from '@solana/web3.js';
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

function commitmentLevelToCommitment(
	commitmentLevel: CommitmentLevel
): Commitment {
	switch (commitmentLevel) {
		case CommitmentLevel.PROCESSED:
			return 'processed';
		case CommitmentLevel.CONFIRMED:
			return 'confirmed';
		case CommitmentLevel.FINALIZED:
			return 'finalized';
		default:
			return 'confirmed';
	}
}

export class grpcMultiAccountSubscriber<T, U = undefined> {
	private client: Client;
	private stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
	private commitmentLevel: CommitmentLevel;
	private program: Program;
	private accountName: string;
	private decodeBufferFn?: (
		buffer: Buffer,
		pubkey?: string,
		accountProps?: U
	) => T;
	private resubOpts?: ResubOpts;
	private onUnsubscribe?: () => Promise<void>;

	public listenerId?: number;
	public isUnsubscribing = false;
	private timeoutId?: ReturnType<typeof setTimeout>;
	private receivingData = false;

	private subscribedAccounts = new Set<string>();
	private onChangeMap = new Map<
		string,
		(data: T, context: Context, buffer: Buffer, accountProps: U) => void
	>();

	private dataMap = new Map<string, DataAndSlot<T>>();
	private accountPropsMap = new Map<string, U | Array<U>>();

	private constructor(
		client: Client,
		commitmentLevel: CommitmentLevel,
		accountName: string,
		program: Program,
		decodeBuffer?: (buffer: Buffer, pubkey?: string) => T,
		resubOpts?: ResubOpts,
		onUnsubscribe?: () => Promise<void>,
		accountPropsMap?: Map<string, U | Array<U>>
	) {
		this.client = client;
		this.commitmentLevel = commitmentLevel;
		this.accountName = accountName;
		this.program = program;
		this.decodeBufferFn = decodeBuffer;
		this.resubOpts = resubOpts;
		this.onUnsubscribe = onUnsubscribe;
		this.accountPropsMap = accountPropsMap;
	}

	public static async create<T, U = undefined>(
		grpcConfigs: GrpcConfigs,
		accountName: string,
		program: Program,
		decodeBuffer?: (buffer: Buffer, pubkey?: string, accountProps?: U) => T,
		resubOpts?: ResubOpts,
		clientProp?: Client,
		onUnsubscribe?: () => Promise<void>,
		accountPropsMap?: Map<string, U | Array<U>>
	): Promise<grpcMultiAccountSubscriber<T, U>> {
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
			onUnsubscribe,
			accountPropsMap
		);
	}

	setAccountData(accountPubkey: string, data: T, slot?: number): void {
		this.dataMap.set(accountPubkey, { data, slot });
	}

	getAccountData(accountPubkey: string): DataAndSlot<T> | undefined {
		return this.dataMap.get(accountPubkey);
	}

	getAccountDataMap(): Map<string, DataAndSlot<T>> {
		return this.dataMap;
	}

	async fetch(): Promise<void> {
		try {
			// Chunk account IDs into groups of 100 (getMultipleAccounts limit)
			const chunkSize = 100;
			const chunks: string[][] = [];
			const accountIds = Array.from(this.subscribedAccounts.values());
			for (let i = 0; i < accountIds.length; i += chunkSize) {
				chunks.push(accountIds.slice(i, i + chunkSize));
			}

			// Process all chunks concurrently
			await Promise.all(
				chunks.map(async (chunk) => {
					const accountAddresses = chunk.map(
						(accountId) => new PublicKey(accountId)
					);
					const rpcResponseAndContext =
						await this.program.provider.connection.getMultipleAccountsInfoAndContext(
							accountAddresses,
							{
								commitment: commitmentLevelToCommitment(this.commitmentLevel),
							}
						);

					const rpcResponse = rpcResponseAndContext.value;
					const currentSlot = rpcResponseAndContext.context.slot;

					for (let i = 0; i < chunk.length; i++) {
						const accountId = chunk[i];
						const accountInfo = rpcResponse[i];
						if (accountInfo) {
							const perpMarket = this.program.coder.accounts.decode(
								'PerpMarket',
								accountInfo.data
							);
							this.setAccountData(accountId, perpMarket, currentSlot);
						}
					}
				})
			);
		} catch (error) {
			if (this.resubOpts?.logResubMessages) {
				console.log(
					`[${this.accountName}] grpcMultiAccountSubscriber error fetching accounts:`,
					error
				);
			}
		}
	}

	async subscribe(
		accounts: PublicKey[],
		onChange: (
			accountId: PublicKey,
			data: T,
			context: Context,
			buffer: Buffer,
			accountProps: U
		) => void
	): Promise<void> {
		if (this.listenerId != null || this.isUnsubscribing) {
			return;
		}

		// Track accounts and single onChange for all
		for (const pk of accounts) {
			const key = pk.toBase58();
			this.subscribedAccounts.add(key);
			this.onChangeMap.set(key, (data, ctx, buffer, accountProps) => {
				this.setAccountData(key, data, ctx.slot);
				onChange(new PublicKey(key), data, ctx, buffer, accountProps);
			});
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
			const accountProps = this.accountPropsMap?.get(accountPubkey);

			const handleDataBuffer = (
				context: Context,
				buffer: Buffer,
				accountProps: U
			) => {
				const data = this.decodeBufferFn
					? this.decodeBufferFn(buffer, accountPubkey, accountProps)
					: this.program.account[this.accountName].coder.accounts.decode(
							this.capitalize(this.accountName),
							buffer
					  );
				const handler = this.onChangeMap.get(accountPubkey);
				if (handler) {
					if (this.resubOpts?.resubTimeoutMs) {
						this.receivingData = true;
						clearTimeout(this.timeoutId);
						handler(data, context, buffer, accountProps);
						this.setTimeout();
					} else {
						handler(data, context, buffer, accountProps);
					}
				}
			};

			if (Array.isArray(accountProps)) {
				for (const props of accountProps) {
					handleDataBuffer(context, buffer, props);
				}
			} else {
				handleDataBuffer(context, buffer, accountProps);
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
