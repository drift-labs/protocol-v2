import { GrpcConfigs, ResubOpts } from './types';
import { Program } from '@coral-xyz/anchor';
import { Context, MemcmpFilter, PublicKey } from '@solana/web3.js';
import * as Buffer from 'buffer';
import { WebSocketProgramAccountSubscriber } from './webSocketProgramAccountSubscriber';

import {
	LaserCommitmentLevel,
	LaserSubscribe,
	LaserstreamConfig,
	LaserSubscribeRequest,
	LaserSubscribeUpdate,
	CompressionAlgorithms,
	CommitmentLevel,
} from '../isomorphic/grpc';

type LaserCommitment =
	(typeof LaserCommitmentLevel)[keyof typeof LaserCommitmentLevel];

export class LaserstreamProgramAccountSubscriber<
	T,
> extends WebSocketProgramAccountSubscriber<T> {
	private stream:
		| {
				id: string;
				cancel: () => void;
				write?: (req: LaserSubscribeRequest) => Promise<void>;
		  }
		| undefined;

	private commitmentLevel: CommitmentLevel;
	public listenerId?: number;

	private readonly laserConfig: LaserstreamConfig;

	private constructor(
		laserConfig: LaserstreamConfig,
		commitmentLevel: CommitmentLevel,
		subscriptionName: string,
		accountDiscriminator: string,
		program: Program,
		decodeBufferFn: (accountName: string, ix: Buffer) => T,
		options: { filters: MemcmpFilter[] } = { filters: [] },
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
		this.laserConfig = laserConfig;
		this.commitmentLevel = this.toLaserCommitment(commitmentLevel);
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
	): Promise<LaserstreamProgramAccountSubscriber<U>> {
		const laserConfig: LaserstreamConfig = {
			apiKey: grpcConfigs.token,
			endpoint: grpcConfigs.endpoint,
			maxReconnectAttempts: grpcConfigs.enableReconnect ? 10 : 0,
			channelOptions: {
				'grpc.default_compression_algorithm': CompressionAlgorithms.zstd,
				'grpc.max_receive_message_length': 1_000_000_000,
			},
		};

		const commitmentLevel =
			grpcConfigs.commitmentLevel ?? CommitmentLevel.CONFIRMED;

		return new LaserstreamProgramAccountSubscriber<U>(
			laserConfig,
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
		if (this.listenerId != null || this.isUnsubscribing) return;

		this.onChange = onChange;

		const filters = this.options.filters.map((filter) => {
			return {
				memcmp: {
					offset: filter.memcmp.offset,
					base58: filter.memcmp.bytes,
				},
			};
		});

		const request: LaserSubscribeRequest = {
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

		try {
			const stream = await LaserSubscribe(
				this.laserConfig,
				request,
				async (update: LaserSubscribeUpdate) => {
					if (update.account) {
						const slot = Number(update.account.slot);
						const acc = update.account.account;

						const accountInfo = {
							owner: new PublicKey(acc.owner),
							lamports: Number(acc.lamports),
							data: Buffer.Buffer.from(acc.data),
							executable: acc.executable,
							rentEpoch: Number(acc.rentEpoch),
						};

						const payload = {
							accountId: new PublicKey(acc.pubkey),
							accountInfo,
						};

						if (this.resubOpts?.resubTimeoutMs) {
							this.receivingData = true;
							clearTimeout(this.timeoutId);
							this.handleRpcResponse({ slot }, payload);
							this.setTimeout();
						} else {
							this.handleRpcResponse({ slot }, payload);
						}
					}
				},
				async (error) => {
					console.error('LaserStream client error:', error);
					throw error;
				}
			);

			this.stream = stream;
			this.listenerId = 1;

			if (this.resubOpts?.resubTimeoutMs) {
				this.receivingData = true;
				this.setTimeout();
			}
		} catch (err) {
			console.error('Failed to start LaserStream client:', err);
			throw err;
		}
	}

	public async unsubscribe(onResub = false): Promise<void> {
		if (!onResub && this.resubOpts) {
			this.resubOpts.resubTimeoutMs = undefined;
		}
		this.isUnsubscribing = true;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;

		if (this.listenerId != null && this.stream) {
			try {
				this.stream.cancel();
			} finally {
				this.listenerId = undefined;
				this.isUnsubscribing = false;
			}
		} else {
			this.isUnsubscribing = false;
		}
	}

	public toLaserCommitment(
		level: string | number | undefined
	): LaserCommitment {
		if (typeof level === 'string') {
			return (
				(LaserCommitmentLevel as any)[level.toUpperCase()] ??
				LaserCommitmentLevel.CONFIRMED
			);
		}
		return (level as LaserCommitment) ?? LaserCommitmentLevel.CONFIRMED;
	}
}
