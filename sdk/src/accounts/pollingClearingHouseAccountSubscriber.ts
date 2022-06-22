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
	BankAccount,
	MarketAccount,
	OrderStateAccount,
	StateAccount,
	UserAccount,
} from '../types';
import {
	getClearingHouseStateAccountPublicKey,
	getBankPublicKey,
	getMarketPublicKey,
	getUserAccountPublicKey,
} from '../addresses/pda';
import { BulkAccountLoader } from './bulkAccountLoader';
import { capitalize } from './utils';
import { ClearingHouseConfigType } from '../factory/clearingHouse';
import { PublicKey } from '@solana/web3.js';
import { OracleInfo, OraclePriceData } from '../oracles/types';
import { OracleClientCache } from '../oracles/oracleClientCache';
import { QUOTE_ORACLE_PRICE_DATA } from '../oracles/quoteAssetOracleClient';
type UserPublicKeys = {
	userAccountPublicKey: PublicKey;
};

export class PollingClearingHouseAccountSubscriber
	implements ClearingHouseAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	authority: PublicKey;
	userId: number;
	marketIndexes: BN[];
	bankIndexes: BN[];
	oracleInfos: OracleInfo[];
	oracleClientCache = new OracleClientCache();

	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;

	accountLoader: BulkAccountLoader;
	accountsToPoll = new Map<string, AccountToPoll>();
	oraclesToPoll = new Map<string, OraclesToPoll>();
	errorCallbackId?: string;

	state?: DataAndSlot<StateAccount>;
	market = new Map<number, DataAndSlot<MarketAccount>>();
	bank = new Map<number, DataAndSlot<BankAccount>>();
	oracles = new Map<string, DataAndSlot<OraclePriceData>>();
	orderState?: DataAndSlot<OrderStateAccount>;
	user?: DataAndSlot<UserAccount>;

	type: ClearingHouseConfigType = 'polling';

	private isSubscribing = false;
	private subscriptionPromise: Promise<boolean>;
	private subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(
		program: Program,
		authority: PublicKey,
		accountLoader: BulkAccountLoader,
		userId: number,
		marketIndexes: BN[],
		bankIndexes: BN[],
		oracleInfos: OracleInfo[]
	) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.accountLoader = accountLoader;
		this.authority = authority;
		this.userId = userId;
		this.marketIndexes = marketIndexes;
		this.bankIndexes = bankIndexes;
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

		this.accountsToPoll.set(accounts.orderState.toString(), {
			key: 'orderState',
			publicKey: accounts.orderState,
			eventType: 'orderStateAccountUpdate',
		});

		await this.updateUserAccountsToPoll();
		await this.updateMarketAccountsToPoll();
		await this.updateBankAccountsToPoll();
	}

	async updateUserAccountsToPoll(): Promise<UserPublicKeys> {
		const { userAccountPublicKey } = await this.getUserAccountPublicKeys();

		this.accountsToPoll.set(userAccountPublicKey.toString(), {
			key: 'user',
			publicKey: userAccountPublicKey,
			eventType: 'userAccountUpdate',
		});

		return {
			userAccountPublicKey,
		};
	}

	async updateMarketAccountsToPoll(): Promise<boolean> {
		for (const marketIndex of this.marketIndexes) {
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
			key: 'market',
			publicKey: marketPublicKey,
			eventType: 'marketAccountUpdate',
			mapKey: marketIndex.toNumber(),
		});

		return true;
	}

	async updateBankAccountsToPoll(): Promise<boolean> {
		for (const bankIndex of this.bankIndexes) {
			await this.addBankAccountToPoll(bankIndex);
		}

		return true;
	}

	async addBankAccountToPoll(bankIndex: BN): Promise<boolean> {
		const bankPublicKey = await getBankPublicKey(
			this.program.programId,
			bankIndex
		);

		this.accountsToPoll.set(bankPublicKey.toString(), {
			key: 'bank',
			publicKey: bankPublicKey,
			eventType: 'bankAccountUpdate',
			mapKey: bankIndex.toNumber(),
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

		const state = (await this.program.account.state.fetch(
			statePublicKey
		)) as StateAccount;

		const accounts = {
			state: statePublicKey,
			orderState: state.orderState,
		};

		return accounts;
	}

	async getUserAccountPublicKeys(): Promise<UserPublicKeys> {
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			this.userId
		);

		return {
			userAccountPublicKey,
		};
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

	public async updateAuthority(newAuthority: PublicKey): Promise<boolean> {
		let userAccountPublicKeys = Object.values(
			await this.getUserAccountPublicKeys()
		);

		// remove the old user accounts
		for (const publicKey of userAccountPublicKeys) {
			const accountToPoll = this.accountsToPoll.get(publicKey.toString());
			this.accountLoader.removeAccount(
				accountToPoll.publicKey,
				accountToPoll.callbackId
			);
			this.accountsToPoll.delete(publicKey.toString());
		}

		// update authority
		this.authority = newAuthority;

		// add new user accounts
		userAccountPublicKeys = Object.values(
			await this.updateUserAccountsToPoll()
		);
		for (const publicKey of userAccountPublicKeys) {
			const accountToPoll = this.accountsToPoll.get(publicKey.toString());
			this.addAccountToAccountLoader(accountToPoll);
		}

		return true;
	}

	public async updateUserId(newUserId: number): Promise<boolean> {
		let userAccountPublicKeys = Object.values(
			await this.getUserAccountPublicKeys()
		);

		// remove the old user accounts
		for (const publicKey of userAccountPublicKeys) {
			const accountToPoll = this.accountsToPoll.get(publicKey.toString());
			this.accountLoader.removeAccount(
				accountToPoll.publicKey,
				accountToPoll.callbackId
			);
			this.accountsToPoll.delete(publicKey.toString());
		}

		// update authority
		this.userId = newUserId;

		// add new user accounts
		userAccountPublicKeys = Object.values(
			await this.updateUserAccountsToPoll()
		);
		for (const publicKey of userAccountPublicKeys) {
			const accountToPoll = this.accountsToPoll.get(publicKey.toString());
			this.addAccountToAccountLoader(accountToPoll);
		}

		return true;
	}

	async addBank(bankIndex: BN): Promise<boolean> {
		await this.addBankAccountToPoll(bankIndex);
		const accountToPoll = this.accountsToPoll.get(bankIndex.toString());
		this.addAccountToAccountLoader(accountToPoll);
		return true;
	}

	async addMarket(marketIndex: BN): Promise<boolean> {
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
	): DataAndSlot<MarketAccount> | undefined {
		return this.market.get(marketIndex.toNumber());
	}

	public getBankAccountAndSlot(
		bankIndex: BN
	): DataAndSlot<BankAccount> | undefined {
		return this.bank.get(bankIndex.toNumber());
	}

	public getOrderStateAccountAndSlot(): DataAndSlot<OrderStateAccount> {
		this.assertIsSubscribed();
		return this.orderState;
	}

	public getUserAccountAndSlot(): DataAndSlot<UserAccount> | undefined {
		this.assertIsSubscribed();
		return this.user;
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
	orderState: PublicKey;
};
