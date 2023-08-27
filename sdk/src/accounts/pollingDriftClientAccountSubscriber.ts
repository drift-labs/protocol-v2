import {
	DataAndSlot,
	AccountToPoll,
	DriftClientAccountEvents,
	DriftClientAccountSubscriber,
	NotSubscribedError,
	OraclesToPoll,
} from './types';
import { BorshAccountsCoder, Program } from '@coral-xyz/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	SpotMarketAccount,
	PerpMarketAccount,
	StateAccount,
	UserAccount,
} from '../types';
import {
	getDriftStateAccountPublicKey,
	getSpotMarketPublicKey,
	getPerpMarketPublicKey,
} from '../addresses/pda';
import { BulkAccountLoader } from './bulkAccountLoader';
import { capitalize } from './utils';
import { PublicKey } from '@solana/web3.js';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { OracleClientCache } from '../oracles/oracleClientCache';
import { QUOTE_ORACLE_PRICE_DATA } from '../oracles/quoteAssetOracleClient';
import { findAllMarketAndOracles } from '../config';

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
	spotMarket = new Map<number, DataAndSlot<SpotMarketAccount>>();
	oracles = new Map<string, DataAndSlot<OraclePriceData>>();
	user?: DataAndSlot<UserAccount>;

	private isSubscribing = false;
	private subscriptionPromise: Promise<boolean>;
	private subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(
		program: Program,
		accountLoader: BulkAccountLoader,
		perpMarketIndexes: number[],
		spotMarketIndexes: number[],
		oracleInfos: OracleInfo[],
		shouldFindAllMarketsAndOracles: boolean
	) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.accountLoader = accountLoader;
		this.perpMarketIndexes = perpMarketIndexes;
		this.spotMarketIndexes = spotMarketIndexes;
		this.oracleInfos = oracleInfos;
		this.shouldFindAllMarketsAndOracles = shouldFindAllMarketsAndOracles;
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
		await this.updateOraclesToPoll();
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

		await this.updatePerpMarketAccountsToPoll();
		await this.updateSpotMarketAccountsToPoll();
	}

	async updatePerpMarketAccountsToPoll(): Promise<boolean> {
		for (const marketIndex of this.perpMarketIndexes) {
			await this.addPerpMarketAccountToPoll(marketIndex);
		}
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
		for (const marketIndex of this.spotMarketIndexes) {
			await this.addSpotMarketAccountToPoll(marketIndex);
		}

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
		this.oraclesToPoll.set(oracleInfo.publicKey.toString(), {
			publicKey: oracleInfo.publicKey,
			source: oracleInfo.source,
		});

		return true;
	}

	async addToAccountLoader(): Promise<void> {
		for (const [_, accountToPoll] of this.accountsToPoll) {
			await this.addAccountToAccountLoader(accountToPoll);
		}

		for (const [_, oracleToPoll] of this.oraclesToPoll) {
			await this.addOracleToAccountLoader(oracleToPoll);
		}

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	async addAccountToAccountLoader(accountToPoll: AccountToPoll): Promise<void> {
		accountToPoll.callbackId = await this.accountLoader.addAccount(
			accountToPoll.publicKey,
			(buffer: Buffer, slot: number) => {
				if (!buffer) return;

				console.log('account name', capitalize(accountToPoll.key));
				console.log(
					'discriminator',
					BorshAccountsCoder.accountDiscriminator(
						capitalize(accountToPoll.key)
					).toString('base64')
				);
				const account = this.program.account[
					accountToPoll.key
				].coder.accounts.decode(capitalize(accountToPoll.key), buffer);
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
			this.program.provider.connection
		);

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

				this.oracles.set(oracleToPoll.publicKey.toString(), dataAndSlot);

				this.eventEmitter.emit(
					'oraclePriceUpdate',
					oracleToPoll.publicKey,
					oraclePriceData
				);
				this.eventEmitter.emit('update');
			}
		);
	}

	public async fetch(): Promise<void> {
		await this.accountLoader.load();
		for (const [_, accountToPoll] of this.accountsToPoll) {
			const { buffer, slot } = this.accountLoader.getBufferAndSlot(
				accountToPoll.publicKey
			);
			if (buffer) {
				const account = this.program.account[
					accountToPoll.key
				].coder.accounts.decode(capitalize(accountToPoll.key), buffer);

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
			const { buffer, slot } = this.accountLoader.getBufferAndSlot(
				oracleToPoll.publicKey
			);
			if (buffer) {
				const oracleClient = this.oracleClientCache.get(
					oracleToPoll.source,
					this.program.provider.connection
				);
				const oraclePriceData =
					oracleClient.getOraclePriceDataFromBuffer(buffer);
				this.oracles.set(oracleToPoll.publicKey.toString(), {
					data: oraclePriceData,
					slot,
				});
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
		return true;
	}

	async addOracle(oracleInfo: OracleInfo): Promise<boolean> {
		if (
			oracleInfo.publicKey.equals(PublicKey.default) ||
			this.oraclesToPoll.has(oracleInfo.publicKey.toString())
		) {
			return true;
		}

		this.addOracleToPoll(oracleInfo);
		const oracleToPoll = this.oraclesToPoll.get(
			oracleInfo.publicKey.toString()
		);
		await this.addOracleToAccountLoader(oracleToPoll);
		return true;
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
		oraclePublicKey: PublicKey
	): DataAndSlot<OraclePriceData> | undefined {
		this.assertIsSubscribed();
		if (oraclePublicKey.equals(PublicKey.default)) {
			return {
				data: QUOTE_ORACLE_PRICE_DATA,
				slot: 0,
			};
		}

		return this.oracles.get(oraclePublicKey.toString());
	}

	public updateAccountLoaderPollingFrequency(pollingFrequency: number): void {
		this.accountLoader.updatePollingFrequency(pollingFrequency);
	}
}
