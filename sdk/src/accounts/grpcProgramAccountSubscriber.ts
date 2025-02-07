import { ResubOpts, GrpcConfigs } from './types';
import { Program } from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { Context, MemcmpFilter, PublicKey } from '@solana/web3.js';
import * as Buffer from 'buffer';
import { WebSocketProgramAccountSubscriber } from './webSocketProgramAccountSubscriber';
import {
	Client,
	ClientDuplexStream,
	CommitmentLevel,
	createClient,
	SubscribeRequest,
	SubscribeUpdate,
} from '../isomorphic/grpc';

export class grpcProgramAccountSubscriber<
	T,
> extends WebSocketProgramAccountSubscriber<T> {
	private client: Client;
	private stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
	private commitmentLevel: CommitmentLevel;
	public listenerId?: number;

	private constructor(
		client: Client,
		commitmentLevel: CommitmentLevel,
		subscriptionName: string,
		accountDiscriminator: string,
		program: Program,
		decodeBufferFn: (accountName: string, ix: Buffer) => T,
		options: { filters: MemcmpFilter[] } = {
			filters: [],
		},
		resubOpts?: ResubOpts
	) {
		super(
			subscriptionName,
			accountDiscriminator,
			program,
			decodeBufferFn,
			options,
			resubOpts
		);
		this.client = client;
		this.commitmentLevel = commitmentLevel;
	}

	public static async create<U>(
		grpcConfigs: GrpcConfigs,
		subscriptionName: string,
		accountDiscriminator: string,
		program: Program,
		decodeBufferFn: (accountName: string, ix: Buffer) => U,
		options: { filters: MemcmpFilter[] } = {
			filters: [],
		},
		resubOpts?: ResubOpts
	): Promise<grpcProgramAccountSubscriber<U>> {
		const client = await createClient(
			grpcConfigs.endpoint,
			grpcConfigs.token,
			grpcConfigs.channelOptions ?? {}
		);
		const commitmentLevel =
			// @ts-ignore :: isomorphic exported enum fails typescript but will work at runtime
			grpcConfigs.commitmentLevel ?? CommitmentLevel.CONFIRMED;

		return new grpcProgramAccountSubscriber(
			client,
			commitmentLevel,
			subscriptionName,
			accountDiscriminator,
			program,
			decodeBufferFn,
			options,
			resubOpts
		);
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

		// Subscribe with grpc
		this.stream = await this.client.subscribe();
		const filters = this.options.filters.map((filter) => {
			return {
				memcmp: {
					offset: filter.memcmp.offset.toString(),
					bytes: bs58.decode(filter.memcmp.bytes),
				},
			};
		});
		const request: SubscribeRequest = {
			slots: {},
			accounts: {
				drift: {
					account: [],
					owner: [this.program.programId.toBase58()],
					filters,
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
			const accountInfo = {
				owner: new PublicKey(chunk.account.account.owner),
				lamports: Number(chunk.account.account.lamports),
				data: Buffer.Buffer.from(chunk.account.account.data),
				executable: chunk.account.account.executable,
				rentEpoch: Number(chunk.account.account.rentEpoch),
			};

			if (this.resubOpts?.resubTimeoutMs) {
				this.receivingData = true;
				clearTimeout(this.timeoutId);
				this.handleRpcResponse(
					{
						slot,
					},
					{
						accountId: new PublicKey(chunk.account.account.pubkey),
						accountInfo,
					}
				);
				this.setTimeout();
			} else {
				this.handleRpcResponse(
					{
						slot,
					},
					{
						accountId: new PublicKey(chunk.account.account.pubkey),
						accountInfo,
					}
				);
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

	public async unsubscribe(onResub = false): Promise<void> {
		if (!onResub && this.resubOpts) {
			this.resubOpts.resubTimeoutMs = undefined;
		}
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
	}
}
