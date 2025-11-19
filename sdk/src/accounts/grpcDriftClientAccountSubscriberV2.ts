import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { findAllMarketAndOracles } from '../config';
import {
	getDriftStateAccountPublicKey,
	getPerpMarketPublicKey,
	getPerpMarketPublicKeySync,
	getSpotMarketPublicKey,
	getSpotMarketPublicKeySync,
} from '../addresses/pda';
import {
	AccountSubscriber,
	DataAndSlot,
	DelistedMarketSetting,
	DriftClientAccountEvents,
	DriftClientAccountSubscriber,
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

export class grpcDriftClientAccountSubscriberV2
	implements DriftClientAccountSubscriber
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
		DriftClientAccountEvents
	>;
	public isSubscribed: boolean;
	public isSubscribing: boolean;
	public program: Program;
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

	private subscriptionPromise: Promise<boolean>;
	protected subscriptionPromiseResolver: (val: boolean) => void;

	constructor(
		grpcConfigs: GrpcConfigs,
		program: Program,
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
					.filter((accountInfo) => !!accountInfo)
					.map((accountInfo) => {
						const perpMarket = this.program.coder.accounts.decode(
							'PerpMarket',
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
					.filter((accountInfo) => !!accountInfo)
					.map((accountInfo) => {
						const spotMarket = this.program.coder.accounts.decode(
							'SpotMarket',
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
			this.oracleInfos.reduce((result, oracleInfo, i) => {
				if (!oracleAccountInfos[i]) {
					return result;
				}
				const oracleClient = this.oracleClientCache.get(
					oracleInfo.source,
					connection,
					this.program
				);
				const oraclePriceData = oracleClient.getOraclePriceDataFromBuffer(
					oracleAccountInfos[i].data
				);
				result.push([
					getOracleId(oracleInfo.publicKey, oracleInfo.source),
					oraclePriceData,
				]);
				return result;
			}, [])
		);
	}

	async addPerpMarket(_marketIndex: number): Promise<boolean> {
		if (!this.perpMarketIndexes.includes(_marketIndex)) {
			this.perpMarketIndexes = this.perpMarketIndexes.concat(_marketIndex);
		}
		return true;
	}

	async addSpotMarket(_marketIndex: number): Promise<boolean> {
		return true;
	}

	async addOracle(oracleInfo: OracleInfo): Promise<boolean> {
		if (this.resubOpts?.logResubMessages) {
			console.log('[grpcDriftClientAccountSubscriberV2] addOracle');
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
		this.oracleMultiSubscriber?.addAccounts([oracleInfo.publicKey]);

		return true;
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

		const statePublicKey = await getDriftStateAccountPublicKey(
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

	public async fetch(): Promise<void> {
		await this.stateAccountSubscriber?.fetch();
		await this.perpMarketsSubscriber?.fetch();
		await this.spotMarketsSubscriber?.fetch();
		await this.oracleMultiSubscriber?.fetch();
	}

	private assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getStateAccountAndSlot(): DataAndSlot<StateAccount> {
		this.assertIsSubscribed();
		return this.stateAccountSubscriber.dataAndSlot;
	}

	public getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[] {
		const map = this.perpMarketsSubscriber?.getAccountDataMap();
		return Array.from(map?.values() ?? []);
	}

	public getSpotMarketAccountsAndSlots(): DataAndSlot<SpotMarketAccount>[] {
		const map = this.spotMarketsSubscriber?.getAccountDataMap();
		return Array.from(map?.values() ?? []);
	}

	getMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<PerpMarketAccount> | undefined {
		return this.perpMarketsSubscriber?.getAccountData(
			this.perpMarketIndexToAccountPubkeyMap.get(marketIndex)
		);
	}

	getSpotMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<SpotMarketAccount> | undefined {
		return this.spotMarketsSubscriber?.getAccountData(
			this.spotMarketIndexToAccountPubkeyMap.get(marketIndex)
		);
	}

	public getOraclePriceDataAndSlot(
		oracleId: string
	): DataAndSlot<OraclePriceData> | undefined {
		this.assertIsSubscribed();
		// we need to rely on a map we store in this class because the grpcMultiAccountSubscriber does not track a mapping or oracle ID.
		// DO NOT call getAccountData on the oracleMultiSubscriber, it will not return the correct data in certain cases(BONK spot and perp market subscribed too at once).
		return this.oracleIdToOracleDataMap.get(oracleId);
	}

	public getOraclePriceDataAndSlotForPerpMarket(
		marketIndex: number
	): DataAndSlot<OraclePriceData> | undefined {
		const perpMarketAccount = this.getMarketAccountAndSlot(marketIndex);
		const oracle = this.perpOracleMap.get(marketIndex);
		const oracleId = this.perpOracleStringMap.get(marketIndex);
		if (!perpMarketAccount || !oracleId) {
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
		if (!spotMarketAccount || !oracleId) {
			return undefined;
		}

		if (!spotMarketAccount.data.oracle.equals(oracle)) {
			// If the oracle has changed, we need to update the oracle map in background
			this.setSpotOracleMap();
		}

		return this.getOraclePriceDataAndSlot(oracleId);
	}

	async setPerpOracleMap() {
		const perpMarketsMap = this.perpMarketsSubscriber?.getAccountDataMap();
		const perpMarkets = Array.from(perpMarketsMap.values());
		const addOraclePromises = [];
		for (const perpMarket of perpMarkets) {
			if (!perpMarket || !perpMarket.data) {
				continue;
			}
			const perpMarketAccount = perpMarket.data;
			const perpMarketIndex = perpMarketAccount.marketIndex;
			const oracle = perpMarketAccount.amm.oracle;
			const oracleId = getOracleId(oracle, perpMarket.data.amm.oracleSource);
			if (!this.oracleMultiSubscriber?.getAccountDataMap().has(oracleId)) {
				addOraclePromises.push(
					this.addOracle({
						publicKey: oracle,
						source: perpMarket.data.amm.oracleSource,
					})
				);
			}
			this.perpOracleMap.set(perpMarketIndex, oracle);
			this.perpOracleStringMap.set(perpMarketIndex, oracleId);
		}
		await Promise.all(addOraclePromises);
	}

	async setSpotOracleMap() {
		const spotMarketsMap = this.spotMarketsSubscriber?.getAccountDataMap();
		const spotMarkets = Array.from(spotMarketsMap.values());
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

	async subscribeToPerpMarketAccounts(): Promise<boolean> {
		if (this.resubOpts?.logResubMessages) {
			console.log(
				'[grpcDriftClientAccountSubscriberV2] subscribeToPerpMarketAccounts'
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
								'[grpcDriftClientAccountSubscriberV2] perp markets subscriber unsubscribed; resubscribing'
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

	async subscribeToSpotMarketAccounts(): Promise<boolean> {
		if (this.resubOpts?.logResubMessages) {
			console.log(
				'[grpcDriftClientAccountSubscriberV2] subscribeToSpotMarketAccounts'
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
								'[grpcDriftClientAccountSubscriberV2] spot markets subscriber unsubscribed; resubscribing'
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

	async subscribeToOracles(): Promise<boolean> {
		if (this.resubOpts?.logResubMessages) {
			console.log('grpcDriftClientAccountSubscriberV2 subscribeToOracles');
		}
		const oraclePubkeyToInfosMap = new Map<string, OracleInfo[]>();
		for (const info of this.oracleInfos) {
			const pubkey = info.publicKey.toBase58();
			if (!oraclePubkeyToInfosMap.has(pubkey)) {
				oraclePubkeyToInfosMap.set(pubkey, []);
			}
			oraclePubkeyToInfosMap.get(pubkey).push(info);
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

				const client = this.oracleClientCache.get(
					accountProps.source,
					this.program.provider.connection,
					this.program
				);
				const price = client.getOraclePriceDataFromBuffer(buffer);
				return price;
			},
			this.resubOpts,
			undefined,
			async () => {
				try {
					if (this.resubOpts?.logResubMessages) {
						console.log(
							'[grpcDriftClientAccountSubscriberV2] oracle subscriber unsubscribed; resubscribing'
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
			.filter((pubkey) => pubkey !== null) as PublicKey[];

		// Build array of oracle pubkeys to remove
		const oraclePubkeysToRemove = oracles.map((oracle) => oracle.publicKey);

		// Remove accounts in batches - perp markets
		if (perpMarketPubkeysToRemove.length > 0) {
			await this.perpMarketsSubscriber.removeAccounts(
				perpMarketPubkeysToRemove
			);
		}

		// Remove accounts in batches - oracles
		if (oraclePubkeysToRemove.length > 0) {
			await this.oracleMultiSubscriber.removeAccounts(oraclePubkeysToRemove);
		}
	}

	removeInitialData() {
		this.initialPerpMarketAccountData = new Map();
		this.initialSpotMarketAccountData = new Map();
		this.initialOraclePriceData = new Map();
	}

	async unsubscribeFromOracles(): Promise<void> {
		if (this.oracleMultiSubscriber) {
			await this.oracleMultiSubscriber.unsubscribe();
			this.oracleMultiSubscriber = undefined;
			return;
		}
	}

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
