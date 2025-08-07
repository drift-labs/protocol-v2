import {
	AccountSubscriber,
	DataAndSlot,
	DelistedMarketSetting,
	DriftClientAccountEvents,
	DriftClientAccountSubscriber,
	NotSubscribedError,
	ResubOpts,
} from './types';
import {
	isVariant,
	PerpMarketAccount,
	SpotMarketAccount,
	StateAccount,
} from '../types';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	getDriftStateAccountPublicKey,
	getPerpMarketPublicKeySync,
	getSpotMarketPublicKeySync,
} from '../addresses/pda';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { Context, PublicKey } from '@solana/web3.js';
import { Commitment } from 'gill';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { OracleClientCache } from '../oracles/oracleClientCache';
import { QUOTE_ORACLE_PRICE_DATA } from '../oracles/quoteAssetOracleClient';
import { findAllMarketAndOracles } from '../config';
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
import { WebSocketProgramAccountSubscriberV2 } from './webSocketProgramAccountSubscriberV2';
import { WebSocketAccountSubscriberV2 } from './webSocketAccountSubscriberV2';
const ORACLE_DEFAULT_ID = getOracleId(
	PublicKey.default,
	OracleSource.QUOTE_ASSET
);

export class WebSocketDriftClientAccountSubscriberV2
	implements DriftClientAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	commitment?: Commitment;
	perpMarketIndexes: number[];
	spotMarketIndexes: number[];
	oracleInfos: OracleInfo[];
	oracleClientCache = new OracleClientCache();

	resubOpts?: ResubOpts;
	shouldFindAllMarketsAndOracles: boolean;
	skipInitialData: boolean = true;

	eventEmitter: StrictEventEmitter<EventEmitter, DriftClientAccountEvents>;
	stateAccountSubscriber?: WebSocketAccountSubscriberV2<StateAccount>;
	perpMarketAllAccountsSubscriber: WebSocketProgramAccountSubscriberV2<PerpMarketAccount>;
	perpMarketAccountLatestData = new Map<
		number,
		DataAndSlot<PerpMarketAccount>
	>();
	spotMarketAllAccountsSubscriber: WebSocketProgramAccountSubscriberV2<SpotMarketAccount>;
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

	initialPerpMarketAccountData: Map<number, PerpMarketAccount>;
	initialSpotMarketAccountData: Map<number, SpotMarketAccount>;
	initialOraclePriceData: Map<string, OraclePriceData>;

	protected isSubscribing = false;
	protected subscriptionPromise: Promise<boolean>;
	protected subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(
		program: Program,
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
	}

	public async subscribe(): Promise<boolean> {
		const startTime = performance.now();
		console.log(
			`[PROFILING] WebSocketDriftClientAccountSubscriberV2.subscribe() started at ${new Date().toISOString()}`
		);

		if (this.isSubscribed) {
			console.log(
				`[PROFILING] WebSocketDriftClientAccountSubscriberV2.subscribe() skipped - already subscribed`
			);
			return true;
		}

		if (this.isSubscribing) {
			console.log(
				`[PROFILING] WebSocketDriftClientAccountSubscriberV2.subscribe() waiting for existing subscription`
			);
			return await this.subscriptionPromise;
		}

		this.isSubscribing = true;

		this.subscriptionPromise = new Promise((res) => {
			this.subscriptionPromiseResolver = res;
		});

		// Profile public key generation
		const pubkeyStartTime = performance.now();
		const perpMarketAccountPubkeys = this.perpMarketIndexes.map((marketIndex) =>
			getPerpMarketPublicKeySync(this.program.programId, marketIndex)
		);
		const spotMarketAccountPubkeys = this.spotMarketIndexes.map((marketIndex) =>
			getSpotMarketPublicKeySync(this.program.programId, marketIndex)
		);
		const pubkeyEndTime = performance.now();
		const pubkeyDuration = pubkeyEndTime - pubkeyStartTime;
		console.log(
			`[PROFILING] Public key generation completed in ${pubkeyDuration.toFixed(
				2
			)}ms (${perpMarketAccountPubkeys.length} perp markets, ${
				spotMarketAccountPubkeys.length
			} spot markets)`
		);

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
			findAllMarketsDuration = findAllMarketsEndTime - findAllMarketsStartTime;
			console.log(
				`[PROFILING] findAllMarketAndOracles completed in ${findAllMarketsDuration.toFixed(
					2
				)}ms (${perpMarketAccounts.length} perp markets, ${
					spotMarketAccounts.length
				} spot markets, ${oracleInfos.length} oracles)`
			);
		} else {
			console.log(
				`[PROFILING] findAllMarketAndOracles skipped (shouldFindAllMarketsAndOracles=false)`
			);
		}

		// Profile state public key generation
		const statePubkeyStartTime = performance.now();
		const statePublicKey = await getDriftStateAccountPublicKey(
			this.program.programId
		);
		const statePubkeyEndTime = performance.now();
		const statePubkeyDuration = statePubkeyEndTime - statePubkeyStartTime;
		console.log(
			`[PROFILING] State public key generation completed in ${statePubkeyDuration.toFixed(
				2
			)}ms`
		);

		// Profile parallel market and state subscriptions
		const parallelSubStartTime = performance.now();

		// Create subscribers
		this.perpMarketAllAccountsSubscriber =
			new WebSocketProgramAccountSubscriberV2<PerpMarketAccount>(
				'PerpMarketAccountsSubscriber',
				'PerpMarket',
				this.program,
				this.program.account.perpMarket.coder.accounts.decodeUnchecked.bind(
					this.program.account.perpMarket.coder.accounts
				),
				{
					filters: [getPerpMarketAccountsFilter()],
					commitment: this.commitment,
				},
				this.resubOpts,
				perpMarketAccountPubkeys // because we pass these in, it will monitor these accounts and fetch them right away
			);

		this.spotMarketAllAccountsSubscriber =
			new WebSocketProgramAccountSubscriberV2<SpotMarketAccount>(
				'SpotMarketAccountsSubscriber',
				'SpotMarket',
				this.program,
				this.program.account.spotMarket.coder.accounts.decodeUnchecked.bind(
					this.program.account.spotMarket.coder.accounts
				),
				{
					filters: [getSpotMarketAccountsFilter()],
					commitment: this.commitment,
				},
				this.resubOpts,
				spotMarketAccountPubkeys // because we pass these in, it will monitor these accounts and fetch them right away
			);

		this.stateAccountSubscriber = new WebSocketAccountSubscriberV2(
			'state',
			this.program,
			statePublicKey,
			undefined,
			undefined,
			this.commitment as Commitment
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
			this.stateAccountSubscriber.subscribe((data: StateAccount) => {
				this.eventEmitter.emit('stateAccountUpdate', data);
				this.eventEmitter.emit('update');
			}),
			(async () => {
				// Profile setInitialData
				const setInitialDataStartTime = performance.now();
				await this.setInitialData();
				const setInitialDataEndTime = performance.now();
				const setInitialDataDuration =
					setInitialDataEndTime - setInitialDataStartTime;
				console.log(
					`[PROFILING] setInitialData completed in ${setInitialDataDuration.toFixed(
						2
					)}ms`
				);
				// Profile subscribeToOracles
				const subscribeToOraclesStartTime = performance.now();
				await this.subscribeToOracles();
				const subscribeToOraclesEndTime = performance.now();
				const subscribeToOraclesDuration =
					subscribeToOraclesEndTime - subscribeToOraclesStartTime;
				console.log(
					`[PROFILING] subscribeToOracles completed in ${subscribeToOraclesDuration.toFixed(
						2
					)}ms`
				);
			})(),
		]);

		const parallelSubEndTime = performance.now();
		const parallelSubDuration = parallelSubEndTime - parallelSubStartTime;
		console.log(
			`[PROFILING] Parallel market and state subscriptions completed in ${parallelSubDuration.toFixed(
				2
			)}ms`
		);

		const initialPerpMarketDataFromLatestData = new Map(
			Array.from(this.perpMarketAccountLatestData.values()).map((data) => [
				data.data.marketIndex,
				data.data,
			])
		);
		const initialSpotMarketDataFromLatestData = new Map(
			Array.from(this.spotMarketAccountLatestData.values()).map((data) => [
				data.data.marketIndex,
				data.data,
			])
		);
		this.initialPerpMarketAccountData = initialPerpMarketDataFromLatestData;
		this.initialSpotMarketAccountData = initialSpotMarketDataFromLatestData;

		// // Profile setInitialData
		// const setInitialDataStartTime = performance.now();
		// await this.setInitialData();
		// const setInitialDataEndTime = performance.now();
		// const setInitialDataDuration =
		// 	setInitialDataEndTime - setInitialDataStartTime;
		// console.log(
		// 	`[PROFILING] setInitialData completed in ${setInitialDataDuration.toFixed(
		// 		2
		// 	)}ms`
		// );

		// // Profile subscribeToOracles
		// const subscribeToOraclesStartTime = performance.now();
		// await this.subscribeToOracles();
		// const subscribeToOraclesEndTime = performance.now();
		// const subscribeToOraclesDuration =
		// 	subscribeToOraclesEndTime - subscribeToOraclesStartTime;
		// console.log(
		// 	`[PROFILING] subscribeToOracles completed in ${subscribeToOraclesDuration.toFixed(
		// 		2
		// 	)}ms`
		// );

		this.eventEmitter.emit('update');

		// Profile handleDelistedMarketOracles
		const handleDelistedStartTime = performance.now();
		await this.handleDelistedMarketOracles();
		const handleDelistedEndTime = performance.now();
		const handleDelistedDuration =
			handleDelistedEndTime - handleDelistedStartTime;
		console.log(
			`[PROFILING] handleDelistedMarketOracles completed in ${handleDelistedDuration.toFixed(
				2
			)}ms`
		);

		// Profile oracle map setup
		const oracleMapStartTime = performance.now();
		await Promise.all([this.setPerpOracleMap(), this.setSpotOracleMap()]);
		const oracleMapEndTime = performance.now();
		const oracleMapDuration = oracleMapEndTime - oracleMapStartTime;
		console.log(
			`[PROFILING] Oracle map setup completed in ${oracleMapDuration.toFixed(
				2
			)}ms`
		);

		this.isSubscribing = false;
		this.isSubscribed = true;
		this.subscriptionPromiseResolver(true);

		// delete initial data
		this.removeInitialData();

		const totalDuration = performance.now() - startTime;
		console.log(
			`[PROFILING] WebSocketDriftClientAccountSubscriberV2.subscribe() completed in ${totalDuration.toFixed(
				2
			)}ms`
		);
		console.log(
			`[PROFILING] Breakdown: pubkeys=${pubkeyDuration.toFixed(
				2
			)}ms, findAllMarkets=${findAllMarketsDuration.toFixed(
				2
			)}ms, statePubkey=${statePubkeyDuration.toFixed(
				2
			)}ms, parallelSubscriptions=${parallelSubDuration.toFixed(
				2
				// )}ms, setInitialData=${setInitialDataDuration.toFixed(
				// 	2
				// )}ms, subscribeToOracles=${subscribeToOraclesDuration.toFixed(
				// 	2
			)}ms, handleDelisted=${handleDelistedDuration.toFixed(
				2
			)}ms, oracleMap=${oracleMapDuration.toFixed(2)}ms`
		);

		return true;
	}

	chunks = <T>(array: readonly T[], size: number): T[][] => {
		return new Array(Math.ceil(array.length / size))
			.fill(null)
			.map((_, index) => index * size)
			.map((begin) => array.slice(begin, begin + size));
	};

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
	async setInitialData(): Promise<void> {
		const startTime = performance.now();
		console.log(
			`[PROFILING] setInitialData() started at ${new Date().toISOString()}`
		);

		const connection = this.program.provider.connection;
		const currentSlot = await connection.getSlot();

		// Profile perp market initial data setup
		// let perpMarketSetupDuration = 0;
		// if (!this.initialPerpMarketAccountData) {
		// 	const perpMarketSetupStartTime = performance.now();
		// 	const perpMarketPublicKeys = this.perpMarketIndexes.map((marketIndex) =>
		// 		getPerpMarketPublicKeySync(this.program.programId, marketIndex)
		// 	);
		// 	const perpMarketPublicKeysChunks = this.chunks(perpMarketPublicKeys, 100);
		// 	const perpMarketAccountInfos = (
		// 		await Promise.all(
		// 			perpMarketPublicKeysChunks.map((perpMarketPublicKeysChunk) =>
		// 				connection.getMultipleAccountsInfo(perpMarketPublicKeysChunk)
		// 			)
		// 		)
		// 	).flat();
		// 	this.initialPerpMarketAccountData = new Map(
		// 		perpMarketAccountInfos
		// 			.filter((accountInfo) => !!accountInfo)
		// 			.map((accountInfo) => {
		// 				const perpMarket = this.program.coder.accounts.decode(
		// 					'PerpMarket',
		// 					accountInfo.data
		// 				);
		// 				return [perpMarket.marketIndex, perpMarket];
		// 			})
		// 	);
		// 	const perpMarketSetupEndTime = performance.now();
		// 	perpMarketSetupDuration =
		// 		perpMarketSetupEndTime - perpMarketSetupStartTime;
		// 	console.log(
		// 		`[PROFILING] Perp market initial data setup completed in ${perpMarketSetupDuration.toFixed(
		// 			2
		// 		)}ms (${this.initialPerpMarketAccountData.size} markets)`
		// 	);
		// } else {
		// 	console.log(
		// 		`[PROFILING] Perp market initial data skipped - already exists`
		// 	);
		// }

		// // emit initial perp market accounts data
		// Array.from(this.initialPerpMarketAccountData?.values() ?? []).forEach(
		// 	(perpMarketAccount) => {
		// 		this.eventEmitter.emit('perpMarketAccountUpdate', perpMarketAccount);
		// 		this.perpMarketAccountLatestData.set(perpMarketAccount.marketIndex, {
		// 			data: perpMarketAccount,
		// 			slot: currentSlot,
		// 		});
		// 	}
		// );
		// this.eventEmitter.emit('update');

		// // Profile spot market initial data setup
		// let spotMarketSetupDuration = 0;
		// if (!this.initialSpotMarketAccountData) {
		// 	const spotMarketSetupStartTime = performance.now();
		// 	const spotMarketPublicKeys = this.spotMarketIndexes.map((marketIndex) =>
		// 		getSpotMarketPublicKeySync(this.program.programId, marketIndex)
		// 	);
		// 	const spotMarketPublicKeysChunks = this.chunks(spotMarketPublicKeys, 100);
		// 	const spotMarketAccountInfos = (
		// 		await Promise.all(
		// 			spotMarketPublicKeysChunks.map((spotMarketPublicKeysChunk) =>
		// 				connection.getMultipleAccountsInfo(spotMarketPublicKeysChunk)
		// 			)
		// 		)
		// 	).flat();
		// 	this.initialSpotMarketAccountData = new Map(
		// 		spotMarketAccountInfos
		// 			.filter((accountInfo) => !!accountInfo)
		// 			.map((accountInfo) => {
		// 				const spotMarket = this.program.coder.accounts.decode(
		// 					'SpotMarket',
		// 					accountInfo.data
		// 				);
		// 				return [spotMarket.marketIndex, spotMarket];
		// 			})
		// 	);
		// 	const spotMarketSetupEndTime = performance.now();
		// 	spotMarketSetupDuration =
		// 		spotMarketSetupEndTime - spotMarketSetupStartTime;
		// 	console.log(
		// 		`[PROFILING] Spot market initial data setup completed in ${spotMarketSetupDuration.toFixed(
		// 			2
		// 		)}ms (${this.initialSpotMarketAccountData.size} markets)`
		// 	);
		// } else {
		// 	console.log(
		// 		`[PROFILING] Spot market initial data skipped - already exists`
		// 	);
		// }

		// // emit initial spot market accounts data
		// Array.from(this.initialSpotMarketAccountData?.values() ?? []).forEach(
		// 	(spotMarketAccount) => {
		// 		this.eventEmitter.emit('spotMarketAccountUpdate', spotMarketAccount);
		// 		this.spotMarketAccountLatestData.set(spotMarketAccount.marketIndex, {
		// 			data: spotMarketAccount,
		// 			slot: currentSlot,
		// 		});
		// 	}
		// );
		// this.eventEmitter.emit('update');

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
		const oracleSetupEndTime = performance.now();
		const oracleSetupDuration = oracleSetupEndTime - oracleSetupStartTime;
		console.log(
			`[PROFILING] Oracle initial data setup completed in ${oracleSetupDuration.toFixed(
				2
			)}ms (${this.initialOraclePriceData.size} oracles)`
		);

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

		// Profile state account fetch
		const stateFetchStartTime = performance.now();
		await this.stateAccountSubscriber.fetch();
		const stateFetchEndTime = performance.now();
		const stateFetchDuration = stateFetchEndTime - stateFetchStartTime;
		console.log(
			`[PROFILING] State account fetch completed in ${stateFetchDuration.toFixed(
				2
			)}ms`
		);

		const totalDuration = performance.now() - startTime;
		console.log(
			`[PROFILING] setInitialData() completed in ${totalDuration.toFixed(2)}ms`
		);
		// console.log(
		// 	`[PROFILING] setInitialData Breakdown: perpMarketSetup=${perpMarketSetupDuration.toFixed(
		// 		2
		// 	// )}ms, spotMarketSetup=${spotMarketSetupDuration.toFixed(
		// 	// 	2
		// 	// )}ms,
		// 	oracleSetup=${oracleSetupDuration.toFixed(
		// 		2
		// 	)}ms, stateFetch=${stateFetchDuration.toFixed(2)}ms
		// 	`
		// );
	}

	removeInitialData() {
		this.initialPerpMarketAccountData = new Map();
		this.initialSpotMarketAccountData = new Map();
		this.initialOraclePriceData = new Map();
	}

	async subscribeToOracles(): Promise<boolean> {
		const startTime = performance.now();
		console.log(
			`[PROFILING] subscribeToOracles() started at ${new Date().toISOString()}`
		);

		const validOracleInfos = this.oracleInfos.filter(
			(oracleInfo) => !oracleInfo.publicKey.equals(PublicKey.default)
		);
		console.log(
			`[PROFILING] Subscribing to ${validOracleInfos.length} oracles (filtered from ${this.oracleInfos.length} total)`
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

	async subscribeToOracle(oracleInfo: OracleInfo): Promise<boolean> {
		const startTime = performance.now();
		const oracleId = getOracleId(oracleInfo.publicKey, oracleInfo.source);
		// console.log(`[PROFILING] subscribeToOracle(${oracleInfo.publicKey.toString()}, ${oracleInfo.source}) started`);

		const client = this.oracleClientCache.get(
			oracleInfo.source,
			this.program.provider.connection,
			this.program
		);
		const accountSubscriber = new WebSocketAccountSubscriberV2<OraclePriceData>(
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

		this.oracleSubscribers.set(oracleId, accountSubscriber);

		const totalDuration = performance.now() - startTime;
		console.log(
			`[PROFILING] subscribeToOracle(${oracleInfo.publicKey.toString()}, ${
				oracleInfo.source
			}) completed in ${totalDuration.toFixed(2)}ms`
		);

		return true;
	}

	async unsubscribeFromMarketAccounts(): Promise<void> {
		await this.perpMarketAllAccountsSubscriber.unsubscribe();
	}

	async unsubscribeFromSpotMarketAccounts(): Promise<void> {
		await this.spotMarketAllAccountsSubscriber.unsubscribe();
	}

	async unsubscribeFromOracles(): Promise<void> {
		await Promise.all(
			Array.from(this.oracleSubscribers.values()).map((accountSubscriber) =>
				accountSubscriber.unsubscribe()
			)
		);
	}

	// public async fetch(): Promise<void> {
	// 	if (!this.isSubscribed) {
	// 		return;
	// 	}

	// 	const promises = [this.stateAccountSubscriber.fetch()]
	// 		const perpMarketAccountPubkeys = this.perpMarketIndexes.map((marketIndex) =>
	// 			getPerpMarketPublicKeySync(this.program.programId, marketIndex)
	// 		);
	// 		const perpMarketAccountPubkeysChunks = this.chunks(perpMarketAccountPubkeys, 100);
	// 		for(const perpMarketAccountPubkeysChunk of perpMarketAccountPubkeysChunks) {
	// 			const gmaCall = this.program.provider.connection.getMultipleAccountsInfo(perpMarketAccountPubkeysChunk);
	// 		}
	// 		const spotMarketAccountPubkeys = this.spotMarketIndexes.map((marketIndex) =>
	// 			getSpotMarketPublicKeySync(this.program.programId, marketIndex)
	// 		);
	// 		const oracleAccountPubkeys = this.oracleInfos.map((oracleInfo) => oracleInfo.publicKey);

	// 	await Promise.all(promises);
	// }

	public async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await this.stateAccountSubscriber.unsubscribe();

		await this.unsubscribeFromMarketAccounts();
		await this.unsubscribeFromSpotMarketAccounts();
		await this.unsubscribeFromOracles();

		this.isSubscribed = false;
	}

	// async addSpotMarket(marketIndex: number): Promise<boolean> {
	// 	if (this.spotMarketAccountSubscribers.has(marketIndex)) {
	// 		return true;
	// 	}
	// 	const subscriptionSuccess = this.subscribeToSpotMarketAccount(marketIndex);
	// 	await this.setSpotOracleMap();
	// 	return subscriptionSuccess;
	// }

	// async addPerpMarket(marketIndex: number): Promise<boolean> {
	// 	if (this.perpMarketAccountSubscribers.has(marketIndex)) {
	// 		return true;
	// 	}
	// 	const subscriptionSuccess = this.subscribeToPerpMarketAccount(marketIndex);
	// 	await this.setPerpOracleMap();
	// 	return subscriptionSuccess;
	// }

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

	async setPerpOracleMap() {
		const perpMarkets = this.getMarketAccountsAndSlots();
		const addOraclePromises = [];
		for (const perpMarket of perpMarkets) {
			if (!perpMarket || !perpMarket.data) {
				continue;
			}
			const perpMarketAccount = perpMarket.data;
			const perpMarketIndex = perpMarketAccount.marketIndex;
			const oracle = perpMarketAccount.amm.oracle;
			const oracleId = getOracleId(oracle, perpMarket.data.amm.oracleSource);
			if (!this.oracleSubscribers.has(oracleId)) {
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
			if (this.oracleSubscribers.has(oracleId)) {
				await this.oracleSubscribers.get(oracleId).unsubscribe();
				if (this.delistedMarketSetting === DelistedMarketSetting.Discard) {
					this.oracleSubscribers.delete(oracleId);
				}
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
		return this.stateAccountSubscriber.dataAndSlot;
	}

	public getMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<PerpMarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.perpMarketAccountLatestData.get(marketIndex);
	}

	public getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[] {
		return Array.from(this.perpMarketAccountLatestData.values());
	}

	public getSpotMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<SpotMarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.spotMarketAccountLatestData.get(marketIndex);
	}

	public getSpotMarketAccountsAndSlots(): DataAndSlot<SpotMarketAccount>[] {
		return Array.from(this.spotMarketAccountLatestData.values());
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
		return this.oracleSubscribers.get(oracleId).dataAndSlot;
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
}
