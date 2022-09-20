import {
	DataAndSlot,
	AccountToPoll,
	ClearingHouseAccountEvents,
	ClearingHouseAccountSubscriber,
	NotSubscribedError,
	OraclesToPoll,
} from './types';
import { BN, Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	SpotMarketAccount,
	PerpMarketAccount,
	StateAccount,
	UserAccount,
} from '../types';
import {
	getClearingHouseStateAccountPublicKey,
	getSpotMarketPublicKey,
	getMarketPublicKey,
} from '../addresses/pda';
import { BulkAccountLoader } from './bulkAccountLoader';
import { capitalize } from './utils';
import { PublicKey } from '@solana/web3.js';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { OracleClientCache } from '../oracles/oracleClientCache';
import { QUOTE_ORACLE_PRICE_DATA } from '../oracles/quoteAssetOracleClient';

export class PollingClearingHouseAccountSubscriber
	implements ClearingHouseAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	perpMarketIndexes: BN[];
	spotMarketIndexes: BN[];
	oracleInfos: OracleInfo[];
	oracleClientCache = new OracleClientCache();

	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;

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
		perpMarketIndexes: BN[],
		spotMarketIndexes: BN[],
		oracleInfos: OracleInfo[]
	) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.accountLoader = accountLoader;
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

		const accounts = await this.getClearingHouseAccounts();

		this.accountsToPoll.set(accounts.state.toString(), {
			key: 'state',
			publicKey: accounts.state,
			eventType: 'stateAccountUpdate',
		});

		await this.updateMarketAccountsToPoll();
		await this.updateSpotMarketAccountsToPoll();
	}

	async updateMarketAccountsToPoll(): Promise<boolean> {
		for (const marketIndex of this.perpMarketIndexes) {
			await this.addMarketAccountToPoll(marketIndex);
		}
		return true;
	}

	async addMarketAccountToPoll(marketIndex: BN): Promise<boolean> {
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		this.accountsToPoll.set(marketPublicKey.toString(), {
			key: 'perpMarket',
			publicKey: marketPublicKey,
			eventType: 'perpMarketAccountUpdate',
			mapKey: marketIndex.toNumber(),
		});

		return true;
	}

	async updateSpotMarketAccountsToPoll(): Promise<boolean> {
		for (const marketIndex of this.spotMarketIndexes) {
			await this.addSpotMarketAccountToPoll(marketIndex);
		}

		return true;
	}

	async addSpotMarketAccountToPoll(marketIndex: BN): Promise<boolean> {
		const marketPublicKey = await getSpotMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		this.accountsToPoll.set(marketPublicKey.toString(), {
			key: 'spotMarket',
			publicKey: marketPublicKey,
			eventType: 'spotMarketAccountUpdate',
			mapKey: marketIndex.toNumber(),
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

	async getClearingHouseAccounts(): Promise<ClearingHouseAccounts> {
		const statePublicKey = await getClearingHouseStateAccountPublicKey(
			this.program.programId
		);

		const accounts = {
			state: statePublicKey,
		};

		return accounts;
	}

	async addToAccountLoader(): Promise<void> {
		for (const [_, accountToPoll] of this.accountsToPoll) {
			this.addAccountToAccountLoader(accountToPoll);
		}

		for (const [_, oracleToPoll] of this.oraclesToPoll) {
			this.addOracleToAccountLoader(oracleToPoll);
		}

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	addAccountToAccountLoader(accountToPoll: AccountToPoll): void {
		accountToPoll.callbackId = this.accountLoader.addAccount(
			accountToPoll.publicKey,
			(buffer: Buffer, slot: number) => {
				if (!buffer) return;

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

	addOracleToAccountLoader(oracleToPoll: OraclesToPoll): void {
		const oracleClient = this.oracleClientCache.get(
			oracleToPoll.source,
			this.program.provider.connection
		);

		oracleToPoll.callbackId = this.accountLoader.addAccount(
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
		if (!this.isSubscribed) {
			return;
		}

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

	async addSpotMarket(marketIndex: BN): Promise<boolean> {
		await this.addSpotMarketAccountToPoll(marketIndex);
		const accountToPoll = this.accountsToPoll.get(marketIndex.toString());
		this.addAccountToAccountLoader(accountToPoll);
		return true;
	}

	async addPerpMarket(marketIndex: BN): Promise<boolean> {
		await this.addMarketAccountToPoll(marketIndex);
		const accountToPoll = this.accountsToPoll.get(marketIndex.toString());
		this.addAccountToAccountLoader(accountToPoll);
		return true;
	}

	async addOracle(oracleInfo: OracleInfo): Promise<boolean> {
		if (oracleInfo.publicKey.equals(PublicKey.default)) {
			return true;
		}

		this.addOracleToPoll(oracleInfo);
		const oracleToPoll = this.oraclesToPoll.get(
			oracleInfo.publicKey.toString()
		);
		this.addOracleToAccountLoader(oracleToPoll);
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
		marketIndex: BN
	): DataAndSlot<PerpMarketAccount> | undefined {
		return this.perpMarket.get(marketIndex.toNumber());
	}

	public getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[] {
		return Array.from(this.perpMarket.values());
	}

	public getSpotMarketAccountAndSlot(
		marketIndex: BN
	): DataAndSlot<SpotMarketAccount> | undefined {
		return this.spotMarket.get(marketIndex.toNumber());
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
}

type ClearingHouseAccounts = {
	state: PublicKey;
};
