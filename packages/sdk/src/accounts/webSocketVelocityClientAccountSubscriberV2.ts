import {
	AccountSubscriber,
	DataAndSlot,
	DelistedMarketSetting,
	VelocityClientAccountEvents,
	VelocityClientAccountSubscriber,
	NotSubscribedError,
	ResubOpts,
} from './types';
import { assertDataAndSlot } from './utils';
import {
	isVariant,
	PerpMarketAccount,
	SpotMarketAccount,
	StateAccount,
} from '../types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	getVelocityStateAccountPublicKey,
	getPerpMarketPublicKey,
	getSpotMarketPublicKey,
} from '../addresses/pda';
import { Context, PublicKey } from '@solana/web3.js';
import {
	Commitment,
	SolanaRpcSubscriptionsApi,
	Rpc,
	RpcSubscriptions,
	createSolanaClient,
} from 'gill';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { OracleClientCache } from '../oracles/oracleClientCache';
import { QUOTE_ORACLE_PRICE_DATA } from '../oracles/quoteAssetOracleClient';
import { VelocityProgram, findAllMarketAndOracles } from '../config';
import { findDelistedPerpMarketsAndOracles } from './utils';
import {
	getOracleId,
	getPublicKeyAndSourceFromOracleId,
} from '../oracles/oracleId';
import { OracleSource } from '../types';
import {
	getPerpMarketAccountsFilter,
	getSpotMarketAccountsFilter,
} from '../memcmp';
import { WebSocketProgramAccountsSubscriberV2 } from './webSocketProgramAccountsSubscriberV2';
import { WebSocketAccountSubscriberV2 } from './webSocketAccountSubscriberV2';
const ORACLE_DEFAULT_ID = getOracleId(
	PublicKey.default,
	OracleSource.QUOTE_ASSET
);

/**
 * `VelocityClientAccountSubscriber` variant that, unlike `WebSocketVelocityClientAccountSubscriber`
 * (one `WebSocketAccountSubscriber` per market), multiplexes all perp markets onto a single
 * `WebSocketProgramAccountsSubscriberV2` program-account stream and all spot markets onto a
 * second — two WebSocket subscriptions total instead of one per market. `State` and each oracle
 * still get their own `WebSocketAccountSubscriberV2`. Lower connection overhead at scale;
 * `addPerpMarket`/`addSpotMarket` are no-ops here since new markets simply arrive automatically
 * over the existing program-account stream rather than needing an explicit new subscription.
 */
export class WebSocketVelocityClientAccountSubscriberV2
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
	skipInitialData: boolean = true;

	eventEmitter: StrictEventEmitter<EventEmitter, VelocityClientAccountEvents>;
	stateAccountSubscriber?: WebSocketAccountSubscriberV2<StateAccount>;
	private _perpMarketAllAccountsSubscriber?: WebSocketProgramAccountsSubscriberV2<PerpMarketAccount>;
	get perpMarketAllAccountsSubscriber(): WebSocketProgramAccountsSubscriberV2<PerpMarketAccount> {
		if (!this._perpMarketAllAccountsSubscriber) {
			throw new Error(
				'perpMarketAllAccountsSubscriber accessed before subscribe()'
			);
		}
		return this._perpMarketAllAccountsSubscriber;
	}
	set perpMarketAllAccountsSubscriber(
		subscriber: WebSocketProgramAccountsSubscriberV2<PerpMarketAccount>
	) {
		this._perpMarketAllAccountsSubscriber = subscriber;
	}
	perpMarketAccountLatestData = new Map<
		number,
		DataAndSlot<PerpMarketAccount>
	>();
	private _spotMarketAllAccountsSubscriber?: WebSocketProgramAccountsSubscriberV2<SpotMarketAccount>;
	get spotMarketAllAccountsSubscriber(): WebSocketProgramAccountsSubscriberV2<SpotMarketAccount> {
		if (!this._spotMarketAllAccountsSubscriber) {
			throw new Error(
				'spotMarketAllAccountsSubscriber accessed before subscribe()'
			);
		}
		return this._spotMarketAllAccountsSubscriber;
	}
	set spotMarketAllAccountsSubscriber(
		subscriber: WebSocketProgramAccountsSubscriberV2<SpotMarketAccount>
	) {
		this._spotMarketAllAccountsSubscriber = subscriber;
	}
	spotMarketAccountLatestData = new Map<
		number,
		DataAndSlot<SpotMarketAccount>
	>();
	perpOracleMap = new Map<number, PublicKey>();
	perpOracleStringMap = new Map<number, string>();
	spotOracleMap = new Map<number, PublicKey>();
	spotOracleStringMap = new Map<number, string>();
	oracleSubscribers = new Map<string, AccountSubscriber<OraclePriceData>>();
	delistedMarketSetting: DelistedMarketSetting;

	initialPerpMarketAccountData: Map<number, PerpMarketAccount> = new Map();
	initialSpotMarketAccountData: Map<number, SpotMarketAccount> = new Map();
	initialOraclePriceData: Map<string, OraclePriceData> = new Map();

	protected isSubscribing = false;
	private subscriptionPromiseResolver: (val: boolean) => void = () => {};
	protected subscriptionPromise: Promise<boolean> = Promise.resolve(false);

	private rpc: Rpc<any>;
	private rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi> &
		string;

	/**
	 * @param program Anchor program used to derive PDAs, decode accounts, and resolve oracle clients.
	 * @param perpMarketIndexes Perp market indexes to track, if `shouldFindAllMarketsAndOracles` is false. Only used to derive the initial pubkeys handed to the perp program-account subscriber; new markets arrive automatically thereafter.
	 * @param spotMarketIndexes Spot market indexes to track, if `shouldFindAllMarketsAndOracles` is false. Same caveat as `perpMarketIndexes`.
	 * @param oracleInfos Oracles to track up front, if `shouldFindAllMarketsAndOracles` is false.
	 * @param shouldFindAllMarketsAndOracles If true, `subscribe()` first discovers every market/oracle from on-chain state, ignoring the index/info args above.
	 * @param delistedMarketSetting Behavior applied to delisted perp markets/oracles after subscribing; see `DelistedMarketSetting`.
	 * @param resubOpts Resubscription watchdog options passed to the underlying program-account and per-oracle subscribers.
	 * @param commitment Commitment for every subscription; defaults to the provider's configured commitment.
	 * @param skipInitialData Currently unused by `subscribe()`/`setInitialData()` (the field is set but never read); defaults to `false`.
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
		skipInitialData?: boolean
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
		this.skipInitialData = skipInitialData ?? false;

		const { rpc, rpcSubscriptions } = createSolanaClient({
			urlOrMoniker: this.program.provider.connection.rpcEndpoint,
		});
		this.rpc = rpc;
		this.rpcSubscriptions = rpcSubscriptions;
	}

	/**
	 * Derives all tracked perp/spot market pubkeys (or discovers them via `findAllMarketAndOracles`
	 * if `shouldFindAllMarketsAndOracles` is set), then in parallel: opens the perp and spot
	 * `WebSocketProgramAccountsSubscriberV2` streams, subscribes the `State` account, and seeds +
	 * subscribes every oracle. Applies `delistedMarketSetting` afterward. Idempotent: a no-op if
	 * already subscribed, and concurrent calls while a subscribe is in flight share the same
	 * result via `subscriptionPromise` rather than issuing duplicate subscriptions.
	 * @returns `true` on success; `false` if any step throws (subscription state is left partially applied in that case, and `isSubscribed` remains `false`).
	 */
	public async subscribe(): Promise<boolean> {
		try {
			const startTime = performance.now();
			if (this.isSubscribed) {
				console.log(
					`[PROFILING] WebSocketVelocityClientAccountSubscriberV2.subscribe() skipped - already subscribed`
				);
				return true;
			}

			if (this.isSubscribing) {
				console.log(
					`[PROFILING] WebSocketVelocityClientAccountSubscriberV2.subscribe() waiting for existing subscription`
				);
				return await this.subscriptionPromise;
			}

			this.isSubscribing = true;

			// Initialize subscriptionPromiseResolver to a no-op function
			this.subscriptionPromiseResolver = () => {};

			this.subscriptionPromise = new Promise((res) => {
				this.subscriptionPromiseResolver = res;
			});

			const [perpMarketAccountPubkeys, spotMarketAccountPubkeys] =
				await Promise.all([
					Promise.all(
						this.perpMarketIndexes.map((marketIndex) =>
							getPerpMarketPublicKey(this.program.programId, marketIndex)
						)
					),
					Promise.all(
						this.spotMarketIndexes.map((marketIndex) =>
							getSpotMarketPublicKey(this.program.programId, marketIndex)
						)
					),
				]);

			// Profile findAllMarketsAndOracles if needed
			let findAllMarketsDuration = 0;
			if (this.shouldFindAllMarketsAndOracles) {
				const findAllMarketsStartTime = performance.now();
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
				const findAllMarketsEndTime = performance.now();
				findAllMarketsDuration =
					findAllMarketsEndTime - findAllMarketsStartTime;
				console.log(
					`[PROFILING] findAllMarketAndOracles completed in ${findAllMarketsDuration.toFixed(
						2
					)}ms (${perpMarketAccounts.length} perp markets, ${
						spotMarketAccounts.length
					} spot markets)`
				);
			}

			// Create subscribers
			this.perpMarketAllAccountsSubscriber =
				new WebSocketProgramAccountsSubscriberV2<PerpMarketAccount>(
					'PerpMarketAccountsSubscriber',
					'perpMarket',
					this.program,
					(
						this.program.account as any
					).perpMarket.coder.accounts.decodeUnchecked.bind(
						(this.program.account as any).perpMarket.coder.accounts
					),
					{
						filters: [getPerpMarketAccountsFilter()],
						commitment: this.commitment,
					},
					this.resubOpts,
					perpMarketAccountPubkeys // because we pass these in, it will monitor these accounts and fetch them right away
				);

			this.spotMarketAllAccountsSubscriber =
				new WebSocketProgramAccountsSubscriberV2<SpotMarketAccount>(
					'SpotMarketAccountsSubscriber',
					'spotMarket',
					this.program,
					(
						this.program.account as any
					).spotMarket.coder.accounts.decodeUnchecked.bind(
						(this.program.account as any).spotMarket.coder.accounts
					),
					{
						filters: [getSpotMarketAccountsFilter()],
						commitment: this.commitment,
					},
					this.resubOpts,
					spotMarketAccountPubkeys // because we pass these in, it will monitor these accounts and fetch them right away
				);

			// Run all subscriptions in parallel
			await Promise.all([
				// Perp market subscription
				this.perpMarketAllAccountsSubscriber.subscribe(
					(
						_accountId: PublicKey,
						data: PerpMarketAccount,
						context: Context,
						_buffer: Buffer
					) => {
						if (
							this.delistedMarketSetting !== DelistedMarketSetting.Subscribe &&
							isVariant(data.status, 'delisted')
						) {
							return;
						}
						this.perpMarketAccountLatestData.set(data.marketIndex, {
							data,
							slot: context.slot,
						});
						this.eventEmitter.emit('perpMarketAccountUpdate', data);
						this.eventEmitter.emit('update');
					}
				),
				// Spot market subscription
				this.spotMarketAllAccountsSubscriber.subscribe(
					(
						_accountId: PublicKey,
						data: SpotMarketAccount,
						context: Context,
						_buffer: Buffer
					) => {
						if (
							this.delistedMarketSetting !== DelistedMarketSetting.Subscribe &&
							isVariant(data.status, 'delisted')
						) {
							return;
						}
						this.spotMarketAccountLatestData.set(data.marketIndex, {
							data,
							slot: context.slot,
						});
						this.eventEmitter.emit('spotMarketAccountUpdate', data);
						this.eventEmitter.emit('update');
					}
				),
				// State account subscription
				(async () => {
					const statePublicKey = await getVelocityStateAccountPublicKey(
						this.program.programId
					);
					this.stateAccountSubscriber = new WebSocketAccountSubscriberV2(
						'state',
						this.program,
						statePublicKey,
						undefined,
						undefined,
						this.commitment as Commitment,
						this.rpcSubscriptions,
						this.rpc
					);
					await Promise.all([
						this.stateAccountSubscriber.fetch(),
						this.stateAccountSubscriber.subscribe((data: StateAccount) => {
							this.eventEmitter.emit('stateAccountUpdate', data);
							this.eventEmitter.emit('update');
						}),
					]);
				})(),
				(async () => {
					await this.setInitialData();
					const subscribeToOraclesStartTime = performance.now();
					await this.subscribeToOracles();
					const subscribeToOraclesEndTime = performance.now();
					const duration =
						subscribeToOraclesEndTime - subscribeToOraclesStartTime;
					return duration;
				})(),
			]);

			// const initialPerpMarketDataFromLatestData = new Map(
			// 	Array.from(this.perpMarketAccountLatestData.values()).map((data) => [
			// 		data.data.marketIndex,
			// 		data.data,
			// 	])
			// );
			// const initialSpotMarketDataFromLatestData = new Map(
			// 	Array.from(this.spotMarketAccountLatestData.values()).map((data) => [
			// 		data.data.marketIndex,
			// 		data.data,
			// 	])
			// );
			// this.initialPerpMarketAccountData = initialPerpMarketDataFromLatestData;
			// this.initialSpotMarketAccountData = initialSpotMarketDataFromLatestData;

			await this.handleDelistedMarketOracles();

			await Promise.all([this.setPerpOracleMap(), this.setSpotOracleMap()]);

			this.eventEmitter.emit('update');
			// delete initial data
			this.removeInitialData();

			const totalDuration = performance.now() - startTime;
			console.log(
				`[PROFILING] WebSocketVelocityClientAccountSubscriberV2.subscribe() completed in ${totalDuration.toFixed(
					2
				)}ms`
			);

			// Resolve the subscription promise
			this.isSubscribed = true;
			this.isSubscribing = false;
			// Before calling subscriptionPromiseResolver, check if it's defined
			this.subscriptionPromiseResolver(true);

			return true;
		} catch (error) {
			console.error('Subscription failed:', error);
			// Tear down any child subscribers that were created before the failure so a
			// subsequent subscribe() attempt doesn't leak live connections; isSubscribed is
			// still false at this point, so unsubscribe() alone would otherwise skip this.
			await Promise.all([
				this.stateAccountSubscriber?.unsubscribe(),
				this.unsubscribeFromMarketAccounts(),
				this.unsubscribeFromSpotMarketAccounts(),
				this.unsubscribeFromOracles(),
			]).catch((teardownError) => {
				console.error(
					'Error tearing down partial subscription:',
					teardownError
				);
			});
			this.isSubscribing = false;
			this.subscriptionPromiseResolver(false);
			return false;
		}
	}

	chunks = <T>(array: readonly T[], size: number): T[][] => {
		const result: T[][] = [];
		for (let i = 0; i < array.length; i += size) {
			result.push(array.slice(i, i + size));
		}
		return result;
	};

	/** Re-runs `setInitialData()`, re-fetching and re-emitting oracle price data. Does not re-fetch perp/spot market or `State` accounts — those are kept current via their live WebSocket streams. */
	public async fetch(): Promise<void> {
		await this.setInitialData();
	}

	/**
	 * This is a no-op method that always returns true.
	 * Unlike the previous implementation, we don't need to manually subscribe to individual perp markets
	 * because we automatically receive updates for all program account changes via a single websocket subscription.
	 * This means any new perp markets will automatically be included without explicit subscription.
	 * @param marketIndex The perp market index to add (unused)
	 * @returns Promise that resolves to true
	 */
	public addPerpMarket(_marketIndex: number): Promise<boolean> {
		return Promise.resolve(true);
	}

	/**
	 * This is a no-op method that always returns true.
	 * Unlike the previous implementation, we don't need to manually subscribe to individual spot markets
	 * because we automatically receive updates for all program account changes via a single websocket subscription.
	 * This means any new spot markets will automatically be included without explicit subscription.
	 * @param marketIndex The spot market index to add (unused)
	 * @returns Promise that resolves to true
	 */
	public addSpotMarket(_marketIndex: number): Promise<boolean> {
		return Promise.resolve(true);
	}

	// TODO: need more options to skip loading perp market and spot market data. Because of how we fetch within the program account subscribers, I am commenting this all out
	/**
	 * Batch-fetches every tracked oracle account via chunked `getMultipleAccountsInfo` calls (100
	 * pubkeys per chunk), decodes each with the source-appropriate `OracleClient`, stashes the
	 * results in `initialOraclePriceData`, and immediately emits `oraclePriceUpdate`/`update` for
	 * each. Unlike the v1 subscriber's `setInitialData`, does not seed perp/spot market data —
	 * those markets are seeded directly by the program-account subscribers' own initial-account
	 * list instead.
	 */
	async setInitialData(): Promise<void> {
		const connection = this.program.provider.connection;
		// Profile oracle initial data setup
		const oracleSetupStartTime = performance.now();
		const oracleAccountPubkeyChunks = this.chunks(
			this.oracleInfos.map((oracleInfo) => oracleInfo.publicKey),
			100
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
		const oracleSetupEndTime = performance.now();
		const oracleSetupDuration = oracleSetupEndTime - oracleSetupStartTime;
		if (this.resubOpts?.logResubMessages) {
			console.log(
				`[PROFILING] Oracle initial data setup completed in ${oracleSetupDuration.toFixed(
					2
				)}ms (${this.initialOraclePriceData.size} oracles)`
			);
		}

		// emit initial oracle price data
		Array.from(this.initialOraclePriceData.entries()).forEach(
			([oracleId, oraclePriceData]) => {
				const { publicKey, source } =
					getPublicKeyAndSourceFromOracleId(oracleId);
				this.eventEmitter.emit(
					'oraclePriceUpdate',
					publicKey,
					source,
					oraclePriceData
				);
			}
		);
		this.eventEmitter.emit('update');
	}

	/** Clears the seed data stashed by `setInitialData()`/`findAllMarketAndOracles` once consumed, freeing the memory. */
	removeInitialData() {
		this.initialPerpMarketAccountData = new Map();
		this.initialSpotMarketAccountData = new Map();
		this.initialOraclePriceData = new Map();
	}

	/** Subscribes a `WebSocketAccountSubscriberV2` for every tracked oracle not already subscribed, in parallel, skipping duplicates already present in `oracleSubscribers`. */
	async subscribeToOracles(): Promise<boolean> {
		const startTime = performance.now();

		// Filter out default oracles and duplicates to avoid unnecessary subscriptions
		const validOracleInfos = this.oracleInfos.filter(
			(oracleInfo) =>
				!this.oracleSubscribers.has(
					getOracleId(oracleInfo.publicKey, oracleInfo.source)
				)
		);

		await Promise.all(
			validOracleInfos.map((oracleInfo) => this.subscribeToOracle(oracleInfo))
		);

		const totalDuration = performance.now() - startTime;
		console.log(
			`[PROFILING] subscribeToOracles() completed in ${totalDuration.toFixed(
				2
			)}ms`
		);

		return true;
	}

	/**
	 * Creates and subscribes a `WebSocketAccountSubscriberV2` for one oracle, decoding buffers
	 * with the source-appropriate `OracleClient`. Seeds from `initialOraclePriceData` if available
	 * before subscribing.
	 * @param oracleInfo Oracle pubkey and source to subscribe.
	 * @returns `false` if no `OracleClient` is registered for `oracleInfo.source` or the subscribe call throws; otherwise `true`.
	 */
	async subscribeToOracle(oracleInfo: OracleInfo): Promise<boolean> {
		try {
			const oracleId = getOracleId(oracleInfo.publicKey, oracleInfo.source);

			const client = this.oracleClientCache.get(
				oracleInfo.source,
				this.program.provider.connection,
				this.program
			);
			if (!client) {
				return false;
			}
			const accountSubscriber =
				new WebSocketAccountSubscriberV2<OraclePriceData>(
					'oracle',
					this.program,
					oracleInfo.publicKey,
					(buffer: Buffer) => {
						return client.getOraclePriceDataFromBuffer(buffer);
					},
					this.resubOpts,
					this.commitment,
					this.rpcSubscriptions,
					this.rpc
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

			this.oracleSubscribers.set(oracleId, accountSubscriber);

			return true;
		} catch (error) {
			console.error(
				`Failed to subscribe to oracle ${oracleInfo.publicKey.toString()}:`,
				error
			);
			return false;
		}
	}

	/** Unsubscribes the single multiplexed perp-market program-account stream. */
	async unsubscribeFromMarketAccounts(): Promise<void> {
		await this.perpMarketAllAccountsSubscriber.unsubscribe();
	}

	/** Unsubscribes the single multiplexed spot-market program-account stream. */
	async unsubscribeFromSpotMarketAccounts(): Promise<void> {
		await this.spotMarketAllAccountsSubscriber.unsubscribe();
	}

	/** Unsubscribes every per-oracle `WebSocketAccountSubscriberV2`, in parallel. */
	async unsubscribeFromOracles(): Promise<void> {
		await Promise.all(
			Array.from(this.oracleSubscribers.values()).map((accountSubscriber) =>
				accountSubscriber.unsubscribe()
			)
		);
	}

	/** Tears down the `State` subscriber, both market program-account streams, and every oracle subscriber. A no-op if not subscribed. */
	public async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		if (this.subscriptionPromise) {
			await this.subscriptionPromise;
		}
		await Promise.all([
			this.stateAccountSubscriber?.unsubscribe(),
			this.unsubscribeFromMarketAccounts(),
			this.unsubscribeFromSpotMarketAccounts(),
			this.unsubscribeFromOracles(),
		]);

		this.isSubscribed = false;
		this.isSubscribing = false;
		this.subscriptionPromiseResolver = () => {};
	}

	/**
	 * Adds an oracle to be tracked, subscribing a new `WebSocketAccountSubscriberV2` for it. A
	 * no-op that resolves `true` immediately for the `PublicKey.default` sentinel (quote-asset "no
	 * oracle") or an oracle already tracked.
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
	 * Applies `delistedMarketSetting` to any oracle backing a currently `status: delisted` perp
	 * market (and not still used by a live spot market, per `findDelistedPerpMarketsAndOracles`):
	 * unsubscribes the oracle's subscriber, and additionally drops it from `oracleSubscribers` if
	 * the setting is `Discard`. A no-op if the setting is `Subscribe`. Note this only manages
	 * oracle subscriptions — delisted market accounts themselves cannot be selectively unsubscribed
	 * from the shared perp/spot program-account stream; instead the `subscribe()` update callback
	 * drops any incoming update for a `status: delisted` market unless `delistedMarketSetting` is
	 * `Subscribe`, freezing that market's cached data at its last pre-delisting state.
	 */
	async handleDelistedMarketOracles(): Promise<void> {
		if (this.delistedMarketSetting === DelistedMarketSetting.Subscribe) {
			return;
		}

		const { oracles } = findDelistedPerpMarketsAndOracles(
			this.getMarketAccountsAndSlots(),
			this.getSpotMarketAccountsAndSlots()
		);

		for (const oracle of oracles) {
			const oracleId = getOracleId(oracle.publicKey, oracle.source);
			const subscriber = this.oracleSubscribers.get(oracleId);
			if (subscriber) {
				await subscriber.unsubscribe();
				if (this.delistedMarketSetting === DelistedMarketSetting.Discard) {
					this.oracleSubscribers.delete(oracleId);
				}
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

	/** Throws `NotSubscribedError` if not subscribed, or a generic `Error` (via `assertDataAndSlot`) if subscribed but the `State` account hasn't loaded yet. */
	public getStateAccountAndSlot(): DataAndSlot<StateAccount> {
		this.assertIsSubscribed();
		return assertDataAndSlot(
			this.stateAccountSubscriber?.dataAndSlot,
			'State account data not available'
		);
	}

	/** Throws `NotSubscribedError` if not subscribed. Returns undefined if `marketIndex` hasn't been observed yet on the perp program-account stream. */
	public getMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<PerpMarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.perpMarketAccountLatestData.get(marketIndex);
	}

	/** Returns every currently cached (loaded) perp market. Does not throw `NotSubscribedError`. */
	public getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[] {
		return Array.from(this.perpMarketAccountLatestData.values());
	}

	/** Throws `NotSubscribedError` if not subscribed. Returns undefined if `marketIndex` hasn't been observed yet on the spot program-account stream. */
	public getSpotMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<SpotMarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.spotMarketAccountLatestData.get(marketIndex);
	}

	/** Returns every currently cached (loaded) spot market. Does not throw `NotSubscribedError`. */
	public getSpotMarketAccountsAndSlots(): DataAndSlot<SpotMarketAccount>[] {
		return Array.from(this.spotMarketAccountLatestData.values());
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
