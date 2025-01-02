import {
	AccountToPoll,
	DataAndSlot,
	DelistedMarketSetting,
	DriftClientAccountEvents,
	DriftClientAccountSubscriber,
	NotSubscribedError,
	OraclesToPoll,
} from './types';
import { Program } from '@coral-xyz/anchor';
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
	getDriftStateAccountPublicKey,
	getPerpMarketPublicKey,
	getSpotMarketPublicKey,
} from '../addresses/pda';
import { BulkAccountLoader } from './bulkAccountLoader';
import { capitalize, findDelistedPerpMarketsAndOracles } from './utils';
import { PublicKey } from '@solana/web3.js';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { OracleClientCache } from '../oracles/oracleClientCache';
import { QUOTE_ORACLE_PRICE_DATA } from '../oracles/quoteAssetOracleClient';
import { findAllMarketAndOracles } from '../config';
import { getOracleId } from '../oracles/oracleId';

const ORACLE_DEFAULT_ID = getOracleId(
	PublicKey.default,
	OracleSource.QUOTE_ASSET
);

export class PollingDriftClientAccountSubscriber
	implements DriftClientAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	perpMarketIndexes: number[];
	spotMarketIndexes: number[];
	oracleInfos: OracleInfo[];
	oracleClientCache = new OracleClientCache();

	shouldFindAllMarketsAndOracles: boolean;

	eventEmitter: StrictEventEmitter<EventEmitter, DriftClientAccountEvents>;

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
	private subscriptionPromise: Promise<boolean>;
	private subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(
		program: Program,
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

		const statePublicKey = await getDriftStateAccountPublicKey(
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

	async addAccountToAccountLoader(accountToPoll: AccountToPoll): Promise<void> {
		accountToPoll.callbackId = await this.accountLoader.addAccount(
			accountToPoll.publicKey,
			(buffer: Buffer, slot: number) => {
				if (!buffer) return;

				const account = this.program.account[
					accountToPoll.key
				].coder.accounts.decodeUnchecked(capitalize(accountToPoll.key), buffer);
				const dataAndSlot = {
					data: account,
					slot,
				};
				if (accountToPoll.mapKey != undefined) {
					this[accountToPoll.key].set(accountToPoll.mapKey, dataAndSlot);
				} else {
					this[accountToPoll.key] = dataAndSlot;
				}

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
				const account = this.program.account[
					accountToPoll.key
				].coder.accounts.decodeUnchecked(capitalize(accountToPoll.key), buffer);
				if (accountToPoll.mapKey != undefined) {
					this[accountToPoll.key].set(accountToPoll.mapKey, {
						data: account,
						slot,
					});
				} else {
					this[accountToPoll.key] = {
						data: account,
						slot,
					};
				}
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

	didSubscriptionSucceed(): boolean {
		if (this.state) return true;

		return false;
	}

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

		await this.addAccountToAccountLoader(accountToPoll);
		this.setSpotOracleMap();
		return true;
	}

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
		await this.addAccountToAccountLoader(accountToPoll);
		await this.setPerpOracleMap();
		return true;
	}

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
			await this.addOracleToAccountLoader(oracleToPoll);
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

	async setPerpOracleMap() {
		const perpMarkets = this.getMarketAccountsAndSlots();
		const oraclePromises = [];
		for (const perpMarket of perpMarkets) {
			const perpMarketAccount = perpMarket.data;
			const perpMarketIndex = perpMarketAccount.marketIndex;
			const oracle = perpMarketAccount.amm.oracle;
			const oracleId = getOracleId(oracle, perpMarketAccount.amm.oracleSource);
			if (!this.oracles.has(oracleId)) {
				oraclePromises.push(
					this.addOracle({
						publicKey: oracle,
						source: perpMarketAccount.amm.oracleSource,
					})
				);
			}
			this.perpOracleMap.set(perpMarketIndex, oracle);
			this.perpOracleStringMap.set(perpMarketIndex, oracleId);
		}
		await Promise.all(oraclePromises);
	}

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

	handleDelistedMarkets(): void {
		if (this.delistedMarketSetting === DelistedMarketSetting.Subscribe) {
			return;
		}

		const { perpMarketIndexes, oracles } = findDelistedPerpMarketsAndOracles(
			this.getMarketAccountsAndSlots(),
			this.getSpotMarketAccountsAndSlots()
		);

		for (const perpMarketIndex of perpMarketIndexes) {
			const perpMarketPubkey = this.perpMarket.get(perpMarketIndex).data.pubkey;
			const callbackId = this.accountsToPoll.get(
				perpMarketPubkey.toBase58()
			).callbackId;
			this.accountLoader.removeAccount(perpMarketPubkey, callbackId);
			if (this.delistedMarketSetting === DelistedMarketSetting.Discard) {
				this.perpMarket.delete(perpMarketIndex);
			}
		}

		for (const oracle of oracles) {
			const oracleId = getOracleId(oracle.publicKey, oracle.source);
			const callbackId = this.oraclesToPoll.get(oracleId).callbackId;
			this.accountLoader.removeAccount(oracle.publicKey, callbackId);
			if (this.delistedMarketSetting === DelistedMarketSetting.Discard) {
				this.oracles.delete(oracleId);
			}
		}
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getStateAccountAndSlot(): DataAndSlot<StateAccount> {
		this.assertIsSubscribed();
		return this.state;
	}

	public getMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<PerpMarketAccount> | undefined {
		return this.perpMarket.get(marketIndex);
	}

	public getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[] {
		return Array.from(this.perpMarket.values());
	}

	public getSpotMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<SpotMarketAccount> | undefined {
		return this.spotMarket.get(marketIndex);
	}

	public getSpotMarketAccountsAndSlots(): DataAndSlot<SpotMarketAccount>[] {
		return Array.from(this.spotMarket.values());
	}

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

	public getOraclePriceDataAndSlotForPerpMarket(
		marketIndex: number
	): DataAndSlot<OraclePriceData> | undefined {
		const perpMarketAccount = this.getMarketAccountAndSlot(marketIndex);
		const oracle = this.perpOracleMap.get(marketIndex);
		const oracleId = this.perpOracleStringMap.get(marketIndex);

		if (!perpMarketAccount || !oracle) {
			return undefined;
		}

		if (!perpMarketAccount.data.amm.oracle.equals(oracle)) {
			// If the oracle has changed, we need to update the oracle map in background
			this.setPerpOracleMap();
		}

		return this.getOraclePriceDataAndSlot(oracleId);
	}

	public getOraclePriceDataAndSlotForSpotMarket(
		marketIndex: number
	): DataAndSlot<OraclePriceData> | undefined {
		const spotMarketAccount = this.getSpotMarketAccountAndSlot(marketIndex);
		const oracle = this.spotOracleMap.get(marketIndex);
		const oracleId = this.spotOracleStringMap.get(marketIndex);
		if (!spotMarketAccount || !oracle) {
			return undefined;
		}

		if (!spotMarketAccount.data.oracle.equals(oracle)) {
			// If the oracle has changed, we need to update the oracle map in background
			this.setSpotOracleMap();
		}

		return this.getOraclePriceDataAndSlot(oracleId);
	}

	public updateAccountLoaderPollingFrequency(pollingFrequency: number): void {
		this.accountLoader.updatePollingFrequency(pollingFrequency);
	}
}
