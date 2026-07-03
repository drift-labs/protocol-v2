import { ResubOpts, GrpcConfigs } from './types';
import { Context, MemcmpFilter, PublicKey } from '@solana/web3.js';
import { VelocityProgram } from '../config';
import * as Buffer from 'buffer';
import { WebSocketProgramAccountSubscriber } from './webSocketProgramAccountSubscriber';
import {
	Client,
	CommitmentLevel,
	createClient,
	SubscribeRequest,
	SubscribeUpdate,
} from '../isomorphic/grpc';

/**
 * `ProgramAccountSubscriber` that streams every account owned by the program (optionally
 * filtered by `memcmp`) via a gRPC Geyser plugin instead of `connection.onProgramAccountChange`.
 * Extends `WebSocketProgramAccountSubscriber` to reuse its per-account buffering/decode/resub-
 * timer logic — only the transport (`subscribe`/`unsubscribe`) is replaced. Construct via the
 * static `create` factory, not the constructor directly, since establishing the gRPC client is
 * asynchronous.
 */
export class grpcProgramAccountSubscriber<
	T,
> extends WebSocketProgramAccountSubscriber<T> {
	private client: Client;
	private _stream?: Awaited<ReturnType<Client['subscribe']>>;
	private get stream(): Awaited<ReturnType<Client['subscribe']>> {
		if (!this._stream) {
			throw new Error(
				'grpcProgramAccountSubscriber: stream accessed before subscribe()'
			);
		}
		return this._stream;
	}
	private commitmentLevel: CommitmentLevel;
	public listenerId?: number;

	private constructor(
		client: Client,
		commitmentLevel: CommitmentLevel,
		subscriptionName: string,
		accountDiscriminator: string,
		program: VelocityProgram,
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

	/**
	 * Creates a gRPC client and constructs a `grpcProgramAccountSubscriber`. Forces zstd
	 * compression and an adaptive HTTP/2 window on the channel (in addition to any caller-supplied
	 * `channelOptions`), since program-wide account streams can be high-volume. Does not itself
	 * start streaming — call `subscribe(onChange)` on the result.
	 * @param grpcConfigs gRPC Geyser endpoint/token/commitment config (Yellowstone or LaserStream).
	 * @param subscriptionName Human-readable name for logging.
	 * @param accountDiscriminator Anchor account type name passed to `decodeBufferFn` for each update.
	 * @param program Anchor program whose accounts to stream (filtered to `program.programId` as owner).
	 * @param decodeBufferFn Decode function for each account's raw buffer.
	 * @param options `filters.memcmp` filters narrowing which program accounts are streamed; empty streams every account owned by the program.
	 * @param resubOpts Resubscription watchdog options; omit to disable the inactivity timer.
	 */
	public static async create<U>(
		grpcConfigs: GrpcConfigs,
		subscriptionName: string,
		accountDiscriminator: string,
		program: VelocityProgram,
		decodeBufferFn: (accountName: string, ix: Buffer) => U,
		options: { filters: MemcmpFilter[] } = {
			filters: [],
		},
		resubOpts?: ResubOpts
	): Promise<grpcProgramAccountSubscriber<U>> {
		const channelOptions: GrpcConfigs['channelOptions'] = {
			...(grpcConfigs.channelOptions ?? {}),
			grpcDefaultCompressionAlgorithm: 1, // always use zstd compression
			grpcHttp2AdaptiveWindow: true, // enable adaptive window size management
		};
		const client = await createClient(
			grpcConfigs.endpoint,
			grpcConfigs.token,
			channelOptions
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

	/**
	 * Opens a gRPC subscribe stream filtered to accounts owned by `program.programId` (further
	 * narrowed by the `filters` passed to `create`). Idempotent: a no-op if already subscribed or
	 * mid-unsubscribe. Unlike `grpcAccountSubscriber`, does not perform an initial `fetch()` — the
	 * caller must fetch any pre-existing matching accounts separately if needed.
	 * @param onChange Invoked once per changed account with its pubkey, decoded data, the notification's `Context`, and the raw buffer.
	 */
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
		this._stream = await this.client.subscribe();

		const filters = this.options.filters.map((filter) => {
			return {
				memcmp: {
					offset: filter.memcmp.offset.toString(),
					base58: filter.memcmp.bytes,
				},
			};
		});

		const request: SubscribeRequest = {
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

		this.stream.on('data', (chunk: SubscribeUpdate) => {
			if (!chunk.account || !chunk.account.account) {
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

	/**
	 * Writes an empty subscribe request to clear the stream's filter and cancels any pending
	 * resub timeout.
	 * @param onResub Internal flag set to `true` when called as part of an automatic resubscribe cycle, which preserves `resubOpts.resubTimeoutMs` instead of clearing it. Callers should omit this.
	 */
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
