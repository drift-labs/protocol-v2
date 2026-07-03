import {
	AccountSubscriber,
	DataAndSlot,
	DelistedMarketSetting,
	VelocityClientAccountEvents,
	VelocityClientAccountSubscriber,
	NotSubscribedError,
	ResubOpts,
} from './types';
import { PerpMarketAccount, SpotMarketAccount, StateAccount } from '../types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	getVelocityStateAccountPublicKey,
	getPerpMarketPublicKey,
	getPerpMarketPublicKeySync,
	getSpotMarketPublicKey,
	getSpotMarketPublicKeySync,
} from '../addresses/pda';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { AccountInfo, Commitment, PublicKey } from '@solana/web3.js';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { OracleClientCache } from '../oracles/oracleClientCache';
import * as Buffer from 'buffer';
import { QUOTE_ORACLE_PRICE_DATA } from '../oracles/quoteAssetOracleClient';
import { findAllMarketAndOracles, VelocityProgram } from '../config';
import { findDelistedPerpMarketsAndOracles } from './utils';
import { getOracleId } from '../oracles/oracleId';
import { OracleSource } from '../types';
import { WebSocketAccountSubscriberV2 } from './webSocketAccountSubscriberV2';

const ORACLE_DEFAULT_ID = getOracleId(
	PublicKey.default,
	OracleSource.QUOTE_ASSET
);

async function ensureAccountFetched<T>(
	subscriber: AccountSubscriber<T>,
	maxAttempts = 5,
	delayMs = 200
): Promise<void> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (subscriber.dataAndSlot?.data !== undefined) {
			return;
		}
		try {
			await subscriber.fetch();
		} catch {
			// retry below
		}
		if (subscriber.dataAndSlot?.data !== undefined) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
}

/**
 * Default `VelocityClientAccountSubscriber` implementation: creates one `WebSocketAccountSubscriber`
 * per tracked `State`/`PerpMarket`/`SpotMarket`/oracle account, giving the lowest update latency
 * at the cost of one WebSocket subscription per account. Before subscribing each per-account
 * subscriber, `setInitialData()` batch-fetches all of them via `getMultipleAccountsInfo` so the
 * per-account `WebSocketAccountSubscriber.subscribe()` calls can seed from that data instead of
 * each issuing its own `getAccountInfo` round trip. `customPerpMarketAccountSubscriber`/
 * `customOracleAccountSubscriber` let a caller substitute `WebSocketAccountSubscriberV2` (or any
 * other `AccountSubscriber` implementation) for those two account types specifically.
 */
export class WebSocketVelocityClientAccountSubscriber
	implements VelocityClientAccountSubscriber
{
	isSubscribed: boolean;
	program: VelocityProgram;
	commitment?: Commitment;
	perpMarketIndexes: number[];
	spotMarketIndexes: number[];
	oracleInfos: OracleInfo[];
	oracleClientCache = new OracleClientCache();

	resubOpts?: ResubOpts;
	shouldFindAllMarketsAndOracles: boolean;

	eventEmitter: StrictEventEmitter<EventEmitter, VelocityClientAccountEvents>;
	stateAccountSubscriber?: AccountSubscriber<StateAccount>;
	perpMarketAccountSubscribers = new Map<
		number,
		AccountSubscriber<PerpMarketAccount>
	>();
	perpOracleMap = new Map<number, PublicKey>();
	perpOracleStringMap = new Map<number, string>();
	spotMarketAccountSubscribers = new Map<
		number,
		AccountSubscriber<SpotMarketAccount>
	>();
	spotOracleMap = new Map<number, PublicKey>();
	spotOracleStringMap = new Map<number, string>();
	oracleSubscribers = new Map<string, AccountSubscriber<OraclePriceData>>();
	delistedMarketSetting: DelistedMarketSetting;

	initialPerpMarketAccountData?: Map<number, PerpMarketAccount>;
	initialSpotMarketAccountData?: Map<number, SpotMarketAccount>;
	initialOraclePriceData?: Map<string, OraclePriceData>;
	customPerpMarketAccountSubscriber?: new (
		accountName: string,
		program: VelocityProgram,
		accountPublicKey: PublicKey,
		decodeBuffer?: (buffer: Buffer) => any,
		resubOpts?: ResubOpts,
		commitment?: Commitment
	) => AccountSubscriber<any>;
	customOracleAccountSubscriber?: new (
		accountName: string,
		program: VelocityProgram,
		accountPublicKey: PublicKey,
		decodeBuffer?: (buffer: Buffer) => any,
		resubOpts?: ResubOpts,
		commitment?: Commitment
	) => AccountSubscriber<any>;

	protected isSubscribing = false;
	protected subscriptionPromiseResolver: (val: boolean) => void = () => {};
	protected subscriptionPromise: Promise<boolean> = Promise.resolve(false);

	/**
	 * @param program Anchor program used to derive PDAs, decode accounts, and resolve oracle clients.
	 * @param perpMarketIndexes Perp market indexes to track, if `shouldFindAllMarketsAndOracles` is false.
	 * @param spotMarketIndexes Spot market indexes to track, if `shouldFindAllMarketsAndOracles` is false.
	 * @param oracleInfos Oracles to track up front, if `shouldFindAllMarketsAndOracles` is false.
	 * @param shouldFindAllMarketsAndOracles If true, `subscribe()` first discovers every market/oracle from on-chain state, ignoring the index/info args above.
	 * @param delistedMarketSetting Behavior applied to delisted perp markets/oracles after subscribing; see `DelistedMarketSetting`.
	 * @param resubOpts Resubscription watchdog options passed to every per-account `WebSocketAccountSubscriber`.
	 * @param commitment Commitment for every per-account subscription; defaults to the provider's configured commitment.
	 * @param customPerpMarketAccountSubscriber Optional alternate `AccountSubscriber` constructor (e.g. `WebSocketAccountSubscriberV2`) used for perp market accounts instead of the default `WebSocketAccountSubscriber`.
	 * @param customOracleAccountSubscriber Optional alternate `AccountSubscriber` constructor used for oracle accounts instead of the default `WebSocketAccountSubscriber`.
	 */
	public constructor(
		program: VelocityProgram,
		perpMarketIndexes: number[],
		spotMarketIndexes: number[],
		oracleInfos: OracleInfo[],
		shouldFindAllMarketsAndOracles: boolean,
		delistedMarketSetting: DelistedMarketSetting,
		resubOpts?: ResubOpts,
		commitment?: Commitment,
		customPerpMarketAccountSubscriber?: new (
			accountName: string,
			program: VelocityProgram,
			accountPublicKey: PublicKey,
			decodeBuffer?: (buffer: Buffer) => any,
			resubOpts?: ResubOpts,
			commitment?: Commitment
		) => WebSocketAccountSubscriberV2<any> | WebSocketAccountSubscriber<any>,
		customOracleAccountSubscriber?: new (
			accountName: string,
			program: VelocityProgram,
			accountPublicKey: PublicKey,
			decodeBuffer?: (buffer: Buffer) => any,
			resubOpts?: ResubOpts,
			commitment?: Commitment
		) => WebSocketAccountSubscriberV2<any> | WebSocketAccountSubscriber<any>
	) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.perpMarketIndexes = perpMarketIndexes;
		this.spotMarketIndexes = spotMarketIndexes;
		this.oracleInfos = oracleInfos;
		this.shouldFindAllMarketsAndOracles = shouldFindAllMarketsAndOracles;
		this.delistedMarketSetting = delistedMarketSetting;
		this.resubOpts = resubOpts;
		this.commitment = commitment;
		this.customPerpMarketAccountSubscriber = customPerpMarketAccountSubscriber;
		this.customOracleAccountSubscriber = customOracleAccountSubscriber;
	}

	/**
	 * Subscribes the `State` account, batch-seeds all market/oracle accounts via `setInitialData()`,
	 * then subscribes every per-account `WebSocketAccountSubscriber` (or the custom subscriber
	 * class, if configured) for perp markets, spot markets, and oracles. Applies
	 * `delistedMarketSetting` afterward. Idempotent: a no-op if already subscribed, and concurrent
	 * calls while a subscribe is in flight share the same result via `subscriptionPromise` rather
	 * than issuing duplicate subscriptions. Always resolves `true` (no retry/failure path — a
	 * per-account fetch failure surfaces via `ensureAccountFetched`'s retries, not by aborting
	 * subscribe).
	 */
	public async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (this.isSubscribing) {
			return await this.subscriptionPromise;
		}

		this.isSubscribing = true;

		this.subscriptionPromise = new Promise((res) => {
			this.subscriptionPromiseResolver = res;
		});

		if (this.shouldFindAllMarketsAndOracles) {
			const {
				perpMarketIndexes,
				perpMarketAccounts,
				spotMarketIndexes,
				spotMarketAccounts,
				oracleInfos,
			} = await findAllMarketAndOracles(this.program);
			this.perpMarketIndexes = perpMarketIndexes;
			this.spotMarketIndexes = spotMarketIndexes;
			this.oracleInfos = oracleInfos;
			// front run and set the initial data here to save extra gma call in set initial data
			this.initialPerpMarketAccountData = new Map(
				perpMarketAccounts.map((market) => [market.marketIndex, market])
			);
			this.initialSpotMarketAccountData = new Map(
				spotMarketAccounts.map((market) => [market.marketIndex, market])
			);
		}

		const statePublicKey = await getVelocityStateAccountPublicKey(
			this.program.programId
		);

		// create and activate main state account subscription
		this.stateAccountSubscriber = new WebSocketAccountSubscriber(
			'state',
			this.program,
			statePublicKey,
			undefined,
			undefined,
			this.commitment
		);
		await this.stateAccountSubscriber.subscribe((data: StateAccount) => {
			this.eventEmitter.emit('stateAccountUpdate', data);
			this.eventEmitter.emit('update');
		});

		// set initial data to avoid spamming getAccountInfo calls in webSocketAccountSubscriber
		await this.setInitialData();

		await Promise.all([
			// subscribe to market accounts
			this.subscribeToPerpMarketAccounts(),
			// subscribe to spot market accounts
			this.subscribeToSpotMarketAccounts(),
			// subscribe to oracles
			this.subscribeToOracles(),
		]);

		this.eventEmitter.emit('update');

		await this.handleDelistedMarkets();

		await Promise.all([this.setPerpOracleMap(), this.setSpotOracleMap()]);

		this.isSubscribing = false;
		this.isSubscribed = true;
		this.subscriptionPromiseResolver(true);

		// delete initial data
		this.removeInitialData();

		return true;
	}

	chunks = <T>(array: readonly T[], size: number): T[][] => {
		return new Array(Math.ceil(array.length / size))
			.fill(null)
			.map((_, index) => index * size)
			.map((begin) => array.slice(begin, begin + size));
	};

	/**
	 * Batch-fetches every tracked perp market, spot market, and oracle account via chunked
	 * `getMultipleAccountsInfo` calls (75 pubkeys per chunk) and stashes the decoded results in
	 * `initialPerpMarketAccountData`/`initialSpotMarketAccountData`/`initialOraclePriceData`.
	 * Each per-account `WebSocketAccountSubscriber.subscribe()` call seeds from this data via
	 * `setData` instead of issuing its own `getAccountInfo` round trip. Skips markets already
	 * populated (e.g. by `findAllMarketAndOracles` when `shouldFindAllMarketsAndOracles` is set).
	 */
	async setInitialData(): Promise<void> {
		const connection = this.program.provider.connection;

		if (!this.initialPerpMarketAccountData) {
			const perpMarketPublicKeys = this.perpMarketIndexes.map((marketIndex) =>
				getPerpMarketPublicKeySync(this.program.programId, marketIndex)
			);
			const perpMarketPublicKeysChunks = this.chunks(perpMarketPublicKeys, 75);
			const perpMarketAccountInfos = (
				await Promise.all(
					perpMarketPublicKeysChunks.map((perpMarketPublicKeysChunk) =>
						connection.getMultipleAccountsInfo(perpMarketPublicKeysChunk)
					)
				)
			).flat();
			this.initialPerpMarketAccountData = new Map(
				perpMarketAccountInfos
					.filter(
						(accountInfo): accountInfo is AccountInfo<Buffer> => !!accountInfo
					)
					.map((accountInfo) => {
						const perpMarket = this.program.coder.accounts.decode(
							'perpMarket',
							accountInfo.data
						);
						return [perpMarket.marketIndex, perpMarket];
					})
			);
		}

		if (!this.initialSpotMarketAccountData) {
			const spotMarketPublicKeys = this.spotMarketIndexes.map((marketIndex) =>
				getSpotMarketPublicKeySync(this.program.programId, marketIndex)
			);
			const spotMarketPublicKeysChunks = this.chunks(spotMarketPublicKeys, 75);
			const spotMarketAccountInfos = (
				await Promise.all(
					spotMarketPublicKeysChunks.map((spotMarketPublicKeysChunk) =>
						connection.getMultipleAccountsInfo(spotMarketPublicKeysChunk)
					)
				)
			).flat();
			this.initialSpotMarketAccountData = new Map(
				spotMarketAccountInfos
					.filter(
						(accountInfo): accountInfo is AccountInfo<Buffer> => !!accountInfo
					)
					.map((accountInfo) => {
						const spotMarket = this.program.coder.accounts.decode(
							'spotMarket',
							accountInfo.data
						);
						return [spotMarket.marketIndex, spotMarket];
					})
			);
		}

		const oracleAccountPubkeyChunks = this.chunks(
			this.oracleInfos.map((oracleInfo) => oracleInfo.publicKey),
			75
		);
		const oracleAccountInfos = (
			await Promise.all(
				oracleAccountPubkeyChunks.map((oracleAccountPublicKeysChunk) =>
					connection.getMultipleAccountsInfo(oracleAccountPublicKeysChunk)
				)
			)
		).flat();
		this.initialOraclePriceData = new Map(
			this.oracleInfos.reduce(
				(result, oracleInfo, i) => {
					const oracleAccountInfo = oracleAccountInfos[i];
					if (!oracleAccountInfo) {
						return result;
					}

					const oracleClient = this.oracleClientCache.get(
						oracleInfo.source,
						connection,
						this.program
					);
					if (!oracleClient) {
						return result;
					}

					const oraclePriceData = oracleClient.getOraclePriceDataFromBuffer(
						oracleAccountInfo.data
					);

					result.push([
						getOracleId(oracleInfo.publicKey, oracleInfo.source),
						oraclePriceData,
					]);
					return result;
				},
				[] as [string, OraclePriceData][]
			)
		);
	}

	/** Clears the seed data stashed by `setInitialData()` once every per-account subscriber has consumed it, freeing the memory. */
	removeInitialData() {
		this.initialPerpMarketAccountData = new Map();
		this.initialSpotMarketAccountData = new Map();
		this.initialOraclePriceData = new Map();
	}

	/** Subscribes a `WebSocketAccountSubscriber` for every tracked perp market index, in parallel. */
	async subscribeToPerpMarketAccounts(): Promise<boolean> {
		await Promise.all(
			this.perpMarketIndexes.map((marketIndex) =>
				this.subscribeToPerpMarketAccount(marketIndex)
			)
		);
		return true;
	}

	/**
	 * Creates and subscribes the per-account subscriber (custom class if `customPerpMarketAccountSubscriber`
	 * is set, else `WebSocketAccountSubscriber`) for one perp market, seeding it from
	 * `initialPerpMarketAccountData` if available, and waits (via `ensureAccountFetched`, up to 5
	 * retries with a 200ms backoff) for data to actually land before returning.
	 * @param marketIndex Perp market index to subscribe.
	 */
	async subscribeToPerpMarketAccount(marketIndex: number): Promise<boolean> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			marketIndex
		);
		const AccountSubscriberClass =
			this.customPerpMarketAccountSubscriber || WebSocketAccountSubscriber;
		const accountSubscriber = new AccountSubscriberClass<PerpMarketAccount>(
			'perpMarket',
			this.program,
			perpMarketPublicKey,
			undefined,
			this.resubOpts,
			this.commitment
		);
		const initialPerpMarketData =
			this.initialPerpMarketAccountData?.get(marketIndex);
		if (initialPerpMarketData) {
			accountSubscriber.setData(initialPerpMarketData);
		}
		await accountSubscriber.subscribe((data: PerpMarketAccount) => {
			this.eventEmitter.emit('perpMarketAccountUpdate', data);
			this.eventEmitter.emit('update');
		});
		await ensureAccountFetched(accountSubscriber);
		this.perpMarketAccountSubscribers.set(marketIndex, accountSubscriber);
		return true;
	}

	/** Subscribes a `WebSocketAccountSubscriber` for every tracked spot market index, in parallel. */
	async subscribeToSpotMarketAccounts(): Promise<boolean> {
		await Promise.all(
			this.spotMarketIndexes.map((marketIndex) =>
				this.subscribeToSpotMarketAccount(marketIndex)
			)
		);
		return true;
	}

	/**
	 * Creates and subscribes a `WebSocketAccountSubscriber` for one spot market, seeding it from
	 * `initialSpotMarketAccountData` if available, and waits (via `ensureAccountFetched`) for data
	 * to land before returning.
	 * @param marketIndex Spot market index to subscribe.
	 */
	async subscribeToSpotMarketAccount(marketIndex: number): Promise<boolean> {
		const marketPublicKey = await getSpotMarketPublicKey(
			this.program.programId,
			marketIndex
		);
		const accountSubscriber = new WebSocketAccountSubscriber<SpotMarketAccount>(
			'spotMarket',
			this.program,
			marketPublicKey,
			undefined,
			this.resubOpts,
			this.commitment
		);
		const initialSpotMarketData =
			this.initialSpotMarketAccountData?.get(marketIndex);
		if (initialSpotMarketData) {
			accountSubscriber.setData(initialSpotMarketData);
		}
		await accountSubscriber.subscribe((data: SpotMarketAccount) => {
			this.eventEmitter.emit('spotMarketAccountUpdate', data);
			this.eventEmitter.emit('update');
		});
		await ensureAccountFetched(accountSubscriber);
		this.spotMarketAccountSubscribers.set(marketIndex, accountSubscriber);
		return true;
	}

	/** Subscribes an account subscriber for every tracked oracle, in parallel, skipping the `PublicKey.default` (quote-asset "no oracle") sentinel. */
	async subscribeToOracles(): Promise<boolean> {
		await Promise.all(
			this.oracleInfos
				.filter((oracleInfo) => !oracleInfo.publicKey.equals(PublicKey.default))
				.map((oracleInfo) => this.subscribeToOracle(oracleInfo))
		);

		return true;
	}

	/**
	 * Creates and subscribes the per-account subscriber (custom class if `customOracleAccountSubscriber`
	 * is set, else `WebSocketAccountSubscriber`) for one oracle, decoding buffers with the
	 * source-appropriate `OracleClient`. Seeds from `initialOraclePriceData` if available and
	 * waits (via `ensureAccountFetched`) for data to land before returning.
	 * @param oracleInfo Oracle pubkey and source to subscribe.
	 * @returns `false` if no `OracleClient` is registered for `oracleInfo.source`; otherwise `true`.
	 */
	async subscribeToOracle(oracleInfo: OracleInfo): Promise<boolean> {
		const oracleId = getOracleId(oracleInfo.publicKey, oracleInfo.source);
		const client = this.oracleClientCache.get(
			oracleInfo.source,
			this.program.provider.connection,
			this.program
		);
		if (!client) {
			return false;
		}
		const AccountSubscriberClass =
			this.customOracleAccountSubscriber || WebSocketAccountSubscriber;
		const accountSubscriber = new AccountSubscriberClass<OraclePriceData>(
			'oracle',
			this.program,
			oracleInfo.publicKey,
			(buffer: Buffer) => {
				return client.getOraclePriceDataFromBuffer(buffer);
			},
			this.resubOpts,
			this.commitment
		);
		const initialOraclePriceData = this.initialOraclePriceData?.get(oracleId);
		if (initialOraclePriceData) {
			accountSubscriber.setData(initialOraclePriceData);
		}
		await accountSubscriber.subscribe((data: OraclePriceData) => {
			this.eventEmitter.emit(
				'oraclePriceUpdate',
				oracleInfo.publicKey,
				oracleInfo.source,
				data
			);
			this.eventEmitter.emit('update');
		});
		await ensureAccountFetched(accountSubscriber);

		this.oracleSubscribers.set(oracleId, accountSubscriber);
		return true;
	}

	/** Unsubscribes every per-account subscriber tracking a perp market, in parallel. */
	async unsubscribeFromMarketAccounts(): Promise<void> {
		await Promise.all(
			Array.from(this.perpMarketAccountSubscribers.values()).map(
				(accountSubscriber) => accountSubscriber.unsubscribe()
			)
		);
	}

	/** Unsubscribes every per-account subscriber tracking a spot market, in parallel. */
	async unsubscribeFromSpotMarketAccounts(): Promise<void> {
		await Promise.all(
			Array.from(this.spotMarketAccountSubscribers.values()).map(
				(accountSubscriber) => accountSubscriber.unsubscribe()
			)
		);
	}

	/** Unsubscribes every per-account subscriber tracking an oracle, in parallel. */
	async unsubscribeFromOracles(): Promise<void> {
		await Promise.all(
			Array.from(this.oracleSubscribers.values()).map((accountSubscriber) =>
				accountSubscriber.unsubscribe()
			)
		);
	}

	/** Fetches the `State` account and every subscribed perp/spot market's `WebSocketAccountSubscriber` in parallel. A no-op if not subscribed. Oracle accounts are not re-fetched here (they update via their own WS notifications). */
	public async fetch(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		if (!this.stateAccountSubscriber) {
			return;
		}

		const promises = [this.stateAccountSubscriber.fetch()]
			.concat(
				Array.from(this.perpMarketAccountSubscribers.values()).map(
					(subscriber) => subscriber.fetch()
				)
			)
			.concat(
				Array.from(this.spotMarketAccountSubscribers.values()).map(
					(subscriber) => subscriber.fetch()
				)
			);

		await Promise.all(promises);
	}

	/** Tears down the `State` subscriber and every per-account market/oracle subscriber. A no-op if not subscribed. */
	public async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await this.stateAccountSubscriber?.unsubscribe();

		await this.unsubscribeFromMarketAccounts();
		await this.unsubscribeFromSpotMarketAccounts();
		await this.unsubscribeFromOracles();

		this.isSubscribed = false;
	}

	/**
	 * Adds a spot market (and its oracle, via `setSpotOracleMap`) to be tracked, subscribing a new
	 * `WebSocketAccountSubscriber` for it. Idempotent: returns `true` immediately if already tracked.
	 * @param marketIndex Spot market index to start tracking.
	 */
	async addSpotMarket(marketIndex: number): Promise<boolean> {
		if (this.spotMarketAccountSubscribers.has(marketIndex)) {
			return true;
		}
		const subscriptionSuccess = await this.subscribeToSpotMarketAccount(
			marketIndex
		);
		await this.setSpotOracleMap();
		return subscriptionSuccess;
	}

	/**
	 * Adds a perp market (and its oracle, via `setPerpOracleMap`) to be tracked, subscribing a new
	 * `WebSocketAccountSubscriber` for it. Idempotent: returns `true` immediately if already tracked.
	 * @param marketIndex Perp market index to start tracking.
	 */
	async addPerpMarket(marketIndex: number): Promise<boolean> {
		if (this.perpMarketAccountSubscribers.has(marketIndex)) {
			return true;
		}
		const subscriptionSuccess = await this.subscribeToPerpMarketAccount(
			marketIndex
		);
		await this.setPerpOracleMap();
		return subscriptionSuccess;
	}

	/**
	 * Adds an oracle to be tracked, subscribing a new per-account subscriber for it. A no-op that
	 * resolves `true` immediately for the `PublicKey.default` sentinel (quote-asset "no oracle")
	 * or an oracle already tracked.
	 * @param oracleInfo Oracle pubkey and source to start tracking.
	 */
	async addOracle(oracleInfo: OracleInfo): Promise<boolean> {
		const oracleId = getOracleId(oracleInfo.publicKey, oracleInfo.source);
		if (this.oracleSubscribers.has(oracleId)) {
			return true;
		}

		if (oracleInfo.publicKey.equals(PublicKey.default)) {
			return true;
		}

		return this.subscribeToOracle(oracleInfo);
	}

	/** Rebuilds `perpOracleMap`/`perpOracleStringMap` from currently cached perp markets, calling `addOracle` for any oracle not yet tracked. */
	async setPerpOracleMap() {
		const perpMarkets = this.getMarketAccountsAndSlots();
		const addOraclePromises = [];
		for (const perpMarket of perpMarkets) {
			if (!perpMarket || !perpMarket.data) {
				continue;
			}
			const perpMarketAccount = perpMarket.data;
			const perpMarketIndex = perpMarketAccount.marketIndex;
			const oracle = perpMarketAccount.oracle;
			const oracleId = getOracleId(oracle, perpMarket.data.oracleSource);
			if (!this.oracleSubscribers.has(oracleId)) {
				addOraclePromises.push(
					this.addOracle({
						publicKey: oracle,
						source: perpMarket.data.oracleSource,
					})
				);
			}
			this.perpOracleMap.set(perpMarketIndex, oracle);
			this.perpOracleStringMap.set(perpMarketIndex, oracleId);
		}
		await Promise.all(addOraclePromises);
	}

	/** Rebuilds `spotOracleMap`/`spotOracleStringMap` from currently cached spot markets, calling `addOracle` for any oracle not yet tracked. */
	async setSpotOracleMap() {
		const spotMarkets = this.getSpotMarketAccountsAndSlots();
		const addOraclePromises = [];
		for (const spotMarket of spotMarkets) {
			if (!spotMarket || !spotMarket.data) {
				continue;
			}
			const spotMarketAccount = spotMarket.data;
			const spotMarketIndex = spotMarketAccount.marketIndex;
			const oracle = spotMarketAccount.oracle;
			const oracleId = getOracleId(oracle, spotMarketAccount.oracleSource);
			if (!this.oracleSubscribers.has(oracleId)) {
				addOraclePromises.push(
					this.addOracle({
						publicKey: oracle,
						source: spotMarketAccount.oracleSource,
					})
				);
			}
			this.spotOracleMap.set(spotMarketIndex, oracle);
			this.spotOracleStringMap.set(spotMarketIndex, oracleId);
		}
		await Promise.all(addOraclePromises);
	}

	/**
	 * Applies `delistedMarketSetting` to any perp market currently `status: delisted` (and its
	 * oracle, if not shared with a live spot market): unsubscribes the per-account subscriber, and
	 * additionally drops it from `perpMarketAccountSubscribers`/`oracleSubscribers` if the setting
	 * is `Discard`. A no-op if the setting is `Subscribe`.
	 */
	async handleDelistedMarkets(): Promise<void> {
		if (this.delistedMarketSetting === DelistedMarketSetting.Subscribe) {
			return;
		}

		const { perpMarketIndexes, oracles } = findDelistedPerpMarketsAndOracles(
			this.getMarketAccountsAndSlots(),
			this.getSpotMarketAccountsAndSlots()
		);

		for (const perpMarketIndex of perpMarketIndexes) {
			await this.perpMarketAccountSubscribers
				.get(perpMarketIndex)
				?.unsubscribe();
			if (this.delistedMarketSetting === DelistedMarketSetting.Discard) {
				this.perpMarketAccountSubscribers.delete(perpMarketIndex);
			}
		}

		for (const oracle of oracles) {
			const oracleId = getOracleId(oracle.publicKey, oracle.source);
			await this.oracleSubscribers.get(oracleId)?.unsubscribe();
			if (this.delistedMarketSetting === DelistedMarketSetting.Discard) {
				this.oracleSubscribers.delete(oracleId);
			}
		}
	}

	/** Throws `NotSubscribedError` if `subscribe()` has not been called. */
	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	/** Throws `NotSubscribedError` if not subscribed, or a generic `Error` if subscribed but the `State` account hasn't loaded yet (should not normally happen after `subscribe()` resolves). */
	public getStateAccountAndSlot(): DataAndSlot<StateAccount> {
		this.assertIsSubscribed();
		const dataAndSlot = this.stateAccountSubscriber?.dataAndSlot;
		if (!dataAndSlot) {
			throw new Error('State account data not available');
		}
		return dataAndSlot;
	}

	/** Throws `NotSubscribedError` if not subscribed. Returns undefined if `marketIndex` isn't tracked (or hasn't loaded yet). */
	public getMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<PerpMarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.perpMarketAccountSubscribers.get(marketIndex)?.dataAndSlot;
	}

	/** Returns every currently cached (loaded) perp market. Does not throw `NotSubscribedError`. */
	public getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[] {
		return Array.from(this.perpMarketAccountSubscribers.values())
			.map((subscriber) => subscriber.dataAndSlot)
			.filter(
				(dataAndSlot): dataAndSlot is DataAndSlot<PerpMarketAccount> =>
					dataAndSlot !== undefined
			);
	}

	/** Throws `NotSubscribedError` if not subscribed. Returns undefined if `marketIndex` isn't tracked (or hasn't loaded yet). */
	public getSpotMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<SpotMarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.spotMarketAccountSubscribers.get(marketIndex)?.dataAndSlot;
	}

	/** Returns every currently cached (loaded) spot market. Does not throw `NotSubscribedError`. */
	public getSpotMarketAccountsAndSlots(): DataAndSlot<SpotMarketAccount>[] {
		return Array.from(this.spotMarketAccountSubscribers.values())
			.map((subscriber) => subscriber.dataAndSlot)
			.filter(
				(dataAndSlot): dataAndSlot is DataAndSlot<SpotMarketAccount> =>
					dataAndSlot !== undefined
			);
	}

	/**
	 * Looks up cached oracle price data by oracle id (see `getOracleId`). Special-cases the
	 * quote-asset default oracle id, returning the constant `QUOTE_ORACLE_PRICE_DATA` at slot 0
	 * rather than a subscriber lookup, since that oracle is never actually subscribed to.
	 * @param oracleId Oracle id string from `getOracleId(publicKey, source)`.
	 * @returns Cached price data/slot, or undefined if not tracked. Throws `NotSubscribedError` if not subscribed.
	 */
	public getOraclePriceDataAndSlot(
		oracleId: string
	): DataAndSlot<OraclePriceData> | undefined {
		this.assertIsSubscribed();
		if (oracleId === ORACLE_DEFAULT_ID) {
			return {
				data: QUOTE_ORACLE_PRICE_DATA,
				slot: 0,
			};
		}
		return this.oracleSubscribers.get(oracleId)?.dataAndSlot;
	}

	/**
	 * Convenience lookup: resolves the oracle price data currently mapped to a perp market's
	 * oracle. If the cached market's oracle pubkey has drifted from (or isn't yet in)
	 * `perpOracleMap`, triggers a background `setPerpOracleMap()` refresh and still returns the
	 * (possibly stale) mapping for this call.
	 * @param marketIndex Perp market index whose oracle price to look up.
	 */
	public getOraclePriceDataAndSlotForPerpMarket(
		marketIndex: number
	): DataAndSlot<OraclePriceData> | undefined {
		const perpMarketAccount = this.getMarketAccountAndSlot(marketIndex);
		const oracle = this.perpOracleMap.get(marketIndex);
		const oracleId = this.perpOracleStringMap.get(marketIndex);
		if (!perpMarketAccount || !oracleId) {
			return undefined;
		}

		if (!oracle || !perpMarketAccount.data.oracle.equals(oracle)) {
			// If the oracle has changed (or not yet cached), update the oracle map in background
			this.setPerpOracleMap();
		}

		return this.getOraclePriceDataAndSlot(oracleId);
	}

	/**
	 * Convenience lookup: resolves the oracle price data currently mapped to a spot market's
	 * oracle. If the cached market's oracle pubkey has drifted from (or isn't yet in)
	 * `spotOracleMap`, triggers a background `setSpotOracleMap()` refresh and still returns the
	 * (possibly stale) mapping for this call.
	 * @param marketIndex Spot market index whose oracle price to look up.
	 */
	public getOraclePriceDataAndSlotForSpotMarket(
		marketIndex: number
	): DataAndSlot<OraclePriceData> | undefined {
		const spotMarketAccount = this.getSpotMarketAccountAndSlot(marketIndex);
		const oracle = this.spotOracleMap.get(marketIndex);
		const oracleId = this.spotOracleStringMap.get(marketIndex);
		if (!spotMarketAccount || !oracleId) {
			return undefined;
		}

		if (!oracle || !spotMarketAccount.data.oracle.equals(oracle)) {
			// If the oracle has changed (or not yet cached), update the oracle map in background
			this.setSpotOracleMap();
		}

		return this.getOraclePriceDataAndSlot(oracleId);
	}
}
