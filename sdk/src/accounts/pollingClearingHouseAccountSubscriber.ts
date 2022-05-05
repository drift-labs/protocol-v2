import {
	AccountToPoll,
	ClearingHouseAccountEvents,
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountTypes,
	NotSubscribedError,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	DepositHistoryAccount,
	ExtendedCurveHistoryAccount,
	FundingPaymentHistoryAccount,
	FundingRateHistoryAccount,
	LiquidationHistoryAccount,
	MarketsAccount,
	OrderHistoryAccount,
	OrderStateAccount,
	StateAccount,
	TradeHistoryAccount,
} from '../types';
import { getClearingHouseStateAccountPublicKey } from '../addresses';
import { BulkAccountLoader } from './bulkAccountLoader';
import { capitalize } from './utils';
import { ClearingHouseConfigType } from '../factory/clearingHouse';
import { PublicKey } from '@solana/web3.js';
import { CLEARING_HOUSE_STATE_ACCOUNTS } from '../constants/accounts';

export class PollingClearingHouseAccountSubscriber
	implements ClearingHouseAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;

	accountLoader: BulkAccountLoader;
	accountsToPoll = new Map<string, AccountToPoll>();
	errorCallbackId?: string;

	state?: StateAccount;
	markets?: MarketsAccount;
	orderState?: OrderStateAccount;
	tradeHistory?: TradeHistoryAccount;
	depositHistory?: DepositHistoryAccount;
	fundingPaymentHistory?: FundingPaymentHistoryAccount;
	fundingRateHistory?: FundingRateHistoryAccount;
	liquidationHistory?: LiquidationHistoryAccount;
	extendedCurveHistory: ExtendedCurveHistoryAccount;
	orderHistory?: OrderHistoryAccount;

	optionalExtraSubscriptions: ClearingHouseAccountTypes[] = [];

	type: ClearingHouseConfigType = 'polling';

	private isSubscribing = false;
	private subscriptionPromise: Promise<boolean>;
	private subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(program: Program, accountLoader: BulkAccountLoader) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.accountLoader = accountLoader;
	}

	public async subscribe(
		optionalSubscriptions?: ClearingHouseAccountTypes[]
	): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (this.isSubscribing) {
			return await this.subscriptionPromise;
		}

		this.optionalExtraSubscriptions = optionalSubscriptions;

		this.isSubscribing = true;

		this.subscriptionPromise = new Promise((res) => {
			this.subscriptionPromiseResolver = res;
		});

		await this.updateAccountsToPoll();
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

		this.accountsToPoll.set(accounts.markets.toString(), {
			key: 'markets',
			publicKey: accounts.markets,
			eventType: 'marketsAccountUpdate',
		});

		this.accountsToPoll.set(accounts.orderState.toString(), {
			key: 'orderState',
			publicKey: accounts.orderState,
			eventType: 'orderStateAccountUpdate',
		});

		if (this.optionalExtraSubscriptions?.includes('tradeHistoryAccount')) {
			this.accountsToPoll.set(accounts.tradeHistory.toString(), {
				key: 'tradeHistory',
				publicKey: accounts.tradeHistory,
				eventType: 'tradeHistoryAccountUpdate',
			});
		}

		if (this.optionalExtraSubscriptions?.includes('depositHistoryAccount')) {
			this.accountsToPoll.set(accounts.depositHistory.toString(), {
				key: 'depositHistory',
				publicKey: accounts.depositHistory,
				eventType: 'depositHistoryAccountUpdate',
			});
		}

		if (
			this.optionalExtraSubscriptions?.includes('fundingPaymentHistoryAccount')
		) {
			this.accountsToPoll.set(accounts.fundingPaymentHistory.toString(), {
				key: 'fundingPaymentHistory',
				publicKey: accounts.fundingPaymentHistory,
				eventType: 'fundingPaymentHistoryAccountUpdate',
			});
		}

		if (
			this.optionalExtraSubscriptions?.includes('fundingRateHistoryAccount')
		) {
			this.accountsToPoll.set(accounts.fundingRateHistory.toString(), {
				key: 'fundingRateHistory',
				publicKey: accounts.fundingRateHistory,
				eventType: 'fundingRateHistoryAccountUpdate',
			});
		}

		if (this.optionalExtraSubscriptions?.includes('curveHistoryAccount')) {
			this.accountsToPoll.set(accounts.extendedCurveHistory.toString(), {
				key: 'extendedCurveHistory',
				publicKey: accounts.extendedCurveHistory,
				eventType: 'curveHistoryAccountUpdate',
			});
		}

		if (
			this.optionalExtraSubscriptions?.includes('liquidationHistoryAccount')
		) {
			this.accountsToPoll.set(accounts.liquidationHistory.toString(), {
				key: 'liquidationHistory',
				publicKey: accounts.liquidationHistory,
				eventType: 'liquidationHistoryAccountUpdate',
			});
		}

		if (this.optionalExtraSubscriptions?.includes('orderHistoryAccount')) {
			this.accountsToPoll.set(accounts.orderHistory.toString(), {
				key: 'orderHistory',
				publicKey: accounts.orderHistory,
				eventType: 'orderHistoryAccountUpdate',
			});
		}
	}

	async getClearingHouseAccounts(): Promise<ClearingHouseAccounts> {
		// Skip extra calls to rpc if we already know all the accounts
		if (CLEARING_HOUSE_STATE_ACCOUNTS[this.program.programId.toString()]) {
			return CLEARING_HOUSE_STATE_ACCOUNTS[this.program.programId.toString()];
		}

		const statePublicKey = await getClearingHouseStateAccountPublicKey(
			this.program.programId
		);

		const state = (await this.program.account.state.fetch(
			statePublicKey
		)) as StateAccount;

		const accounts = {
			state: statePublicKey,
			markets: state.markets,
			orderState: state.orderState,
			tradeHistory: state.tradeHistory,
			depositHistory: state.depositHistory,
			fundingPaymentHistory: state.fundingPaymentHistory,
			fundingRateHistory: state.fundingRateHistory,
			extendedCurveHistory: state.extendedCurveHistory,
			liquidationHistory: state.liquidationHistory,
			orderHistory: undefined,
		};

		if (this.optionalExtraSubscriptions?.includes('orderHistoryAccount')) {
			const orderState = (await this.program.account.orderState.fetch(
				state.orderState
			)) as OrderStateAccount;

			accounts.orderHistory = orderState.orderHistory;
		}

		return accounts;
	}

	async addToAccountLoader(): Promise<void> {
		for (const [_, accountToPoll] of this.accountsToPoll) {
			accountToPoll.callbackId = this.accountLoader.addAccount(
				accountToPoll.publicKey,
				(buffer) => {
					const account = this.program.account[
						accountToPoll.key
					].coder.accounts.decode(capitalize(accountToPoll.key), buffer);
					this[accountToPoll.key] = account;
					// @ts-ignore
					this.eventEmitter.emit(accountToPoll.eventType, account);
					this.eventEmitter.emit('update');

					if (!this.isSubscribed) {
						this.isSubscribed = this.didSubscriptionSucceed();
					}
				}
			);
		}

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this.eventEmitter.emit('error', error);
		});
	}

	public async fetch(): Promise<void> {
		await this.accountLoader.load();
		for (const [_, accountToPoll] of this.accountsToPoll) {
			const buffer = this.accountLoader.getAccountData(accountToPoll.publicKey);
			if (buffer) {
				this[accountToPoll.key] = this.program.account[
					accountToPoll.key
				].coder.accounts.decode(capitalize(accountToPoll.key), buffer);
			}
		}
	}

	didSubscriptionSucceed(): boolean {
		let success = true;
		for (const [_, accountToPoll] of this.accountsToPoll) {
			if (!this[accountToPoll.key]) {
				success = false;
				break;
			}
		}
		return success;
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

		this.accountLoader.removeErrorCallbacks(this.errorCallbackId);
		this.errorCallbackId = undefined;

		this.accountsToPoll.clear();
		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	assertOptionalIsSubscribed(
		optionalSubscription: ClearingHouseAccountTypes
	): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}

		if (!this.optionalExtraSubscriptions.includes(optionalSubscription)) {
			throw new NotSubscribedError(
				`You need to subscribe to the optional Clearing House account "${optionalSubscription}" to use this method`
			);
		}
	}

	public getStateAccount(): StateAccount {
		this.assertIsSubscribed();
		return this.state;
	}

	public getMarketsAccount(): MarketsAccount {
		this.assertIsSubscribed();
		return this.markets;
	}

	public getOrderStateAccount(): OrderStateAccount {
		this.assertIsSubscribed();
		return this.orderState;
	}

	public getTradeHistoryAccount(): TradeHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('tradeHistoryAccount');
		return this.tradeHistory;
	}

	public getDepositHistoryAccount(): DepositHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('depositHistoryAccount');
		return this.depositHistory;
	}

	public getFundingPaymentHistoryAccount(): FundingPaymentHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('fundingPaymentHistoryAccount');
		return this.fundingPaymentHistory;
	}

	public getFundingRateHistoryAccount(): FundingRateHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('fundingRateHistoryAccount');
		return this.fundingRateHistory;
	}

	public getCurveHistoryAccount(): ExtendedCurveHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('curveHistoryAccount');
		return this.extendedCurveHistory;
	}

	public getLiquidationHistoryAccount(): LiquidationHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('liquidationHistoryAccount');
		return this.liquidationHistory;
	}

	public getOrderHistoryAccount(): OrderHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('orderHistoryAccount');
		return this.orderHistory;
	}
}

type ClearingHouseAccounts = {
	state: PublicKey;
	markets: PublicKey;
	orderState: PublicKey;
	tradeHistory?: PublicKey;
	depositHistory?: PublicKey;
	fundingPaymentHistory?: PublicKey;
	fundingRateHistory?: PublicKey;
	extendedCurveHistory?: PublicKey;
	liquidationHistory?: PublicKey;
	orderHistory?: PublicKey;
};
