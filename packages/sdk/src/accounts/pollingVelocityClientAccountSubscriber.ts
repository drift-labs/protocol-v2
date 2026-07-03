import {
	AccountToPoll,
	DataAndSlot,
	DelistedMarketSetting,
	VelocityClientAccountEvents,
	VelocityClientAccountSubscriber,
	NotSubscribedError,
	OraclesToPoll,
} from './types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	PerpMarketAccount,
	SpotMarketAccount,
	StateAccount,
	UserAccount,
	OracleSource,
} from '../types';
import {
	getVelocityStateAccountPublicKey,
	getPerpMarketPublicKey,
	getSpotMarketPublicKey,
} from '../addresses/pda';
import { BulkAccountLoader } from './bulkAccountLoader';
import { findDelistedPerpMarketsAndOracles } from './utils';
import { PublicKey } from '@solana/web3.js';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { OracleClientCache } from '../oracles/oracleClientCache';
import { QUOTE_ORACLE_PRICE_DATA } from '../oracles/quoteAssetOracleClient';
import { findAllMarketAndOracles, VelocityProgram } from '../config';
import { getOracleId } from '../oracles/oracleId';

const ORACLE_DEFAULT_ID = getOracleId(
	PublicKey.default,
	OracleSource.QUOTE_ASSET
);

/**
 * `VelocityClientAccountSubscriber` that batches the `State`, every tracked `PerpMarket`/
 * `SpotMarket`, and every tracked oracle behind a single `BulkAccountLoader` instead of one
 * WebSocket subscription per account. Cheaper on connection count at the cost of update latency
 * bounded by the loader's poll interval. `subscribe()` retries the initial load up to 5 times
 * before giving up (returning `false`) if the `State` account never appears — `didSubscriptionSucceed`
 * checks only for `state`, since market/oracle data can be added incrementally afterward via
 * `addPerpMarket`/`addSpotMarket`/`addOracle`.
 */
export class PollingVelocityClientAccountSubscriber
	implements VelocityClientAccountSubscriber
{
	isSubscribed: boolean;
	program: VelocityProgram;
	perpMarketIndexes: number[];
	spotMarketIndexes: number[];
	oracleInfos: OracleInfo[];
	oracleClientCache = new OracleClientCache();

	shouldFindAllMarketsAndOracles: boolean;

	eventEmitter: StrictEventEmitter<EventEmitter, VelocityClientAccountEvents>;

	accountLoader: BulkAccountLoader;
	accountsToPoll = new Map<string, AccountToPoll>();
	oraclesToPoll = new Map<string, OraclesToPoll>();
	errorCallbackId?: string;

	state?: DataAndSlot<StateAccount>;
	perpMarket = new Map<number, DataAndSlot<PerpMarketAccount>>();
	perpOracleMap = new Map<number, PublicKey>();
	perpOracleStringMap = new Map<number, string>();
	spotMarket = new Map<number, DataAndSlot<SpotMarketAccount>>();
	spotOracleMap = new Map<number, PublicKey>();
	spotOracleStringMap = new Map<number, string>();
	oracles = new Map<string, DataAndSlot<OraclePriceData>>();
	user?: DataAndSlot<UserAccount>;
	delistedMarketSetting: DelistedMarketSetting;

	private isSubscribing = false;
	private subscriptionPromiseResolver: (val: boolean) => void = () => {};
	private subscriptionPromise: Promise<boolean> = new Promise((res) => {
		this.subscriptionPromiseResolver = res;
	});

	/**
	 * @param program Anchor program used to derive PDAs, decode accounts, and resolve oracle clients.
	 * @param accountLoader Shared `BulkAccountLoader` all state/market/oracle accounts are registered with.
	 * @param perpMarketIndexes Perp market indexes to track, if `shouldFindAllMarketsAndOracles` is false.
	 * @param spotMarketIndexes Spot market indexes to track, if `shouldFindAllMarketsAndOracles` is false.
	 * @param oracleInfos Oracles to track up front, if `shouldFindAllMarketsAndOracles` is false.
	 * @param shouldFindAllMarketsAndOracles If true, `subscribe()` first discovers every market/oracle from on-chain state, ignoring the index/info args above.
	 * @param delistedMarketSetting Behavior applied to delisted perp markets/oracles after subscribing; see `DelistedMarketSetting`.
	 */
	public constructor(
		program: VelocityProgram,
		accountLoader: BulkAccountLoader,
		perpMarketIndexes: number[],
		spotMarketIndexes: number[],
		oracleInfos: OracleInfo[],
		shouldFindAllMarketsAndOracles: boolean,
		delistedMarketSetting: DelistedMarketSetting
	) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.accountLoader = accountLoader;
		this.perpMarketIndexes = perpMarketIndexes;
		this.spotMarketIndexes = spotMarketIndexes;
		this.oracleInfos = oracleInfos;
		this.shouldFindAllMarketsAndOracles = shouldFindAllMarketsAndOracles;
		this.delistedMarketSetting = delistedMarketSetting;
	}

	/**
	 * Registers state/market/oracle accounts with the `BulkAccountLoader` and retries the initial
	 * load up to 5 times until the `State` account has appeared. Idempotent: a no-op if already
	 * subscribed, and concurrent calls while a subscribe is in flight share the same result via
	 * `subscriptionPromise` rather than issuing duplicate loads.
	 * @returns `true` if `State` account data loaded within the retry budget, `false` otherwise.
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
			const { perpMarketIndexes, spotMarketIndexes, oracleInfos } =
				await findAllMarketAndOracles(this.program);
			this.perpMarketIndexes = perpMarketIndexes;
			this.spotMarketIndexes = spotMarketIndexes;
			this.oracleInfos = oracleInfos;
		}

		await this.updateAccountsToPoll();
		this.updateOraclesToPoll();
		await this.addToAccountLoader();

		let subscriptionSucceeded = false;
		let retries = 0;
		while (!subscriptionSucceeded && retries < 5) {
			await this.fetch();
			subscriptionSucceeded = this.didSubscriptionSucceed();
			retries++;
		}

		if (subscriptionSucceeded) {
			this.eventEmitter.emit('update');
		}

		this.handleDelistedMarkets();

		await Promise.all([this.setPerpOracleMap(), this.setSpotOracleMap()]);

		this.isSubscribing = false;
		this.isSubscribed = subscriptionSucceeded;
		this.subscriptionPromiseResolver(subscriptionSucceeded);

		return subscriptionSucceeded;
	}

	async updateAccountsToPoll(): Promise<void> {
		if (this.accountsToPoll.size > 0) {
			return;
		}

		const statePublicKey = await getVelocityStateAccountPublicKey(
			this.program.programId
		);

		this.accountsToPoll.set(statePublicKey.toString(), {
			key: 'state',
			publicKey: statePublicKey,
			eventType: 'stateAccountUpdate',
		});

		await Promise.all([
			this.updatePerpMarketAccountsToPoll(),
			this.updateSpotMarketAccountsToPoll(),
		]);
	}

	async updatePerpMarketAccountsToPoll(): Promise<boolean> {
		await Promise.all(
			this.perpMarketIndexes.map((marketIndex) => {
				return this.addPerpMarketAccountToPoll(marketIndex);
			})
		);
		return true;
	}

	async addPerpMarketAccountToPoll(marketIndex: number): Promise<boolean> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		this.accountsToPoll.set(perpMarketPublicKey.toString(), {
			key: 'perpMarket',
			publicKey: perpMarketPublicKey,
			eventType: 'perpMarketAccountUpdate',
			mapKey: marketIndex,
		});

		return true;
	}

	async updateSpotMarketAccountsToPoll(): Promise<boolean> {
		await Promise.all(
			this.spotMarketIndexes.map(async (marketIndex) => {
				await this.addSpotMarketAccountToPoll(marketIndex);
			})
		);

		return true;
	}

	async addSpotMarketAccountToPoll(marketIndex: number): Promise<boolean> {
		const marketPublicKey = await getSpotMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		this.accountsToPoll.set(marketPublicKey.toString(), {
			key: 'spotMarket',
			publicKey: marketPublicKey,
			eventType: 'spotMarketAccountUpdate',
			mapKey: marketIndex,
		});
		return true;
	}

	updateOraclesToPoll(): boolean {
		for (const oracleInfo of this.oracleInfos) {
			if (!oracleInfo.publicKey.equals(PublicKey.default)) {
				this.addOracleToPoll(oracleInfo);
			}
		}

		return true;
	}

	addOracleToPoll(oracleInfo: OracleInfo): boolean {
		this.oraclesToPoll.set(
			getOracleId(oracleInfo.publicKey, oracleInfo.source),
			{
				publicKey: oracleInfo.publicKey,
				source: oracleInfo.source,
			}
		);

		return true;
	}
	async addToAccountLoader(): Promise<void> {
		const accountPromises = [];
		for (const [_, accountToPoll] of this.accountsToPoll) {
			accountPromises.push(this.addAccountToAccountLoader(accountToPoll));
		}

		const oraclePromises = [];
		for (const [_, oracleToPoll] of this.oraclesToPoll) {
			oraclePromises.push(this.addOracleToAccountLoader(oracleToPoll));
		}

		await Promise.all([...accountPromises, ...oraclePromises]);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	/**
	 * Routes a freshly-decoded account into the correct container based on
	 * its poll key. Replaces dynamic `this[key]` indexing with explicit,
	 * type-checked dispatch.
	 */
	private storeDecodedAccount(
		accountToPoll: AccountToPoll,
		account: any,
		slot: number
	): void {
		const dataAndSlot = { data: account, slot };
		switch (accountToPoll.key) {
			case 'perpMarket':
				if (accountToPoll.mapKey !== undefined) {
					this.perpMarket.set(accountToPoll.mapKey, dataAndSlot);
				}
				break;
			case 'spotMarket':
				if (accountToPoll.mapKey !== undefined) {
					this.spotMarket.set(accountToPoll.mapKey, dataAndSlot);
				}
				break;
			case 'state':
				this.state = dataAndSlot;
				break;
			default: {
				const _exhaustive: never = accountToPoll.key;
				throw new Error(`Unhandled account poll key: ${String(_exhaustive)}`);
			}
		}
	}

	async addAccountToAccountLoader(accountToPoll: AccountToPoll): Promise<void> {
		accountToPoll.callbackId = await this.accountLoader.addAccount(
			accountToPoll.publicKey,
			(buffer: Buffer, slot: number) => {
				if (!buffer) return;

				const account = this.program.coder.accounts.decodeUnchecked(
					accountToPoll.key,
					buffer
				);
				this.storeDecodedAccount(accountToPoll, account, slot);

				// @ts-ignore
				this.eventEmitter.emit(accountToPoll.eventType, account);
				this.eventEmitter.emit('update');

				if (!this.isSubscribed) {
					this.isSubscribed = this.didSubscriptionSucceed();
				}
			}
		);
	}

	async addOracleToAccountLoader(oracleToPoll: OraclesToPoll): Promise<void> {
		const oracleClient = this.oracleClientCache.get(
			oracleToPoll.source,
			this.program.provider.connection,
			this.program
		);

		const oracleId = getOracleId(oracleToPoll.publicKey, oracleToPoll.source);

		oracleToPoll.callbackId = await this.accountLoader.addAccount(
			oracleToPoll.publicKey,
			(buffer: Buffer, slot: number) => {
				if (!buffer) return;
				if (!oracleClient) return;

				const oraclePriceData =
					oracleClient.getOraclePriceDataFromBuffer(buffer);
				const dataAndSlot = {
					data: oraclePriceData,
					slot,
				};

				this.oracles.set(oracleId, dataAndSlot);

				this.eventEmitter.emit(
					'oraclePriceUpdate',
					oracleToPoll.publicKey,
					oracleToPoll.source,
					oraclePriceData
				);
				this.eventEmitter.emit('update');
			}
		);
	}

	/** Forces the shared `BulkAccountLoader` to load, then re-decodes every tracked state/market/oracle account from the loader's cached buffers into this subscriber's maps. */
	public async fetch(): Promise<void> {
		await this.accountLoader.load();
		for (const [_, accountToPoll] of this.accountsToPoll) {
			const bufferAndSlot = this.accountLoader.getBufferAndSlot(
				accountToPoll.publicKey
			);

			if (!bufferAndSlot) {
				continue;
			}

			const { buffer, slot } = bufferAndSlot;

			if (buffer) {
				const account = this.program.coder.accounts.decodeUnchecked(
					accountToPoll.key,
					buffer
				);
				this.storeDecodedAccount(accountToPoll, account, slot);
			}
		}

		for (const [_, oracleToPoll] of this.oraclesToPoll) {
			const bufferAndSlot = this.accountLoader.getBufferAndSlot(
				oracleToPoll.publicKey
			);

			if (!bufferAndSlot) {
				continue;
			}

			const { buffer, slot } = bufferAndSlot;

			if (buffer) {
				const oracleClient = this.oracleClientCache.get(
					oracleToPoll.source,
					this.program.provider.connection,
					this.program
				);
				if (!oracleClient) {
					continue;
				}
				const oraclePriceData =
					oracleClient.getOraclePriceDataFromBuffer(buffer);
				this.oracles.set(
					getOracleId(oracleToPoll.publicKey, oracleToPoll.source),
					{
						data: oraclePriceData,
						slot,
					}
				);
			}
		}
	}

	/** True once the `State` account has loaded, independent of `isSubscribed`. Market/oracle data is not required. */
	didSubscriptionSucceed(): boolean {
		if (this.state) return true;

		return false;
	}

	/** Removes every tracked state/market/oracle account and the error callback from the `BulkAccountLoader`, then clears internal maps. */
	public async unsubscribe(): Promise<void> {
		for (const [_, accountToPoll] of this.accountsToPoll) {
			this.accountLoader.removeAccount(
				accountToPoll.publicKey,
				accountToPoll.callbackId
			);
		}

		for (const [_, oracleToPoll] of this.oraclesToPoll) {
			this.accountLoader.removeAccount(
				oracleToPoll.publicKey,
				oracleToPoll.callbackId
			);
		}

		this.accountLoader.removeErrorCallbacks(this.errorCallbackId);
		this.errorCallbackId = undefined;

		this.accountsToPoll.clear();
		this.oraclesToPoll.clear();
		this.isSubscribed = false;
	}

	/**
	 * Adds a spot market (and its oracle, via `setSpotOracleMap`) to be tracked, registering it
	 * with the `BulkAccountLoader`. Idempotent: returns `true` immediately if already tracked.
	 * @param marketIndex Spot market index to start tracking.
	 */
	async addSpotMarket(marketIndex: number): Promise<boolean> {
		const marketPublicKey = await getSpotMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		if (this.accountsToPoll.has(marketPublicKey.toString())) {
			return true;
		}

		await this.addSpotMarketAccountToPoll(marketIndex);

		const accountToPoll = this.accountsToPoll.get(marketPublicKey.toString());
		if (!accountToPoll) {
			return false;
		}

		await this.addAccountToAccountLoader(accountToPoll);
		await this.setSpotOracleMap();
		return true;
	}

	/**
	 * Adds a perp market (and its oracle, via `setPerpOracleMap`) to be tracked, registering it
	 * with the `BulkAccountLoader`. Idempotent: returns `true` immediately if already tracked.
	 * @param marketIndex Perp market index to start tracking.
	 */
	async addPerpMarket(marketIndex: number): Promise<boolean> {
		const marketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		if (this.accountsToPoll.has(marketPublicKey.toString())) {
			return true;
		}

		await this.addPerpMarketAccountToPoll(marketIndex);
		const accountToPoll = this.accountsToPoll.get(marketPublicKey.toString());
		if (!accountToPoll) {
			return false;
		}
		await this.addAccountToAccountLoader(accountToPoll);
		await this.setPerpOracleMap();
		return true;
	}

	/**
	 * Adds an oracle to be tracked, registering it with the `BulkAccountLoader` and waiting
	 * (polling up to 3 times at `accountLoader.pollingFrequency` intervals) for it to appear in
	 * the loader's buffer map before resolving. A no-op that resolves `true` immediately for the
	 * `PublicKey.default` sentinel (quote-asset "no oracle") or an oracle already tracked.
	 * @param oracleInfo Oracle pubkey and source to start tracking.
	 */
	async addOracle(oracleInfo: OracleInfo): Promise<boolean> {
		const oracleId = getOracleId(oracleInfo.publicKey, oracleInfo.source);
		if (
			oracleInfo.publicKey.equals(PublicKey.default) ||
			this.oracles.has(oracleId)
		) {
			return true;
		}

		// this func can be called multiple times before the first pauseForOracleToBeAdded finishes
		// avoid adding to oraclesToPoll multiple time
		if (!this.oraclesToPoll.has(oracleId)) {
			this.addOracleToPoll(oracleInfo);
			const oracleToPoll = this.oraclesToPoll.get(oracleId);
			if (oracleToPoll) {
				await this.addOracleToAccountLoader(oracleToPoll);
			}
		}

		await this.pauseForOracleToBeAdded(3, oracleInfo.publicKey.toBase58());

		return true;
	}

	private async pauseForOracleToBeAdded(
		tries: number,
		oracle: string
	): Promise<void> {
		let i = 0;
		while (i < tries) {
			await new Promise((r) =>
				setTimeout(r, this.accountLoader.pollingFrequency)
			);
			if (this.accountLoader.bufferAndSlotMap.has(oracle)) {
				return;
			}
			i++;
		}
		console.log(`Pausing to find oracle ${oracle} failed`);
	}

	/** Rebuilds `perpOracleMap`/`perpOracleStringMap` from currently cached perp markets, calling `addOracle` for any oracle not yet tracked. */
	async setPerpOracleMap() {
		const perpMarkets = this.getMarketAccountsAndSlots();
		const oraclePromises = [];
		for (const perpMarket of perpMarkets) {
			const perpMarketAccount = perpMarket.data;
			const perpMarketIndex = perpMarketAccount.marketIndex;
			const oracle = perpMarketAccount.oracle;
			const oracleId = getOracleId(oracle, perpMarketAccount.oracleSource);
			if (!this.oracles.has(oracleId)) {
				oraclePromises.push(
					this.addOracle({
						publicKey: oracle,
						source: perpMarketAccount.oracleSource,
					})
				);
			}
			this.perpOracleMap.set(perpMarketIndex, oracle);
			this.perpOracleStringMap.set(perpMarketIndex, oracleId);
		}
		await Promise.all(oraclePromises);
	}

	/** Rebuilds `spotOracleMap`/`spotOracleStringMap` from currently cached spot markets, calling `addOracle` for any oracle not yet tracked. */
	async setSpotOracleMap() {
		const spotMarkets = this.getSpotMarketAccountsAndSlots();
		const oraclePromises = [];
		for (const spotMarket of spotMarkets) {
			const spotMarketAccount = spotMarket.data;
			const spotMarketIndex = spotMarketAccount.marketIndex;
			const oracle = spotMarketAccount.oracle;
			const oracleId = getOracleId(oracle, spotMarketAccount.oracleSource);
			if (!this.oracles.has(oracleId)) {
				oraclePromises.push(
					this.addOracle({
						publicKey: oracle,
						source: spotMarketAccount.oracleSource,
					})
				);
			}
			this.spotOracleMap.set(spotMarketIndex, oracle);
			this.spotOracleStringMap.set(spotMarketIndex, oracleId);
		}
		await Promise.all(oraclePromises);
	}

	/**
	 * Applies `delistedMarketSetting` to any perp market currently `status: delisted` (and its
	 * oracle, if not shared with a live spot market): removes the `BulkAccountLoader` registration,
	 * and additionally drops the market/oracle from internal maps if the setting is `Discard`. A
	 * no-op if the setting is `Subscribe`. Throws if internal bookkeeping is inconsistent (e.g. a
	 * delisted market missing from `accountsToPoll`), which would indicate a bug rather than an
	 * expected runtime condition.
	 */
	handleDelistedMarkets(): void {
		if (this.delistedMarketSetting === DelistedMarketSetting.Subscribe) {
			return;
		}

		const { perpMarketIndexes, oracles } = findDelistedPerpMarketsAndOracles(
			this.getMarketAccountsAndSlots(),
			this.getSpotMarketAccountsAndSlots()
		);

		for (const perpMarketIndex of perpMarketIndexes) {
			const perpMarketData = this.perpMarket.get(perpMarketIndex);
			if (!perpMarketData) {
				throw new Error(
					`PollingVelocityClientAccountSubscriber: delisted perp market ${perpMarketIndex} not found in perpMarket map`
				);
			}
			const perpMarketPubkey = perpMarketData.data.pubkey;
			const accountToPoll = this.accountsToPoll.get(
				perpMarketPubkey.toBase58()
			);
			if (!accountToPoll) {
				throw new Error(
					`PollingVelocityClientAccountSubscriber: delisted perp market ${perpMarketIndex} not found in accountsToPoll map`
				);
			}
			const callbackId = accountToPoll.callbackId;
			this.accountLoader.removeAccount(perpMarketPubkey, callbackId);
			if (this.delistedMarketSetting === DelistedMarketSetting.Discard) {
				this.perpMarket.delete(perpMarketIndex);
			}
		}

		for (const oracle of oracles) {
			const oracleId = getOracleId(oracle.publicKey, oracle.source);
			const oracleToPoll = this.oraclesToPoll.get(oracleId);
			if (!oracleToPoll) {
				throw new Error(
					`PollingVelocityClientAccountSubscriber: delisted oracle ${oracleId} not found in oraclesToPoll map`
				);
			}
			const callbackId = oracleToPoll.callbackId;
			this.accountLoader.removeAccount(oracle.publicKey, callbackId);
			if (this.delistedMarketSetting === DelistedMarketSetting.Discard) {
				this.oracles.delete(oracleId);
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

	/** Throws `NotSubscribedError` if not subscribed. */
	public getStateAccountAndSlot(): DataAndSlot<StateAccount> {
		this.assertIsSubscribed();
		return this.state!;
	}

	/** Returns the cached perp market, or undefined if `marketIndex` isn't tracked (or hasn't loaded yet). Does not throw `NotSubscribedError`. */
	public getMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<PerpMarketAccount> | undefined {
		return this.perpMarket.get(marketIndex);
	}

	/** Returns every currently cached perp market. Does not throw `NotSubscribedError`. */
	public getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[] {
		return Array.from(this.perpMarket.values());
	}

	/** Returns the cached spot market, or undefined if `marketIndex` isn't tracked (or hasn't loaded yet). Does not throw `NotSubscribedError`. */
	public getSpotMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<SpotMarketAccount> | undefined {
		return this.spotMarket.get(marketIndex);
	}

	/** Returns every currently cached spot market. Does not throw `NotSubscribedError`. */
	public getSpotMarketAccountsAndSlots(): DataAndSlot<SpotMarketAccount>[] {
		return Array.from(this.spotMarket.values());
	}

	/**
	 * Looks up cached oracle price data by oracle id (see `getOracleId`). Special-cases the
	 * quote-asset default oracle id, returning the constant `QUOTE_ORACLE_PRICE_DATA` at slot 0
	 * rather than a map lookup, since that oracle is never actually subscribed to.
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

		return this.oracles.get(oracleId);
	}

	/**
	 * Convenience lookup: resolves the oracle price data currently mapped to a perp market's
	 * oracle. If the cached market's oracle pubkey has drifted from `perpOracleMap` (e.g. an admin
	 * changed it on-chain), triggers a background `setPerpOracleMap()` refresh and still returns
	 * the (possibly stale) mapping for this call.
	 * @param marketIndex Perp market index whose oracle price to look up.
	 */
	public getOraclePriceDataAndSlotForPerpMarket(
		marketIndex: number
	): DataAndSlot<OraclePriceData> | undefined {
		const perpMarketAccount = this.getMarketAccountAndSlot(marketIndex);
		const oracle = this.perpOracleMap.get(marketIndex);
		const oracleId = this.perpOracleStringMap.get(marketIndex);

		if (!perpMarketAccount || !oracle || !oracleId) {
			return undefined;
		}

		if (!perpMarketAccount.data.oracle.equals(oracle)) {
			// If the oracle has changed, we need to update the oracle map in background
			this.setPerpOracleMap();
		}

		return this.getOraclePriceDataAndSlot(oracleId);
	}

	/**
	 * Convenience lookup: resolves the oracle price data currently mapped to a spot market's
	 * oracle. If the cached market's oracle pubkey has drifted from `spotOracleMap`, triggers a
	 * background `setSpotOracleMap()` refresh and still returns the (possibly stale) mapping for
	 * this call.
	 * @param marketIndex Spot market index whose oracle price to look up.
	 */
	public getOraclePriceDataAndSlotForSpotMarket(
		marketIndex: number
	): DataAndSlot<OraclePriceData> | undefined {
		const spotMarketAccount = this.getSpotMarketAccountAndSlot(marketIndex);
		const oracle = this.spotOracleMap.get(marketIndex);
		const oracleId = this.spotOracleStringMap.get(marketIndex);
		if (!spotMarketAccount || !oracle || !oracleId) {
			return undefined;
		}

		if (!spotMarketAccount.data.oracle.equals(oracle)) {
			// If the oracle has changed, we need to update the oracle map in background
			this.setSpotOracleMap();
		}

		return this.getOraclePriceDataAndSlot(oracleId);
	}

	/** Retunes the shared `BulkAccountLoader`'s poll interval (ms) for every account it batches (affects other subscribers sharing the same loader too). */
	public updateAccountLoaderPollingFrequency(pollingFrequency: number): void {
		this.accountLoader.updatePollingFrequency(pollingFrequency);
	}
}
