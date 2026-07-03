import { LaserGrpcConfigs, ResubOpts } from './types';
import { Context, MemcmpFilter, PublicKey } from '@solana/web3.js';
import { VelocityProgram } from '../config';
import * as Buffer from 'buffer';
import { WebSocketProgramAccountSubscriber } from './webSocketProgramAccountSubscriber';

import {
	LaserCommitmentLevel,
	LaserstreamConfig,
	LaserSubscribeRequest,
	LaserSubscribeUpdate,
	CommitmentLevel,
	getLaserSubscribe,
	getLaserCompressionAlgorithms,
	getLaserCommitmentLevel,
} from '../isomorphic/grpc';

type LaserCommitment =
	(typeof LaserCommitmentLevel)[keyof typeof LaserCommitmentLevel];

/**
 * `ProgramAccountSubscriber` that streams every account owned by the program (optionally filtered
 * by `memcmp`) via Helius LaserStream instead of `connection.onProgramAccountChange`. Extends
 * `WebSocketProgramAccountSubscriber` to reuse its per-account buffering/decode/resub-timer logic
 * (`handleRpcResponse`, `bufferAndSlotMap`) — only the transport (`subscribe`/`unsubscribe`) is
 * replaced. Construct via the static `create` factory, not the constructor directly, since it
 * dynamically loads the optional `helius-laserstream` peer dependency and its enums.
 */
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
	private readonly laserCommitmentLevel: typeof LaserCommitmentLevel;

	private constructor(
		laserConfig: LaserstreamConfig,
		commitmentLevel: CommitmentLevel,
		laserCommitmentLevel: typeof LaserCommitmentLevel,
		subscriptionName: string,
		accountDiscriminator: string,
		program: VelocityProgram,
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
		this.laserCommitmentLevel = laserCommitmentLevel;
		this.commitmentLevel = this.toLaserCommitment(commitmentLevel);
	}

	/**
	 * Loads the optional `helius-laserstream` module, builds its `LaserstreamConfig` (forcing zstd
	 * compression and a 1GB max receive message size), and constructs a
	 * `LaserstreamProgramAccountSubscriber`. Does not itself start streaming — call
	 * `subscribe(onChange)` on the result.
	 * @param grpcConfigs LaserStream endpoint/token/commitment config; `enableReconnect` maps to up to 10 reconnect attempts (0 if unset).
	 * @param subscriptionName Human-readable name for logging.
	 * @param accountDiscriminator Anchor account type name passed to `decodeBufferFn` for each update.
	 * @param program Anchor program whose accounts to stream (filtered to `program.programId` as owner).
	 * @param decodeBufferFn Decode function for each account's raw buffer.
	 * @param options `filters` (memcmp) narrowing which program accounts are streamed; empty streams every account owned by the program.
	 * @param resubOpts Resubscription watchdog options; omit to disable the inactivity timer.
	 */
	public static async create<U>(
		grpcConfigs: LaserGrpcConfigs,
		subscriptionName: string,
		accountDiscriminator: string,
		program: VelocityProgram,
		decodeBufferFn: (accountName: string, ix: Buffer) => U,
		options: { filters: MemcmpFilter[] } = {
			filters: [],
		},
		resubOpts?: ResubOpts
	): Promise<LaserstreamProgramAccountSubscriber<U>> {
		// Load enums from the optional helius-laserstream module
		const [compressionAlgorithms, laserCommitmentLevel] = await Promise.all([
			getLaserCompressionAlgorithms(),
			getLaserCommitmentLevel(),
		]);

		const laserConfig: LaserstreamConfig = {
			apiKey: grpcConfigs.token,
			endpoint: grpcConfigs.endpoint,
			maxReconnectAttempts: grpcConfigs.enableReconnect ? 10 : 0,
			channelOptions: {
				'grpc.default_compression_algorithm': compressionAlgorithms.zstd,
				'grpc.max_receive_message_length': 1_000_000_000,
			},
		};

		const commitmentLevel =
			grpcConfigs.commitmentLevel ?? CommitmentLevel.CONFIRMED;

		return new LaserstreamProgramAccountSubscriber<U>(
			laserConfig,
			commitmentLevel,
			laserCommitmentLevel,
			subscriptionName,
			accountDiscriminator,
			program,
			decodeBufferFn,
			options,
			resubOpts
		);
	}

	/**
	 * Opens a LaserStream `accounts` subscription filtered to `program.programId` as owner
	 * (further narrowed by the `filters` passed to `create`). Idempotent: a no-op if already
	 * subscribed or mid-unsubscribe. Does not perform an initial fetch — the caller must fetch any
	 * pre-existing matching accounts separately if needed. Throws if the LaserStream client fails
	 * to start.
	 * @param onChange Invoked once per changed account with its pubkey, decoded data, the notification's `Context` (slot only), and the raw buffer.
	 */
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
				velocity: {
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
			// Dynamically load LaserSubscribe from the optional helius-laserstream module
			const laserSubscribe = await getLaserSubscribe();

			const stream = await laserSubscribe(
				this.laserConfig,
				request,
				async (update: LaserSubscribeUpdate) => {
					if (update.account) {
						const slot = Number(update.account.slot);
						const acc = update.account.account;
						if (!acc) {
							return;
						}

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

	/**
	 * Cancels the LaserStream and clears any pending resub timeout.
	 * @param onResub Internal flag set to `true` when called as part of an automatic resubscribe cycle, which preserves `resubOpts.resubTimeoutMs` instead of clearing it. Callers should omit this.
	 */
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

	/** Coerces a commitment level (string name, numeric enum value, or undefined) into a LaserStream `LaserCommitmentLevel`, defaulting to `CONFIRMED`. */
	public toLaserCommitment(
		level: string | number | undefined
	): LaserCommitment {
		if (typeof level === 'string') {
			return (
				(this.laserCommitmentLevel as any)[level.toUpperCase()] ??
				this.laserCommitmentLevel.CONFIRMED
			);
		}
		return (level as LaserCommitment) ?? this.laserCommitmentLevel.CONFIRMED;
	}
}
