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
	client: Client;
	stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
	commitmentLevel: CommitmentLevel;
	listenerId?: number;

	public constructor(
		grpcConfigs: GrpcConfigs,
		accountName: string,
		program: Program,
		accountPublicKey: PublicKey,
		decodeBuffer?: (buffer: Buffer) => T,
		resubOpts?: ResubOpts
	) {
		super(accountName, program, accountPublicKey, decodeBuffer, resubOpts);
		this.client = createClient(
			grpcConfigs.endpoint,
			grpcConfigs.token,
			grpcConfigs.channelOptions ?? {}
		);
		this.commitmentLevel =
			// @ts-ignore :: isomorphic exported enum fails typescript but will work at runtime
			grpcConfigs.commitmentLevel ?? CommitmentLevel.CONFIRMED;
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
		this.stream = await this.client.subscribe();
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
