import {
	DriftClientAccountSubscriber,
	DriftClientAccountEvents,
	DataAndSlot,
	ResubOpts,
} from './types';
import { AccountSubscriber, NotSubscribedError } from './types';
import { SpotMarketAccount, PerpMarketAccount, StateAccount } from '../types';
import { Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	getDriftStateAccountPublicKey,
	getSpotMarketPublicKey,
	getPerpMarketPublicKey,
} from '../addresses/pda';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { Commitment, PublicKey } from '@solana/web3.js';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { OracleClientCache } from '../oracles/oracleClientCache';
import * as Buffer from 'buffer';
import { QUOTE_ORACLE_PRICE_DATA } from '../oracles/quoteAssetOracleClient';
import { findAllMarketAndOracles } from '../config';

export class WebSocketDriftClientAccountSubscriber
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

	eventEmitter: StrictEventEmitter<EventEmitter, DriftClientAccountEvents>;
	stateAccountSubscriber?: AccountSubscriber<StateAccount>;
	perpMarketAccountSubscribers = new Map<
		number,
		AccountSubscriber<PerpMarketAccount>
	>();
	perpOracleMap = new Map<number, PublicKey>();
	spotMarketAccountSubscribers = new Map<
		number,
		AccountSubscriber<SpotMarketAccount>
	>();
	spotOracleMap = new Map<number, PublicKey>();
	oracleSubscribers = new Map<string, AccountSubscriber<OraclePriceData>>();

	private isSubscribing = false;
	private subscriptionPromise: Promise<boolean>;
	private subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(
		program: Program,
		perpMarketIndexes: number[],
		spotMarketIndexes: number[],
		oracleInfos: OracleInfo[],
		shouldFindAllMarketsAndOracles: boolean,
		resubOpts?: ResubOpts,
		commitment?: Commitment
	) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.perpMarketIndexes = perpMarketIndexes;
		this.spotMarketIndexes = spotMarketIndexes;
		this.oracleInfos = oracleInfos;
		this.shouldFindAllMarketsAndOracles = shouldFindAllMarketsAndOracles;
		this.resubOpts = resubOpts;
		this.commitment = commitment;
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

		const statePublicKey = await getDriftStateAccountPublicKey(
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

		// subscribe to market accounts
		await this.subscribeToPerpMarketAccounts();

		// subscribe to spot market accounts
		await this.subscribeToSpotMarketAccounts();

		// subscribe to oracles
		await this.subscribeToOracles();

		this.eventEmitter.emit('update');

		await this.setPerpOracleMap();
		await this.setSpotOracleMap();

		this.isSubscribing = false;
		this.isSubscribed = true;
		this.subscriptionPromiseResolver(true);

		return true;
	}

	async subscribeToPerpMarketAccounts(): Promise<boolean> {
		for (const marketIndex of this.perpMarketIndexes) {
			await this.subscribeToPerpMarketAccount(marketIndex);
		}
		return true;
	}

	async subscribeToPerpMarketAccount(marketIndex: number): Promise<boolean> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			marketIndex
		);
		const accountSubscriber = new WebSocketAccountSubscriber<PerpMarketAccount>(
			'perpMarket',
			this.program,
			perpMarketPublicKey,
			undefined,
			this.resubOpts,
			this.commitment
		);
		await accountSubscriber.subscribe((data: PerpMarketAccount) => {
			this.eventEmitter.emit('perpMarketAccountUpdate', data);
			this.eventEmitter.emit('update');
		});
		this.perpMarketAccountSubscribers.set(marketIndex, accountSubscriber);
		return true;
	}

	async subscribeToSpotMarketAccounts(): Promise<boolean> {
		for (const marketIndex of this.spotMarketIndexes) {
			await this.subscribeToSpotMarketAccount(marketIndex);
		}
		return true;
	}

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
		await accountSubscriber.subscribe((data: SpotMarketAccount) => {
			this.eventEmitter.emit('spotMarketAccountUpdate', data);
			this.eventEmitter.emit('update');
		});
		this.spotMarketAccountSubscribers.set(marketIndex, accountSubscriber);
		return true;
	}

	async subscribeToOracles(): Promise<boolean> {
		for (const oracleInfo of this.oracleInfos) {
			if (!oracleInfo.publicKey.equals(PublicKey.default)) {
				await this.subscribeToOracle(oracleInfo);
			}
		}

		return true;
	}

	async subscribeToOracle(oracleInfo: OracleInfo): Promise<boolean> {
		const client = this.oracleClientCache.get(
			oracleInfo.source,
			this.program.provider.connection,
			this.program
		);
		const accountSubscriber = new WebSocketAccountSubscriber<OraclePriceData>(
			'oracle',
			this.program,
			oracleInfo.publicKey,
			(buffer: Buffer) => {
				return client.getOraclePriceDataFromBuffer(buffer);
			},
			this.resubOpts,
			this.commitment
		);

		await accountSubscriber.subscribe((data: OraclePriceData) => {
			this.eventEmitter.emit('oraclePriceUpdate', oracleInfo.publicKey, data);
			this.eventEmitter.emit('update');
		});

		this.oracleSubscribers.set(
			oracleInfo.publicKey.toString(),
			accountSubscriber
		);
		return true;
	}

	async unsubscribeFromMarketAccounts(): Promise<void> {
		for (const accountSubscriber of this.perpMarketAccountSubscribers.values()) {
			await accountSubscriber.unsubscribe();
		}
	}

	async unsubscribeFromSpotMarketAccounts(): Promise<void> {
		for (const accountSubscriber of this.spotMarketAccountSubscribers.values()) {
			await accountSubscriber.unsubscribe();
		}
	}

	async unsubscribeFromOracles(): Promise<void> {
		for (const accountSubscriber of this.oracleSubscribers.values()) {
			await accountSubscriber.unsubscribe();
		}
	}

	public async fetch(): Promise<void> {
		if (!this.isSubscribed) {
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

	async addSpotMarket(marketIndex: number): Promise<boolean> {
		if (this.spotMarketAccountSubscribers.has(marketIndex)) {
			return true;
		}
		const subscriptionSuccess = this.subscribeToSpotMarketAccount(marketIndex);
		await this.setSpotOracleMap();
		return subscriptionSuccess;
	}

	async addPerpMarket(marketIndex: number): Promise<boolean> {
		if (this.perpMarketAccountSubscribers.has(marketIndex)) {
			return true;
		}
		const subscriptionSuccess = this.subscribeToPerpMarketAccount(marketIndex);
		await this.setPerpOracleMap();
		return subscriptionSuccess;
	}

	async addOracle(oracleInfo: OracleInfo): Promise<boolean> {
		if (this.oracleSubscribers.has(oracleInfo.publicKey.toString())) {
			return true;
		}

		if (oracleInfo.publicKey.equals(PublicKey.default)) {
			return true;
		}

		return this.subscribeToOracle(oracleInfo);
	}

	async setPerpOracleMap() {
		console.log("\n\n\n\n\n updating oracles \n\n\n\n");
		const perpMarkets = this.getMarketAccountsAndSlots();
		for (const perpMarket of perpMarkets) {
			if (!perpMarket) {
				continue;
			}
			const perpMarketAccount = perpMarket.data;
			const perpMarketIndex = perpMarketAccount.marketIndex;
			const oracle = perpMarketAccount.amm.oracle;
			if (!this.oracleSubscribers.has(oracle.toBase58())) {
				await this.addOracle({
					publicKey: oracle,
					source: perpMarket.data.amm.oracleSource,
				});
			}
			this.perpOracleMap.set(perpMarketIndex, oracle);
		}
	}

	async setSpotOracleMap() {
		const spotMarkets = this.getSpotMarketAccountsAndSlots();
		for (const spotMarket of spotMarkets) {
			if (!spotMarket) {
				continue;
			}
			const spotMarketAccount = spotMarket.data;
			const spotMarketIndex = spotMarketAccount.marketIndex;
			const oracle = spotMarketAccount.oracle;
			if (!this.oracleSubscribers.has(oracle.toBase58())) {
				await this.addOracle({
					publicKey: oracle,
					source: spotMarketAccount.oracleSource,
				});
			}
			this.spotOracleMap.set(spotMarketIndex, oracle);
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
		return this.perpMarketAccountSubscribers.get(marketIndex).dataAndSlot;
	}

	public getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[] {
		return Array.from(this.perpMarketAccountSubscribers.values()).map(
			(subscriber) => subscriber.dataAndSlot
		);
	}

	public getSpotMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<SpotMarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.spotMarketAccountSubscribers.get(marketIndex).dataAndSlot;
	}

	public getSpotMarketAccountsAndSlots(): DataAndSlot<SpotMarketAccount>[] {
		return Array.from(this.spotMarketAccountSubscribers.values()).map(
			(subscriber) => subscriber.dataAndSlot
		);
	}

	public getOraclePriceDataAndSlot(
		oraclePublicKey: PublicKey
	): DataAndSlot<OraclePriceData> | undefined {
		this.assertIsSubscribed();
		if (oraclePublicKey.equals(PublicKey.default)) {
			return {
				data: QUOTE_ORACLE_PRICE_DATA,
				slot: 0,
			};
		}
		return this.oracleSubscribers.get(oraclePublicKey.toString()).dataAndSlot;
	}

	public getOraclePriceDataAndSlotForPerpMarket(
		marketIndex: number
	): DataAndSlot<OraclePriceData> | undefined {
		const perpMarketAccount = this.getMarketAccountAndSlot(marketIndex);
		const oracle = this.perpOracleMap.get(marketIndex);
		if (!perpMarketAccount || !oracle) {
			return undefined;
		}

		if (!perpMarketAccount.data.amm.oracle.equals(oracle)) {
			// If the oracle has changed, we need to update the oracle map in background
			this.setPerpOracleMap();
		}

		return this.getOraclePriceDataAndSlot(oracle);
	}

	public getOraclePriceDataAndSlotForSpotMarket(
		marketIndex: number
	): DataAndSlot<OraclePriceData> | undefined {
		const spotMarketAccount = this.getSpotMarketAccountAndSlot(marketIndex);
		const oracle = this.spotOracleMap.get(marketIndex);
		if (!spotMarketAccount || !oracle) {
			return undefined;
		}

		if (!spotMarketAccount.data.oracle.equals(oracle)) {
			// If the oracle has changed, we need to update the oracle map in background
			this.setSpotOracleMap();
		}

		return this.getOraclePriceDataAndSlot(oracle);
	}
}
