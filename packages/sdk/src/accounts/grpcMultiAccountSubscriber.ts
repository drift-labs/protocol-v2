import { Commitment, Context, PublicKey } from '@solana/web3.js';
import { VelocityProgram } from '../config';
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
import { BufferAndSlot, DataAndSlot, GrpcConfigs, ResubOpts } from './types';

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

/**
 * Multiplexes many accounts of the same Anchor type onto a single gRPC Geyser subscribe stream,
 * rather than one `grpcAccountSubscriber` per account. Optional generic `U` ("account props")
 * lets a caller attach metadata (e.g. `OracleInfo`) per pubkey — or per **array** of `U` values
 * for a pubkey backing multiple logical entries (see `accountPropsMap`, used when several oracle
 * ids share one underlying account). Construct via the static `create` factory, not the
 * constructor directly, since establishing the gRPC client is asynchronous. Accounts can be added/
 * removed from an already-open stream via `addAccounts`/`removeAccounts` without a full resubscribe.
 */
export class grpcMultiAccountSubscriber<T, U = undefined> {
	private client: Client;
	private _stream?: ClientDuplexStream;
	private get stream(): ClientDuplexStream {
		if (!this._stream) {
			throw new Error(
				'grpcMultiAccountSubscriber: stream accessed before subscribe()'
			);
		}
		return this._stream;
	}
	private commitmentLevel: CommitmentLevel;
	private program: VelocityProgram;
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
		(
			data: T,
			context: Context,
			buffer: Buffer,
			accountProps: U | undefined
		) => void
	>();

	private dataMap = new Map<string, DataAndSlot<T>>();
	private accountPropsMap = new Map<string, U | Array<U>>();
	private bufferMap = new Map<string, BufferAndSlot>();

	private constructor(
		client: Client,
		commitmentLevel: CommitmentLevel,
		accountName: string,
		program: VelocityProgram,
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
		if (accountPropsMap) {
			this.accountPropsMap = accountPropsMap;
		}
	}

	/**
	 * Creates a gRPC client (or reuses `clientProp`) and constructs a `grpcMultiAccountSubscriber`.
	 * Does not itself start streaming — call `subscribe(accounts, onChange)` on the result.
	 * @param grpcConfigs gRPC Geyser endpoint/token/commitment config (Yellowstone or LaserStream).
	 * @param accountName Anchor account type name all multiplexed accounts share, used for decoding via the program coder absent `decodeBuffer`.
	 * @param program Anchor program providing the connection (for `fetch()`) and coder.
	 * @param decodeBuffer Optional custom decode function receiving the buffer, the account's base58 pubkey, and its `accountProps` entry (or one element of it, if an array); defaults to `program.coder.accounts.decode(accountName, buffer)`.
	 * @param resubOpts Resubscription watchdog options; `resubTimeoutMs` triggers a full unsubscribe on inactivity (no automatic resubscribe here — see `onUnsubscribe`).
	 * @param clientProp Optional existing gRPC client to reuse instead of creating a new connection.
	 * @param onUnsubscribe Optional callback invoked after `unsubscribe()` completes (or the resub-timeout-driven unsubscribe fires), typically used by callers to drive their own resubscribe logic.
	 * @param accountPropsMap Optional per-pubkey metadata (or array of metadata, for a shared pubkey) passed through to `decodeBuffer` and the `subscribe`/`addAccounts` change callback.
	 */
	public static async create<T, U = undefined>(
		grpcConfigs: GrpcConfigs,
		accountName: string,
		program: VelocityProgram,
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

	/**
	 * Seeds or overwrites the cached data for one account, bypassing gRPC/RPC. Used to inject
	 * data the caller already has (e.g. from an initial batch fetch) before the stream delivers
	 * live updates.
	 * @param accountPubkey Base58 pubkey of the account.
	 * @param data Decoded account data to store.
	 * @param slot Slot the data was observed at; defaults to 0 (the seeded sentinel) if omitted.
	 */
	setAccountData(accountPubkey: string, data: T, slot?: number): void {
		this.dataMap.set(accountPubkey, { data, slot: slot ?? 0 });
	}

	/** Returns the cached data/slot for one account, or undefined if not yet loaded. */
	getAccountData(accountPubkey: string): DataAndSlot<T> | undefined {
		return this.dataMap.get(accountPubkey);
	}

	/** Returns the full map of base58 pubkey to cached data/slot for every multiplexed account. */
	getAccountDataMap(): Map<string, DataAndSlot<T>> {
		return this.dataMap;
	}

	/**
	 * Fetches every subscribed account once via chunked `getMultipleAccountsInfoAndContext` calls
	 * (100 pubkeys per chunk, processed concurrently), updating `dataMap`/`bufferMap` for any
	 * account whose buffer changed at a non-decreasing slot. Errors are logged (if
	 * `resubOpts.logResubMessages`) and swallowed rather than thrown.
	 */
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
							const prev = this.bufferMap.get(accountId);
							const newBuffer = accountInfo.data as Buffer;
							if (prev && currentSlot < prev.slot) {
								continue;
							}
							if (
								prev &&
								prev.buffer &&
								newBuffer &&
								newBuffer.equals(prev.buffer)
							) {
								continue;
							}
							this.bufferMap.set(accountId, {
								buffer: newBuffer,
								slot: currentSlot,
							});

							// decode via the injected decoder (with accountProps) so backfill
							// matches the live-update decode path — the stock program coder
							// can't decode custom-decoder accounts (e.g. oracle buffers). For a
							// pubkey backing multiple props, seed from the first (dataMap is
							// keyed by pubkey; see the accountPropsMap notes above).
							const accountProps = this.accountPropsMap?.get(accountId);
							const decodeProps = Array.isArray(accountProps)
								? accountProps[0]
								: accountProps;
							const accountDecoded = this.decodeBufferFn
								? this.decodeBufferFn(newBuffer, accountId, decodeProps)
								: this.program.coder.accounts.decode(
										this.accountName,
										newBuffer
								  );
							this.setAccountData(accountId, accountDecoded, currentSlot);
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

	/**
	 * Opens a single gRPC subscribe stream covering all of `accounts`. Each update is decoded and
	 * cached (via `setAccountData`) before `onChange` is invoked. Idempotent: a no-op if already
	 * subscribed or mid-unsubscribe.
	 * @param accounts Pubkeys to include in the stream filter.
	 * @param onChange Invoked once per changed account with its pubkey, decoded data, the notification's `Context` (including `slot`), the raw buffer, and any `accountProps` metadata registered for that pubkey.
	 */
	async subscribe(
		accounts: PublicKey[],
		onChange: (
			accountId: PublicKey,
			data: T,
			context: Context,
			buffer: Buffer,
			accountProps: U | undefined
		) => void
	): Promise<void> {
		if (this.resubOpts?.logResubMessages) {
			console.log(`[${this.accountName}] grpcMultiAccountSubscriber subscribe`);
		}
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

		this._stream =
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
			if (!chunk.account || !chunk.account.account) {
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

			// Touch resub timer on any incoming account update for subscribed keys
			if (this.resubOpts?.resubTimeoutMs) {
				this.receivingData = true;
				clearTimeout(this.timeoutId);
				this.setTimeout();
			}

			// Skip processing if we already have data for this account at a newer slot
			const existing = this.dataMap.get(accountPubkey);
			if (existing?.slot !== undefined && existing.slot > slot) {
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

			// Check existing buffer for this account and skip if unchanged or slot regressed
			const prevBuffer = this.bufferMap.get(accountPubkey);
			if (prevBuffer && slot < prevBuffer.slot) {
				return;
			}
			if (
				prevBuffer &&
				prevBuffer.buffer &&
				buffer &&
				buffer.equals(prevBuffer.buffer)
			) {
				return;
			}
			this.bufferMap.set(accountPubkey, { buffer, slot });
			const accountProps = this.accountPropsMap?.get(accountPubkey);

			const handleDataBuffer = (
				context: Context,
				buffer: Buffer,
				accountProps: U | undefined
			) => {
				const data = this.decodeBufferFn
					? this.decodeBufferFn(buffer, accountPubkey, accountProps)
					: this.program.coder.accounts.decode(this.accountName, buffer);
				const handler = this.onChangeMap.get(accountPubkey);
				if (handler) {
					handler(data, context, buffer, accountProps);
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
	 * Extends the already-open stream's filter to include `accounts` (re-writing the full
	 * accumulated filter set, since the gRPC protocol has no incremental "add" primitive), then
	 * immediately calls `fetch()` to backfill their initial data.
	 * @param accounts Additional pubkeys to start tracking.
	 * @param accountProps Optional per-pubkey metadata to merge into `accountPropsMap` so the
	 *   injected decoder can decode the newly added accounts (without it, a new `(pubkey, source)`
	 *   oracle would decode with missing `accountProps` and throw).
	 */
	async addAccounts(
		accounts: PublicKey[],
		accountProps?: Map<string, U | Array<U>>
	): Promise<void> {
		for (const pk of accounts) {
			this.subscribedAccounts.add(pk.toBase58());
		}
		if (accountProps) {
			for (const [key, props] of accountProps.entries()) {
				this.accountPropsMap.set(key, props);
			}
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
		await this.fetch();
	}

	/**
	 * Removes `accounts` from `subscribedAccounts`/`onChangeMap` and re-writes the stream's filter
	 * to exclude them. Does not clear their cached data from `dataMap`/`bufferMap`.
	 * @param accounts Pubkeys to stop tracking.
	 */
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

	/** Writes an empty subscribe request to clear the stream's account filter, cancels any pending resub timeout, and invokes `onUnsubscribe` if one was registered at construction. */
	async unsubscribe(): Promise<void> {
		this.isUnsubscribing = true;
		clearTimeout(this.timeoutId);
		this.timeoutId = undefined;

		try {
			if (this.listenerId != null) {
				await new Promise<void>((resolve, reject) => {
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

			// invoke onUnsubscribe on the normal path too (previously it only ran when
			// listenerId was already null, so the resubscribe hook never fired on the
			// standard unsubscribe path)
			if (this.onUnsubscribe) {
				try {
					await this.onUnsubscribe();
				} catch (e) {
					console.error(e);
				}
			}
		} finally {
			// clear the flag on every exit path, including a failed stream.write, so
			// the instance isn't wedged and can resubscribe
			this.isUnsubscribing = false;
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
}
