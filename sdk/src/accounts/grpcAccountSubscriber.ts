import { ResubOpts, GrpcConfigs } from './types';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import * as Buffer from 'buffer';

import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import {
	Client,
	ClientDuplexStream,
	CommitmentLevel,
	createClient,
	SubscribeRequest,
	SubscribeUpdate,
} from '../isomorphic/grpc';

export class grpcAccountSubscriber<T> extends WebSocketAccountSubscriber<T> {
	private client: Client;
	private stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
	private commitmentLevel: CommitmentLevel;
	public listenerId?: number;
	private enableReconnect: boolean;

	private constructor(
		client: Client,
		commitmentLevel: CommitmentLevel,
		accountName: string,
		program: Program,
		accountPublicKey: PublicKey,
		decodeBuffer?: (buffer: Buffer) => T,
		resubOpts?: ResubOpts,
		enableReconnect = false
	) {
		super(accountName, program, accountPublicKey, decodeBuffer, resubOpts);
		this.client = client;
		this.commitmentLevel = commitmentLevel;
		this.enableReconnect = enableReconnect;
	}

	public static async create<U>(
		grpcConfigs: GrpcConfigs,
		accountName: string,
		program: Program,
		accountPublicKey: PublicKey,
		decodeBuffer?: (buffer: Buffer) => U,
		resubOpts?: ResubOpts
	): Promise<grpcAccountSubscriber<U>> {
		const client = await createClient(
			grpcConfigs.endpoint,
			grpcConfigs.token,
			grpcConfigs.channelOptions ?? {}
		);
		const commitmentLevel =
			// @ts-ignore :: isomorphic exported enum fails typescript but will work at runtime
			grpcConfigs.commitmentLevel ?? CommitmentLevel.CONFIRMED;

		return new grpcAccountSubscriber(
			client,
			commitmentLevel,
			accountName,
			program,
			accountPublicKey,
			decodeBuffer,
			resubOpts,
			grpcConfigs.enableReconnect
		);
	}

	override async subscribe(onChange: (data: T) => void): Promise<void> {
		if (this.listenerId != null || this.isUnsubscribing) {
			return;
		}

		this.onChange = onChange;
		if (!this.dataAndSlot) {
			await this.fetch();
		}

		// Subscribe with grpc
		this.stream =
			(await this.client.subscribe()) as unknown as typeof this.stream;
		const request: SubscribeRequest = {
			slots: {},
			accounts: {
				account: {
					account: [this.accountPublicKey.toString()],
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

		if (this.enableReconnect) {
			this.stream.on('error', (error) => {
				// @ts-ignore
				if (error.code === 1) {
					// expected: 1 CANCELLED: Cancelled on client
					console.error(
						'GRPC (grpcAccountSubscriber) Cancelled on client caught:',
						error
					);
					return;
				} else {
					console.error(
						'GRPC (grpcAccountSubscriber) unexpected error caught:',
						error
					);
				}
			});
		}

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
					accountInfo
				);
				this.setTimeout();
			} else {
				this.handleRpcResponse(
					{
						slot,
					},
					accountInfo
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

	override async unsubscribe(onResub = false): Promise<void> {
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
				this.stream.cancel();
				this.stream.destroy();
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
