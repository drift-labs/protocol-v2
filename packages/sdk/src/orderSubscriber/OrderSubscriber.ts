import { VelocityClient } from '../velocityClient';
import { UserAccount } from '../types';
import {
	getNonIdleUserFilter,
	getUserFilter,
	getUserWithOrderFilter,
} from '../memcmp';
import { Commitment, PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { DLOB } from '../dlob/DLOB';
import { OrderSubscriberConfig, OrderSubscriberEvents } from './types';
import { PollingSubscription } from './PollingSubscription';
import { WebsocketSubscription } from './WebsocketSubscription';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { BN } from '../isomorphic/anchor';
import { decodeUser } from '../decode/user';
import { grpcSubscription } from './grpcSubscription';
import { calculateOrderBaseAssetAmount } from '../math/orders';
import { ZERO } from '../constants/numericConstants';

/*
 * Byte offset of `lastActiveSlot` (u64) in the `User` account, used here to
 * cheaply detect stale updates without fully decoding the buffer. Must match
 * the on-chain `User` layout (see `decode/user.ts`). The previous value (4328)
 * was for the older 4376-byte layout; the current Velocity layout is 4496
 * bytes, shifting this field +120 bytes. With the wrong offset this read 8
 * zero-padding bytes, so the staleness guard rejected every post-load update.
 */
const USER_LAST_ACTIVE_SLOT_OFFSET = 4448;

/**
 * OrderSubscriber — maintains a live, in-memory map of every `User` account
 * (and therefore every open order) on the program, refreshed via polling,
 * websocket program-account subscription, or gRPC/Laserstream, depending on
 * `config.subscriptionConfig.type`. Used by keeper bots and `DLOBSubscriber`
 * to build a full DLOB without individually subscribing to each trader's
 * `User` account. Emits `orderCreated`/`userUpdated`/`updateReceived` on
 * `eventEmitter` as updates arrive; see `OrderSubscriberEvents`.
 */
export class OrderSubscriber {
	velocityClient: VelocityClient;
	usersAccounts = new Map<string, { slot: number; userAccount: UserAccount }>();
	subscription: PollingSubscription | WebsocketSubscription | grpcSubscription;
	commitment: Commitment;
	eventEmitter: StrictEventEmitter<EventEmitter, OrderSubscriberEvents>;

	fetchPromise?: Promise<void>;
	private fetchPromiseResolver: () => void = () => {};

	mostRecentSlot = 0;
	decodeFn: (name: string, data: Buffer) => UserAccount;
	decodeData?: boolean;

	fetchAllNonIdleUsers?: boolean;

	/**
	 * @param config Subscription config. `subscriptionConfig.type` selects the transport (`'polling'`, `'websocket'`, or `'grpc'`); `fastDecode` (default `true`) uses the hand-written `decodeUser` fast path instead of the Anchor coder; `fetchAllNonIdleUsers` (default `false`) widens the account filter from "has at least one order" to "any non-idle user", useful for consumers that need idle-but-active accounts too.
	 * @throws If `config.velocityClient` is not provided.
	 */
	constructor(config: OrderSubscriberConfig) {
		const velocityClient = config.velocityClient;
		if (!velocityClient) {
			throw new Error('OrderSubscriber: velocityClient must be provided');
		}
		this.velocityClient = velocityClient;
		this.commitment = config.subscriptionConfig.commitment || 'processed';
		if (config.subscriptionConfig.type === 'polling') {
			this.subscription = new PollingSubscription({
				orderSubscriber: this,
				frequency: config.subscriptionConfig.frequency,
			});
		} else if (config.subscriptionConfig.type === 'grpc') {
			this.subscription = new grpcSubscription({
				orderSubscriber: this,
				grpcConfigs: config.subscriptionConfig.grpcConfigs,
				skipInitialLoad: config.subscriptionConfig.skipInitialLoad,
				resubOpts: {
					resubTimeoutMs: config.subscriptionConfig?.resubTimeoutMs,
					logResubMessages: config.subscriptionConfig?.logResubMessages,
				},
				resyncIntervalMs: config.subscriptionConfig.resyncIntervalMs,
				decoded: config.decodeData,
			});
		} else {
			this.subscription = new WebsocketSubscription({
				orderSubscriber: this,
				commitment: this.commitment,
				skipInitialLoad: config.subscriptionConfig.skipInitialLoad,
				resubOpts: {
					resubTimeoutMs: config.subscriptionConfig?.resubTimeoutMs,
					logResubMessages: config.subscriptionConfig?.logResubMessages,
				},
				resyncIntervalMs: config.subscriptionConfig.resyncIntervalMs,
				decoded: config.decodeData,
			});
		}
		if (config.fastDecode ?? true) {
			this.decodeFn = (name, data) => decodeUser(data);
		} else {
			this.decodeFn = (
				this.velocityClient.program.account as any
			).user.coder.accounts.decodeUnchecked.bind(
				(this.velocityClient.program.account as any).user.coder.accounts
			);
		}
		this.eventEmitter = new EventEmitter();
		this.fetchAllNonIdleUsers = config.fetchAllNonIdleUsers;
	}

	/** Starts the underlying transport (polling interval, websocket program-account subscription, or gRPC stream) chosen at construction time. */
	public async subscribe(): Promise<void> {
		await this.subscription.subscribe();
	}

	/**
	 * One-shot full refresh: fetches every `User` account matching the
	 * configured filters via `getProgramAccounts` and feeds each through
	 * `tryUpdateUserAccount`. Concurrent calls share the in-flight promise
	 * rather than issuing a second `getProgramAccounts` request. Errors are
	 * caught and logged, not thrown — the promise still resolves.
	 */
	async fetch(): Promise<void> {
		if (this.fetchPromise) {
			return this.fetchPromise;
		}

		this.fetchPromise = new Promise((resolver) => {
			this.fetchPromiseResolver = resolver;
		});

		const filters = this.fetchAllNonIdleUsers
			? [getUserFilter(), getNonIdleUserFilter()]
			: [getUserFilter(), getUserWithOrderFilter()];

		try {
			const rpcRequestArgs = [
				this.velocityClient.program.programId.toBase58(),
				{
					commitment: this.commitment,
					filters,
					encoding: 'base64',
					withContext: true,
				},
			];

			const rpcJSONResponse: any =
				// @ts-ignore
				await this.velocityClient.connection._rpcRequest(
					'getProgramAccounts',
					rpcRequestArgs
				);

			const rpcResponseAndContext: RpcResponseAndContext<
				Array<{
					pubkey: PublicKey;
					account: {
						data: [string, string];
					};
				}>
			> = rpcJSONResponse.result;

			const slot: number = rpcResponseAndContext.context.slot;

			for (const programAccount of rpcResponseAndContext.value) {
				const key = programAccount.pubkey.toString();
				this.tryUpdateUserAccount(
					key,
					'raw',
					programAccount.account.data,
					slot
				);
				// give event loop a chance to breathe
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		} catch (e) {
			console.error(e);
		} finally {
			this.fetchPromiseResolver();
			this.fetchPromise = undefined;
		}
	}

	/**
	 * Applies an incoming update for the `User` account `key`, called by
	 * `fetch`, `addPubkey`, and each subscription transport
	 * (`PollingSubscription`/`WebsocketSubscription`/`grpcSubscription`).
	 * Advances `mostRecentSlot` and always emits `updateReceived`. The stored
	 * account is only replaced if `slot` is >= the currently cached slot for
	 * that key; for `'raw'`/`'buffer'` inputs, before decoding it also cheaply
	 * peeks the account's `lastActiveSlot` field at a fixed byte offset and
	 * discards the update if that's older than what's cached, without paying
	 * the cost of a full decode. On acceptance, emits `userUpdated`, and
	 * `orderCreated` for any orders in the account whose `order.slot` falls in
	 * `(previousSlot, slot]`.
	 * @param key Base58 pubkey of the `User` account.
	 * @param dataType `'raw'` (base64/base58 tuple from `getProgramAccounts`), `'decoded'` (already an Anchor-decoded `UserAccount`), or `'buffer'` (raw account bytes) — determines how `data` is interpreted/decoded.
	 * @param data The account payload, shaped per `dataType`.
	 * @param slot Slot the update was observed at.
	 */
	tryUpdateUserAccount(
		key: string,
		dataType: 'raw' | 'decoded' | 'buffer',
		data: string[] | UserAccount | Buffer,
		slot: number
	): void {
		if (!this.mostRecentSlot || slot > this.mostRecentSlot) {
			this.mostRecentSlot = slot;
		}

		this.eventEmitter.emit(
			'updateReceived',
			new PublicKey(key),
			slot,
			dataType
		);

		const slotAndUserAccount = this.usersAccounts.get(key);
		if (!slotAndUserAccount || slotAndUserAccount.slot <= slot) {
			let userAccount: UserAccount;
			// Polling leads to a lot of redundant decoding, so we only decode if data is from a fresh slot
			if (dataType === 'raw') {
				// @ts-ignore
				const buffer = Buffer.from(data[0], data[1]);

				const newLastActiveSlot = new BN(
					buffer.subarray(
						USER_LAST_ACTIVE_SLOT_OFFSET,
						USER_LAST_ACTIVE_SLOT_OFFSET + 8
					),
					undefined,
					'le'
				);
				if (
					slotAndUserAccount &&
					slotAndUserAccount.userAccount.lastActiveSlot.gt(newLastActiveSlot)
				) {
					return;
				}

				userAccount = this.decodeFn('user', buffer) as UserAccount;
			} else if (dataType === 'buffer') {
				const buffer: Buffer = data as Buffer;
				const newLastActiveSlot = new BN(
					buffer.subarray(
						USER_LAST_ACTIVE_SLOT_OFFSET,
						USER_LAST_ACTIVE_SLOT_OFFSET + 8
					),
					undefined,
					'le'
				);
				if (
					slotAndUserAccount &&
					slotAndUserAccount.userAccount.lastActiveSlot.gt(newLastActiveSlot)
				) {
					return;
				}

				userAccount = this.decodeFn('user', data as Buffer) as UserAccount;
			} else {
				userAccount = data as UserAccount;
			}

			this.eventEmitter.emit(
				'userUpdated',
				userAccount,
				new PublicKey(key),
				slot,
				dataType
			);

			const newOrders = userAccount.orders.filter(
				(order) =>
					order.slot.toNumber() > (slotAndUserAccount?.slot ?? 0) &&
					order.slot.toNumber() <= slot
			);
			if (newOrders.length > 0) {
				this.eventEmitter.emit(
					'orderCreated',
					userAccount,
					newOrders,
					new PublicKey(key),
					slot,
					dataType
				);
			}

			this.usersAccounts.set(key, { slot, userAccount });
		}
	}

	/**
	 * Creates a new DLOB for the order subscriber to fill. This will allow a
	 * caller to extend the DLOB Subscriber with a custom DLOB type.
	 * @returns New, empty DLOB object.
	 */
	protected createDLOB(): DLOB {
		return new DLOB();
	}

	/**
	 * Builds a fresh `DLOB` from the currently cached `User` accounts. For
	 * reduce-only orders, resolves the base asset amount against the trader's
	 * existing perp position (via `calculateOrderBaseAssetAmount`, `BASE_PRECISION`,
	 * 1e9) rather than trusting the order's own `baseAssetAmount` field, since a
	 * reduce-only order's fillable size is capped by the position it reduces.
	 * @param slot Slot to stamp onto inserted orders (used by the DLOB for auction/expiry timing, not for filtering which accounts are included).
	 * @returns A new `DLOB` populated with every order across all cached users.
	 */
	public async getDLOB(slot: number): Promise<DLOB> {
		const dlob = this.createDLOB();
		for (const [key, { userAccount }] of this.usersAccounts.entries()) {
			for (const order of userAccount.orders) {
				let baseAssetAmount = order.baseAssetAmount;
				if (order.reduceOnly) {
					const existingBaseAmount =
						userAccount.perpPositions.find(
							(pos) =>
								pos.marketIndex === order.marketIndex && pos.openOrders > 0
						)?.baseAssetAmount || ZERO;
					baseAssetAmount = calculateOrderBaseAssetAmount(
						order,
						existingBaseAmount
					);
				}
				dlob.insertOrder(order, key, slot, baseAssetAmount);
			}
		}
		return dlob;
	}

	/** @returns The highest slot observed across all account updates so far, or 0 if none have arrived yet. */
	public getSlot(): number {
		return this.mostRecentSlot ?? 0;
	}

	/** Fetches a single `User` account directly (bypassing the subscription's filters) and applies it via `tryUpdateUserAccount`. Useful to backfill an account this subscriber's filters would otherwise exclude (e.g. an idle user with no orders). No-ops if the account doesn't exist. */
	public async addPubkey(userAccountPublicKey: PublicKey): Promise<void> {
		const accountInfo =
			await this.velocityClient.connection.getAccountInfoAndContext(
				userAccountPublicKey,
				this.commitment
			);
		if (accountInfo.value) {
			this.tryUpdateUserAccount(
				userAccountPublicKey.toString(),
				'buffer',
				accountInfo.value.data,
				accountInfo.context.slot
			);
		}
	}

	/**
	 * Returns the cached `UserAccount` for `key`, fetching it on demand via
	 * `addPubkey` if not already cached.
	 * @param key Base58 pubkey of the `User` account.
	 * @throws If the account still isn't present after `addPubkey` (e.g. it doesn't exist on-chain).
	 */
	public async mustGetUserAccount(key: string): Promise<UserAccount> {
		if (!this.usersAccounts.has(key)) {
			await this.addPubkey(new PublicKey(key));
		}
		const slotAndUserAccount = this.usersAccounts.get(key);
		if (!slotAndUserAccount) {
			throw new Error(
				`OrderSubscriber: user account ${key} not found after addPubkey`
			);
		}
		return slotAndUserAccount.userAccount;
	}

	/** Stops the underlying transport and clears the entire cached `User` account map. */
	public async unsubscribe(): Promise<void> {
		this.usersAccounts.clear();
		await this.subscription.unsubscribe();
	}
}
