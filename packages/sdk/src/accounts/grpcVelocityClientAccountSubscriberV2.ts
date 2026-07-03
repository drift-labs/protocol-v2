import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { findAllMarketAndOracles, VelocityProgram } from '../config';
import {
	getVelocityStateAccountPublicKey,
	getPerpMarketPublicKey,
	getPerpMarketPublicKeySync,
	getSpotMarketPublicKey,
	getSpotMarketPublicKeySync,
} from '../addresses/pda';
import {
	AccountSubscriber,
	DataAndSlot,
	DelistedMarketSetting,
	VelocityClientAccountEvents,
	VelocityClientAccountSubscriber,
	NotSubscribedError,
	GrpcConfigs,
	ResubOpts,
} from './types';
import { grpcAccountSubscriber } from './grpcAccountSubscriber';
import { grpcMultiAccountSubscriber } from './grpcMultiAccountSubscriber';
import { PerpMarketAccount, SpotMarketAccount, StateAccount } from '../types';
import {
	getOracleId,
	getPublicKeyAndSourceFromOracleId,
} from '../oracles/oracleId';
import { OracleClientCache } from '../oracles/oracleClientCache';
import { findDelistedPerpMarketsAndOracles } from './utils';

/**
 * `VelocityClientAccountSubscriber` variant that, unlike `grpcVelocityClientAccountSubscriber`
 * (one gRPC stream per account), multiplexes all perp markets onto one `grpcMultiAccountSubscriber`,
 * all spot markets onto a second, and all oracles onto a third — three gRPC streams total instead
 * of one per account. Lower connection/stream overhead at scale; `getOraclePriceDataAndSlot`
 * relies on this class's own `oracleIdToOracleDataMap` rather than the multi-subscriber's account
 * map, since a single oracle pubkey can back multiple `(pubkey, source)` oracle ids (e.g. a market
 * pair sharing an underlying price feed).
 */
export class grpcVelocityClientAccountSubscriberV2
	implements VelocityClientAccountSubscriber
{
	private grpcConfigs: GrpcConfigs;
	private perpMarketsSubscriber?: grpcMultiAccountSubscriber<PerpMarketAccount>;
	private spotMarketsSubscriber?: grpcMultiAccountSubscriber<SpotMarketAccount>;
	private oracleMultiSubscriber?: grpcMultiAccountSubscriber<
		OraclePriceData,
		OracleInfo
	>;
	private perpMarketIndexToAccountPubkeyMap = new Map<number, string>();
	private spotMarketIndexToAccountPubkeyMap = new Map<number, string>();
	private delistedMarketSetting: DelistedMarketSetting;

	public eventEmitter: StrictEventEmitter<
		EventEmitter,
		VelocityClientAccountEvents
	>;
	public isSubscribed: boolean;
	public isSubscribing: boolean;
	public program: VelocityProgram;
	public perpMarketIndexes: number[];
	public spotMarketIndexes: number[];
	public shouldFindAllMarketsAndOracles: boolean;
	public oracleInfos: OracleInfo[];
	public initialPerpMarketAccountData: Map<number, PerpMarketAccount>;
	public initialSpotMarketAccountData: Map<number, SpotMarketAccount>;
	public initialOraclePriceData: Map<string, OraclePriceData>;
	public perpOracleMap = new Map<number, PublicKey>();
	public perpOracleStringMap = new Map<number, string>();
	public spotOracleMap = new Map<number, PublicKey>();
	public spotOracleStringMap = new Map<number, string>();
	private oracleIdToOracleDataMap = new Map<
		string,
		DataAndSlot<OraclePriceData>
	>();
	public stateAccountSubscriber?: AccountSubscriber<StateAccount>;
	oracleClientCache = new OracleClientCache();
	private resubOpts?: ResubOpts;

	private subscriptionPromiseResolver: (val: boolean) => void = () => {};
	private subscriptionPromise: Promise<boolean> = Promise.resolve(false);

	/**
	 * @param grpcConfigs gRPC Geyser endpoint/token/commitment config (Yellowstone or LaserStream).
	 * @param program Anchor program used to derive PDAs, decode accounts, and resolve oracle clients.
	 * @param perpMarketIndexes Perp market indexes to track, if `shouldFindAllMarketsAndOracles` is false.
	 * @param spotMarketIndexes Spot market indexes to track, if `shouldFindAllMarketsAndOracles` is false.
	 * @param oracleInfos Oracles to track up front, if `shouldFindAllMarketsAndOracles` is false.
	 * @param shouldFindAllMarketsAndOracles If true, `subscribe()` first discovers every market/oracle from on-chain state.
	 * @param delistedMarketSetting Behavior applied to delisted perp markets/oracles after subscribing.
	 * @param resubOpts Resubscription watchdog options passed to the underlying multi-account subscribers.
	 */
	constructor(
		grpcConfigs: GrpcConfigs,
		program: VelocityProgram,
		perpMarketIndexes: number[],
		spotMarketIndexes: number[],
		oracleInfos: OracleInfo[],
		shouldFindAllMarketsAndOracles: boolean,
		delistedMarketSetting: DelistedMarketSetting,
		resubOpts?: ResubOpts
	) {
		this.eventEmitter = new EventEmitter();
		this.isSubscribed = false;
		this.isSubscribing = false;
		this.program = program;
		this.perpMarketIndexes = perpMarketIndexes;
		this.spotMarketIndexes = spotMarketIndexes;
		this.shouldFindAllMarketsAndOracles = shouldFindAllMarketsAndOracles;
		this.oracleInfos = oracleInfos;
		this.initialPerpMarketAccountData = new Map();
		this.initialSpotMarketAccountData = new Map();
		this.initialOraclePriceData = new Map();
		this.perpOracleMap = new Map();
		this.perpOracleStringMap = new Map();
		this.spotOracleMap = new Map();
		this.spotOracleStringMap = new Map();
		this.grpcConfigs = grpcConfigs;
		this.resubOpts = resubOpts;
		this.delistedMarketSetting = delistedMarketSetting;
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
	 * `initialPerpMarketAccountData`/`initialSpotMarketAccountData`/`initialOraclePriceData`, which
	 * the multi-account subscribers seed from before their gRPC streams deliver live data. Skips
	 * data already populated (e.g. by `findAllMarketAndOracles` when `shouldFindAllMarketsAndOracles`
	 * is set).
	 */
	async setInitialData(): Promise<void> {
		const connection = this.program.provider.connection;

		if (
			!this.initialPerpMarketAccountData ||
			this.initialPerpMarketAccountData.size === 0
		) {
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

		if (
			!this.initialSpotMarketAccountData ||
			this.initialSpotMarketAccountData.size === 0
		) {
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
			this.oracleInfos.reduce<[string, OraclePriceData][]>(
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
				[]
			)
		);
	}

	/**
	 * Records `_marketIndex` in `perpMarketIndexes` for bookkeeping. Note this does **not**
	 * actually add the account to the live `perpMarketsSubscriber` gRPC stream — unlike the
	 * WebSocket/per-account subscribers' `addPerpMarket`, no new subscription is created here.
	 * @param _marketIndex Perp market index to record.
	 */
	async addPerpMarket(_marketIndex: number): Promise<boolean> {
		if (!this.perpMarketIndexes.includes(_marketIndex)) {
			this.perpMarketIndexes = this.perpMarketIndexes.concat(_marketIndex);
		}
		return true;
	}

	/** No-op; unlike `addPerpMarket`, does not even record the index. Always resolves `true`. */
	async addSpotMarket(_marketIndex: number): Promise<boolean> {
		return true;
	}

	/**
	 * Adds an oracle to `oracleInfos` and, if the oracle multi-subscriber's gRPC stream is already
	 * active, calls `oracleMultiSubscriber.addAccounts` to extend it. A no-op that resolves `true`
	 * immediately for the `PublicKey.default` sentinel (quote-asset "no oracle") or an oracle
	 * already tracked.
	 * @param oracleInfo Oracle pubkey and source to start tracking.
	 */
	async addOracle(oracleInfo: OracleInfo): Promise<boolean> {
		if (this.resubOpts?.logResubMessages) {
			console.log('[grpcVelocityClientAccountSubscriberV2] addOracle');
		}
		if (oracleInfo.publicKey.equals(PublicKey.default)) {
			return true;
		}

		const exists = this.oracleInfos.some(
			(o) =>
				o.source === oracleInfo.source &&
				o.publicKey.equals(oracleInfo.publicKey)
		);
		if (exists) {
			return true; // Already exists, don't add duplicate
		}

		this.oracleInfos = this.oracleInfos.concat(oracleInfo);

		// extend the multi-subscriber's accountPropsMap alongside the pubkey filter, so the
		// oracle decode path has the OracleInfo(s) it needs for the newly added feed (all infos
		// sharing this pubkey, mirroring the fan-out map built in subscribeToOracles)
		const pubkey = oracleInfo.publicKey.toBase58();
		const infosForPubkey = this.oracleInfos.filter(
			(o) => o.publicKey.toBase58() === pubkey
		);
		const accountProps = new Map<string, OracleInfo | OracleInfo[]>([
			[pubkey, infosForPubkey],
		]);
		this.oracleMultiSubscriber?.addAccounts(
			[oracleInfo.publicKey],
			accountProps
		);

		return true;
	}

	/**
	 * Subscribes the `State` account (single-account gRPC subscriber), batch-seeds all market/
	 * oracle accounts via `setInitialData()`, then opens the three multiplexed
	 * `grpcMultiAccountSubscriber` streams (perp markets, spot markets, oracles). Applies
	 * `delistedMarketSetting` afterward. Idempotent: a no-op if already subscribed, and concurrent
	 * calls while a subscribe is in flight share the same result via `subscriptionPromise`.
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

		try {
			return await this.subscribeInner();
		} catch (err) {
			// tear down any partially-created subscribers so a retry starts clean and doesn't
			// stack duplicate gRPC streams / leak callbacks — unsubscribe() bails while
			// isSubscribed is still false, so it can't recover these on its own
			try {
				await this.stateAccountSubscriber?.unsubscribe();
				await this.oracleMultiSubscriber?.unsubscribe();
				await this.perpMarketsSubscriber?.unsubscribe();
				await this.spotMarketsSubscriber?.unsubscribe();
			} catch (teardownErr) {
				console.error(
					'[grpcVelocityClientAccountSubscriberV2] cleanup after failed subscribe threw',
					teardownErr
				);
			}
			this.stateAccountSubscriber = undefined;
			this.oracleMultiSubscriber = undefined;
			this.perpMarketsSubscriber = undefined;
			this.spotMarketsSubscriber = undefined;

			// settle the shared promise so concurrent subscribe() callers don't hang forever
			this.isSubscribing = false;
			this.subscriptionPromiseResolver(false);
			throw err;
		}
	}

	private async subscribeInner(): Promise<boolean> {
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
		this.stateAccountSubscriber =
			await grpcAccountSubscriber.create<StateAccount>(
				this.grpcConfigs,
				'state',
				this.program,
				statePublicKey,
				undefined,
				undefined
			);
		await this.stateAccountSubscriber.subscribe((data: StateAccount) => {
			this.eventEmitter.emit('stateAccountUpdate', data);
			this.eventEmitter.emit('update');
		});

		// set initial data to avoid spamming getAccountInfo calls in webSocketAccountSubscriber
		await this.setInitialData();

		// subscribe to perp + spot markets (separate) and oracles
		await Promise.all([
			this.subscribeToPerpMarketAccounts(),
			this.subscribeToSpotMarketAccounts(),
			this.subscribeToOracles(),
		]);

		this.eventEmitter.emit('update');

		await this.handleDelistedMarkets();

		await Promise.all([this.setPerpOracleMap(), this.setSpotOracleMap()]);

		this.subscriptionPromiseResolver(true);

		this.isSubscribing = false;
		this.isSubscribed = true;

		// delete initial data
		this.removeInitialData();

		return true;
	}

	/** Fetches the `State` account and all three multiplexed subscribers (perp markets, spot markets, oracles) in sequence. */
	public async fetch(): Promise<void> {
		await this.stateAccountSubscriber?.fetch();
		await this.perpMarketsSubscriber?.fetch();
		await this.spotMarketsSubscriber?.fetch();
		await this.oracleMultiSubscriber?.fetch();
	}

	/** Throws `NotSubscribedError` if `subscribe()` has not been called. */
	private assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	/** Throws `NotSubscribedError` if not subscribed. */
	public getStateAccountAndSlot(): DataAndSlot<StateAccount> {
		this.assertIsSubscribed();
		return this.stateAccountSubscriber!.dataAndSlot!;
	}

	/** Returns every currently cached (loaded) perp market from the multiplexed subscriber. Does not throw `NotSubscribedError`. */
	public getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[] {
		const map = this.perpMarketsSubscriber?.getAccountDataMap();
		return Array.from(map?.values() ?? []);
	}

	/** Returns every currently cached (loaded) spot market from the multiplexed subscriber. Does not throw `NotSubscribedError`. */
	public getSpotMarketAccountsAndSlots(): DataAndSlot<SpotMarketAccount>[] {
		const map = this.spotMarketsSubscriber?.getAccountDataMap();
		return Array.from(map?.values() ?? []);
	}

	/** Returns the cached perp market, or undefined if `marketIndex` isn't tracked (or hasn't loaded yet). Does not throw `NotSubscribedError`. */
	getMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<PerpMarketAccount> | undefined {
		const accountPubkey =
			this.perpMarketIndexToAccountPubkeyMap.get(marketIndex);
		if (!accountPubkey) {
			return undefined;
		}
		return this.perpMarketsSubscriber?.getAccountData(accountPubkey);
	}

	/** Returns the cached spot market, or undefined if `marketIndex` isn't tracked (or hasn't loaded yet). Does not throw `NotSubscribedError`. */
	getSpotMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<SpotMarketAccount> | undefined {
		const accountPubkey =
			this.spotMarketIndexToAccountPubkeyMap.get(marketIndex);
		if (!accountPubkey) {
			return undefined;
		}
		return this.spotMarketsSubscriber?.getAccountData(accountPubkey);
	}

	/**
	 * Looks up cached oracle price data by oracle id (see `getOracleId`), from this class's own
	 * `oracleIdToOracleDataMap` rather than `oracleMultiSubscriber.getAccountData` — a single
	 * oracle pubkey backing multiple oracle ids (e.g. shared price feeds) means the multi-subscriber's
	 * own account map cannot be trusted to disambiguate them correctly.
	 * @param oracleId Oracle id string from `getOracleId(publicKey, source)`.
	 * @returns Cached price data/slot, or undefined if not tracked. Throws `NotSubscribedError` if not subscribed.
	 */
	public getOraclePriceDataAndSlot(
		oracleId: string
	): DataAndSlot<OraclePriceData> | undefined {
		this.assertIsSubscribed();
		// we need to rely on a map we store in this class because the grpcMultiAccountSubscriber does not track a mapping or oracle ID.
		// DO NOT call getAccountData on the oracleMultiSubscriber, it will not return the correct data in certain cases(BONK spot and perp market subscribed too at once).
		return this.oracleIdToOracleDataMap.get(oracleId);
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

	/** Rebuilds `perpOracleMap`/`perpOracleStringMap` from currently cached perp markets, calling `addOracle` for any oracle not yet tracked by `oracleMultiSubscriber`. */
	async setPerpOracleMap() {
		const perpMarketsMap = this.perpMarketsSubscriber?.getAccountDataMap();
		const perpMarkets = Array.from(perpMarketsMap?.values() ?? []);
		const addOraclePromises = [];
		for (const perpMarket of perpMarkets) {
			if (!perpMarket || !perpMarket.data) {
				continue;
			}
			const perpMarketAccount = perpMarket.data;
			const perpMarketIndex = perpMarketAccount.marketIndex;
			const oracle = perpMarketAccount.oracle;
			const oracleId = getOracleId(oracle, perpMarket.data.oracleSource);
			if (!this.oracleMultiSubscriber?.getAccountDataMap().has(oracleId)) {
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

	/** Rebuilds `spotOracleMap`/`spotOracleStringMap` from currently cached spot markets, calling `addOracle` for any oracle not yet tracked by `oracleMultiSubscriber`. */
	async setSpotOracleMap() {
		const spotMarketsMap = this.spotMarketsSubscriber?.getAccountDataMap();
		const spotMarkets = Array.from(spotMarketsMap?.values() ?? []);
		const addOraclePromises = [];
		for (const spotMarket of spotMarkets) {
			if (!spotMarket || !spotMarket.data) {
				continue;
			}
			const spotMarketAccount = spotMarket.data;
			const spotMarketIndex = spotMarketAccount.marketIndex;
			const oracle = spotMarketAccount.oracle;
			const oracleId = getOracleId(oracle, spotMarketAccount.oracleSource);
			if (!this.oracleMultiSubscriber?.getAccountDataMap().has(oracleId)) {
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
	 * Creates `perpMarketsSubscriber` (a `grpcMultiAccountSubscriber<PerpMarketAccount>`), seeds
	 * it with `initialPerpMarketAccountData`, and subscribes it to every tracked perp market
	 * pubkey in one gRPC stream. Registers an `onUnsubscribe` handler that automatically
	 * re-invokes this method to resubscribe if the underlying stream drops.
	 */
	async subscribeToPerpMarketAccounts(): Promise<boolean> {
		if (this.resubOpts?.logResubMessages) {
			console.log(
				'[grpcVelocityClientAccountSubscriberV2] subscribeToPerpMarketAccounts'
			);
		}
		const perpMarketIndexToAccountPubkeys: Array<[number, PublicKey]> =
			await Promise.all(
				this.perpMarketIndexes.map(async (marketIndex) => [
					marketIndex,
					await getPerpMarketPublicKey(this.program.programId, marketIndex),
				])
			);
		for (const [
			marketIndex,
			accountPubkey,
		] of perpMarketIndexToAccountPubkeys) {
			this.perpMarketIndexToAccountPubkeyMap.set(
				marketIndex,
				accountPubkey.toBase58()
			);
		}

		const perpMarketPubkeys = perpMarketIndexToAccountPubkeys.map(
			([_, accountPubkey]) => accountPubkey
		);

		this.perpMarketsSubscriber =
			await grpcMultiAccountSubscriber.create<PerpMarketAccount>(
				this.grpcConfigs,
				'perpMarket',
				this.program,
				undefined,
				this.resubOpts,
				undefined,
				async () => {
					try {
						if (this.resubOpts?.logResubMessages) {
							console.log(
								'[grpcVelocityClientAccountSubscriberV2] perp markets subscriber unsubscribed; resubscribing'
							);
						}
						await this.subscribeToPerpMarketAccounts();
					} catch (e) {
						console.error('Perp markets resubscribe failed:', e);
					}
				}
			);

		for (const data of this.initialPerpMarketAccountData.values()) {
			this.perpMarketsSubscriber.setAccountData(data.pubkey.toBase58(), data);
		}

		await this.perpMarketsSubscriber.subscribe(
			perpMarketPubkeys,
			(_accountId, data) => {
				this.eventEmitter.emit(
					'perpMarketAccountUpdate',
					data as PerpMarketAccount
				);
				this.eventEmitter.emit('update');
			}
		);

		return true;
	}

	/**
	 * Creates `spotMarketsSubscriber` (a `grpcMultiAccountSubscriber<SpotMarketAccount>`), seeds
	 * it with `initialSpotMarketAccountData`, and subscribes it to every tracked spot market
	 * pubkey in one gRPC stream. Registers an `onUnsubscribe` handler that automatically
	 * re-invokes this method to resubscribe if the underlying stream drops.
	 */
	async subscribeToSpotMarketAccounts(): Promise<boolean> {
		if (this.resubOpts?.logResubMessages) {
			console.log(
				'[grpcVelocityClientAccountSubscriberV2] subscribeToSpotMarketAccounts'
			);
		}
		const spotMarketIndexToAccountPubkeys: Array<[number, PublicKey]> =
			await Promise.all(
				this.spotMarketIndexes.map(async (marketIndex) => [
					marketIndex,
					await getSpotMarketPublicKey(this.program.programId, marketIndex),
				])
			);
		for (const [
			marketIndex,
			accountPubkey,
		] of spotMarketIndexToAccountPubkeys) {
			this.spotMarketIndexToAccountPubkeyMap.set(
				marketIndex,
				accountPubkey.toBase58()
			);
		}

		const spotMarketPubkeys = spotMarketIndexToAccountPubkeys.map(
			([_, accountPubkey]) => accountPubkey
		);

		this.spotMarketsSubscriber =
			await grpcMultiAccountSubscriber.create<SpotMarketAccount>(
				this.grpcConfigs,
				'spotMarket',
				this.program,
				undefined,
				this.resubOpts,
				undefined,
				async () => {
					try {
						if (this.resubOpts?.logResubMessages) {
							console.log(
								'[grpcVelocityClientAccountSubscriberV2] spot markets subscriber unsubscribed; resubscribing'
							);
						}
						await this.subscribeToSpotMarketAccounts();
					} catch (e) {
						console.error('Spot markets resubscribe failed:', e);
					}
				}
			);

		for (const data of this.initialSpotMarketAccountData.values()) {
			this.spotMarketsSubscriber.setAccountData(data.pubkey.toBase58(), data);
		}

		await this.spotMarketsSubscriber.subscribe(
			spotMarketPubkeys,
			(_accountId, data) => {
				this.eventEmitter.emit(
					'spotMarketAccountUpdate',
					data as SpotMarketAccount
				);
				this.eventEmitter.emit('update');
			}
		);

		return true;
	}

	/**
	 * Creates `oracleMultiSubscriber` (a `grpcMultiAccountSubscriber<OraclePriceData, OracleInfo>`)
	 * and subscribes it to every distinct oracle pubkey in one gRPC stream, decoding buffers with
	 * the source-appropriate `OracleClient`. Because multiple `(pubkey, source)` oracle ids can
	 * share one pubkey, `oraclePubkeyToInfosMap` fans a single decode out to every matching
	 * `OracleInfo`, and results are additionally indexed into `oracleIdToOracleDataMap` (by oracle
	 * id, not pubkey) for `getOraclePriceDataAndSlot` to read. Registers an `onUnsubscribe` handler
	 * that automatically re-invokes this method to resubscribe if the underlying stream drops.
	 */
	async subscribeToOracles(): Promise<boolean> {
		if (this.resubOpts?.logResubMessages) {
			console.log('grpcVelocityClientAccountSubscriberV2 subscribeToOracles');
		}
		const oraclePubkeyToInfosMap = new Map<string, OracleInfo[]>();
		for (const info of this.oracleInfos) {
			const pubkey = info.publicKey.toBase58();
			if (!oraclePubkeyToInfosMap.has(pubkey)) {
				oraclePubkeyToInfosMap.set(pubkey, []);
			}
			oraclePubkeyToInfosMap.get(pubkey)!.push(info);
		}

		const oraclePubkeys = Array.from(
			new Set(this.oracleInfos.map((info) => info.publicKey))
		);

		this.oracleMultiSubscriber = await grpcMultiAccountSubscriber.create<
			OraclePriceData,
			OracleInfo
		>(
			this.grpcConfigs,
			'oracle',
			this.program,
			(buffer: Buffer, pubkey?: string, accountProps?: OracleInfo) => {
				if (!pubkey) {
					throw new Error('Oracle pubkey missing in decode');
				}

				if (!accountProps) {
					throw new Error('Oracle accountProps missing in decode');
				}

				const client = this.oracleClientCache.get(
					accountProps.source,
					this.program.provider.connection,
					this.program
				);
				if (!client) {
					throw new Error('Oracle client missing in decode');
				}
				const price = client.getOraclePriceDataFromBuffer(buffer);
				return price;
			},
			this.resubOpts,
			undefined,
			async () => {
				try {
					if (this.resubOpts?.logResubMessages) {
						console.log(
							'[grpcVelocityClientAccountSubscriberV2] oracle subscriber unsubscribed; resubscribing'
						);
					}
					await this.subscribeToOracles();
				} catch (e) {
					console.error('Oracle resubscribe failed:', e);
				}
			},
			oraclePubkeyToInfosMap
		);

		for (const data of this.initialOraclePriceData.entries()) {
			const { publicKey } = getPublicKeyAndSourceFromOracleId(data[0]);
			this.oracleMultiSubscriber.setAccountData(publicKey.toBase58(), data[1]);
			this.oracleIdToOracleDataMap.set(data[0], {
				data: data[1],
				slot: 0,
			});
		}

		await this.oracleMultiSubscriber.subscribe(
			oraclePubkeys,
			(accountId, data, context, _b, accountProps) => {
				if (accountProps === undefined) {
					return;
				}
				const oracleId = getOracleId(accountId, accountProps.source);
				this.oracleIdToOracleDataMap.set(oracleId, {
					data,
					slot: context.slot,
				});
				this.eventEmitter.emit(
					'oraclePriceUpdate',
					accountId,
					accountProps.source,
					data
				);

				this.eventEmitter.emit('update');
			}
		);

		return true;
	}

	/**
	 * Applies `delistedMarketSetting` to any perp market currently `status: delisted` (and its
	 * oracle, if not shared with a live spot market) by removing its pubkey from the relevant
	 * `grpcMultiAccountSubscriber` via `removeAccounts`. A no-op if the setting is `Subscribe`.
	 * Unlike the WebSocket/polling variants, this does not distinguish `Unsubscribe` from
	 * `Discard` — both remove the account from the multiplexed stream (there is no per-account
	 * "keep last known data, stop streaming" state to preserve at this granularity).
	 */
	async handleDelistedMarkets(): Promise<void> {
		if (this.delistedMarketSetting === DelistedMarketSetting.Subscribe) {
			return;
		}

		const { perpMarketIndexes, oracles } = findDelistedPerpMarketsAndOracles(
			Array.from(
				this.perpMarketsSubscriber?.getAccountDataMap().values() || []
			),
			Array.from(this.spotMarketsSubscriber?.getAccountDataMap().values() || [])
		);

		// Build array of perp market pubkeys to remove
		const perpMarketPubkeysToRemove = perpMarketIndexes
			.map((marketIndex) => {
				const pubkeyString =
					this.perpMarketIndexToAccountPubkeyMap.get(marketIndex);
				return pubkeyString ? new PublicKey(pubkeyString) : null;
			})
			.filter((pubkey): pubkey is PublicKey => pubkey !== null);

		// Build array of oracle pubkeys to remove
		const oraclePubkeysToRemove = oracles.map((oracle) => oracle.publicKey);

		// Remove accounts in batches - perp markets
		if (perpMarketPubkeysToRemove.length > 0) {
			await this.perpMarketsSubscriber?.removeAccounts(
				perpMarketPubkeysToRemove
			);
		}

		// Remove accounts in batches - oracles
		if (oraclePubkeysToRemove.length > 0) {
			await this.oracleMultiSubscriber?.removeAccounts(oraclePubkeysToRemove);
		}
	}

	/** Clears the seed data stashed by `setInitialData()` once the multi-account subscribers have consumed it, freeing the memory. */
	removeInitialData() {
		this.initialPerpMarketAccountData = new Map();
		this.initialSpotMarketAccountData = new Map();
		this.initialOraclePriceData = new Map();
	}

	/** Tears down `oracleMultiSubscriber`'s gRPC stream, if active, and clears the reference. */
	async unsubscribeFromOracles(): Promise<void> {
		if (this.oracleMultiSubscriber) {
			await this.oracleMultiSubscriber.unsubscribe();
			this.oracleMultiSubscriber = undefined;
			return;
		}
	}

	/**
	 * Tears down the `State` subscriber and all three multiplexed subscribers (perp markets, spot
	 * markets, oracles), then clears every internal map to avoid holding stale references. A no-op
	 * if not subscribed.
	 */
	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		this.isSubscribed = false;
		this.isSubscribing = false;

		await this.stateAccountSubscriber?.unsubscribe();
		await this.unsubscribeFromOracles();
		await this.perpMarketsSubscriber?.unsubscribe();
		await this.spotMarketsSubscriber?.unsubscribe();

		// Clean up all maps to prevent memory leaks
		this.perpMarketIndexToAccountPubkeyMap.clear();
		this.spotMarketIndexToAccountPubkeyMap.clear();
		this.oracleIdToOracleDataMap.clear();
		this.perpOracleMap.clear();
		this.perpOracleStringMap.clear();
		this.spotOracleMap.clear();
		this.spotOracleStringMap.clear();
	}
}
