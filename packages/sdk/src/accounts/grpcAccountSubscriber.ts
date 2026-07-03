import { ResubOpts, GrpcConfigs } from './types';
import { PublicKey } from '@solana/web3.js';
import { VelocityProgram } from '../config';
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

/**
 * `AccountSubscriber` for a single account, streamed via a gRPC Geyser plugin (Yellowstone or
 * LaserStream, per `GrpcConfigs`) instead of the standard `connection.onAccountChange` WebSocket.
 * Extends `WebSocketAccountSubscriber` to reuse its buffering/decode/resub-timer logic — only the
 * transport (`subscribe`/`unsubscribe`) is replaced. Construct via the static `create` factory,
 * not the constructor directly, since establishing the gRPC client is asynchronous.
 */
export class grpcAccountSubscriber<T> extends WebSocketAccountSubscriber<T> {
	private client: Client;
	private _stream?: ClientDuplexStream;
	private get stream(): ClientDuplexStream {
		if (!this._stream) {
			throw new Error(
				'grpcAccountSubscriber: stream accessed before subscribe()'
			);
		}
		return this._stream;
	}
	private commitmentLevel: CommitmentLevel;
	public listenerId?: number;

	private constructor(
		client: Client,
		commitmentLevel: CommitmentLevel,
		accountName: string,
		program: VelocityProgram,
		accountPublicKey: PublicKey,
		decodeBuffer?: (buffer: Buffer) => T,
		resubOpts?: ResubOpts
	) {
		super(accountName, program, accountPublicKey, decodeBuffer, resubOpts);
		this.client = client;
		this.commitmentLevel = commitmentLevel;
	}

	/**
	 * Creates a gRPC client (or reuses `clientProp`, letting multiple subscribers share one
	 * connection) and constructs a `grpcAccountSubscriber`. Does not itself start streaming — call
	 * `subscribe()` on the result.
	 * @param grpcConfigs gRPC Geyser endpoint/token/commitment config (Yellowstone or LaserStream).
	 * @param accountName Anchor account type name (used for logging and, absent `decodeBuffer`, for decoding via the program coder).
	 * @param program Anchor program providing the connection and coder.
	 * @param accountPublicKey Address of the account to track.
	 * @param decodeBuffer Optional custom decode function; defaults to `program.coder.accounts.decode(accountName, buffer)`.
	 * @param resubOpts Resubscription watchdog options; omit to disable the inactivity timer.
	 * @param clientProp Optional existing gRPC client to reuse instead of creating a new connection.
	 */
	public static async create<U>(
		grpcConfigs: GrpcConfigs,
		accountName: string,
		program: VelocityProgram,
		accountPublicKey: PublicKey,
		decodeBuffer?: (buffer: Buffer) => U,
		resubOpts?: ResubOpts,
		clientProp?: Client
	): Promise<grpcAccountSubscriber<U>> {
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

		return new grpcAccountSubscriber(
			client,
			commitmentLevel,
			accountName,
			program,
			accountPublicKey,
			decodeBuffer,
			resubOpts
		);
	}

	/**
	 * Seeds `dataAndSlot` with an initial `fetch()` (if not already set), opens a gRPC subscribe
	 * stream filtered to this single account, and writes the subscribe request. Idempotent: a
	 * no-op if already subscribed or mid-unsubscribe.
	 * @param onChange Invoked with the newly decoded account data on each accepted update.
	 */
	override async subscribe(onChange: (data: T) => void): Promise<void> {
		if (this.listenerId != null || this.isUnsubscribing) {
			return;
		}

		this.onChange = onChange;
		if (!this.dataAndSlot) {
			await this.fetch();
		}

		// Subscribe with grpc
		this._stream =
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

	/**
	 * Writes an empty subscribe request to clear the stream's account filter and cancels any
	 * pending resub timeout.
	 * @param onResub Internal flag set to `true` when called as part of an automatic resubscribe cycle, which preserves `resubOpts.resubTimeoutMs` instead of clearing it. Callers should omit this.
	 */
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
