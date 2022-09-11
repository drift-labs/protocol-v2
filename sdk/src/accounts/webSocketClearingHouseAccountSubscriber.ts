import {
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
	DataAndSlot,
} from './types';
import { AccountSubscriber, NotSubscribedError } from './types';
import { SpotMarketAccount, PerpMarketAccount, StateAccount } from '../types';
import { BN, Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	getClearingHouseStateAccountPublicKey,
	getSpotMarketPublicKey,
	getMarketPublicKey,
} from '../addresses/pda';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { PublicKey } from '@solana/web3.js';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { OracleClientCache } from '../oracles/oracleClientCache';
import * as Buffer from 'buffer';
import { QUOTE_ORACLE_PRICE_DATA } from '../oracles/quoteAssetOracleClient';

export class WebSocketClearingHouseAccountSubscriber
	implements ClearingHouseAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	perpMarketIndexes: BN[];
	spotMarketIndexes: BN[];
	oracleInfos: OracleInfo[];
	oracleClientCache = new OracleClientCache();

	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	stateAccountSubscriber?: AccountSubscriber<StateAccount>;
	perpMarketAccountSubscribers = new Map<
		number,
		AccountSubscriber<PerpMarketAccount>
	>();
	spotMarketAccountSubscribers = new Map<
		number,
		AccountSubscriber<SpotMarketAccount>
	>();
	oracleSubscribers = new Map<string, AccountSubscriber<OraclePriceData>>();

	private isSubscribing = false;
	private subscriptionPromise: Promise<boolean>;
	private subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(
		program: Program,
		perpMarketIndexes: BN[],
		spotMarketIndexes: BN[],
		oracleInfos: OracleInfo[]
	) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.perpMarketIndexes = perpMarketIndexes;
		this.spotMarketIndexes = spotMarketIndexes;
		this.oracleInfos = oracleInfos;
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

		const statePublicKey = await getClearingHouseStateAccountPublicKey(
			this.program.programId
		);

		// create and activate main state account subscription
		this.stateAccountSubscriber = new WebSocketAccountSubscriber(
			'state',
			this.program,
			statePublicKey
		);
		await this.stateAccountSubscriber.subscribe((data: StateAccount) => {
			this.eventEmitter.emit('stateAccountUpdate', data);
			this.eventEmitter.emit('update');
		});

		// subscribe to market accounts
		await this.subscribeToMarketAccounts();

		// subscribe to spot market accounts
		await this.subscribeToSpotMarketAccounts();

		// subscribe to oracles
		await this.subscribeToOracles();

		this.eventEmitter.emit('update');

		this.isSubscribing = false;
		this.isSubscribed = true;
		this.subscriptionPromiseResolver(true);

		return true;
	}

	async subscribeToMarketAccounts(): Promise<boolean> {
		for (const marketIndex of this.perpMarketIndexes) {
			await this.subscribeToMarketAccount(marketIndex);
		}
		return true;
	}

	async subscribeToMarketAccount(marketIndex: BN): Promise<boolean> {
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);
		const accountSubscriber = new WebSocketAccountSubscriber<PerpMarketAccount>(
			'perpMarket',
			this.program,
			marketPublicKey
		);
		await accountSubscriber.subscribe((data: PerpMarketAccount) => {
			this.eventEmitter.emit('perpMarketAccountUpdate', data);
			this.eventEmitter.emit('update');
		});
		this.perpMarketAccountSubscribers.set(
			marketIndex.toNumber(),
			accountSubscriber
		);
		return true;
	}

	async subscribeToSpotMarketAccounts(): Promise<boolean> {
		for (const marketIndex of this.spotMarketIndexes) {
			await this.subscribeToSpotMarketAccount(marketIndex);
		}
		return true;
	}

	async subscribeToSpotMarketAccount(marketIndex: BN): Promise<boolean> {
		const marketPublicKey = await getSpotMarketPublicKey(
			this.program.programId,
			marketIndex
		);
		const accountSubscriber = new WebSocketAccountSubscriber<SpotMarketAccount>(
			'spotMarket',
			this.program,
			marketPublicKey
		);
		await accountSubscriber.subscribe((data: SpotMarketAccount) => {
			this.eventEmitter.emit('spotMarketAccountUpdate', data);
			this.eventEmitter.emit('update');
		});
		this.spotMarketAccountSubscribers.set(
			marketIndex.toNumber(),
			accountSubscriber
		);
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
			this.program.provider.connection
		);
		const accountSubscriber = new WebSocketAccountSubscriber<OraclePriceData>(
			'oracle',
			this.program,
			oracleInfo.publicKey,
			(buffer: Buffer) => {
				return client.getOraclePriceDataFromBuffer(buffer);
			}
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

	async addSpotMarket(marketIndex: BN): Promise<boolean> {
		if (this.spotMarketAccountSubscribers.has(marketIndex.toNumber())) {
			return true;
		}
		return this.subscribeToSpotMarketAccount(marketIndex);
	}

	async addPerpMarket(marketIndex: BN): Promise<boolean> {
		if (this.perpMarketAccountSubscribers.has(marketIndex.toNumber())) {
			return true;
		}
		return this.subscribeToMarketAccount(marketIndex);
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
		marketIndex: BN
	): DataAndSlot<PerpMarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.perpMarketAccountSubscribers.get(marketIndex.toNumber())
			.dataAndSlot;
	}

	public getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[] {
		return Array.from(this.perpMarketAccountSubscribers.values()).map(
			(subscriber) => subscriber.dataAndSlot
		);
	}

	public getSpotMarketAccountAndSlot(
		marketIndex: BN
	): DataAndSlot<SpotMarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.spotMarketAccountSubscribers.get(marketIndex.toNumber())
			.dataAndSlot;
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
}
