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
		await this.fetch();
		this.eventEmitter.emit('update');

		this.isSubscribing = false;
		this.isSubscribed = true;
		this.subscriptionPromiseResolver(true);

		return true;
	}

	async updateAccountsToPoll(): Promise<void> {
		if (this.accountsToPoll.size > 0) {
			return;
		}

		const statePublicKey = await getClearingHouseStateAccountPublicKey(
			this.program.programId
		);

		const state = (await this.program.account.state.fetch(
			statePublicKey
		)) as StateAccount;

		this.accountsToPoll.set(statePublicKey.toString(), {
			key: 'state',
			publicKey: statePublicKey,
			eventType: 'stateAccountUpdate',
		});

		this.accountsToPoll.set(state.markets.toString(), {
			key: 'markets',
			publicKey: state.markets,
			eventType: 'marketsAccountUpdate',
		});

		this.accountsToPoll.set(state.orderState.toString(), {
			key: 'orderState',
			publicKey: state.orderState,
			eventType: 'orderStateAccountUpdate',
		});

		if (this.optionalExtraSubscriptions?.includes('tradeHistoryAccount')) {
			this.accountsToPoll.set(state.tradeHistory.toString(), {
				key: 'tradeHistory',
				publicKey: state.tradeHistory,
				eventType: 'tradeHistoryAccountUpdate',
			});
		}

		if (this.optionalExtraSubscriptions?.includes('depositHistoryAccount')) {
			this.accountsToPoll.set(state.depositHistory.toString(), {
				key: 'depositHistory',
				publicKey: state.depositHistory,
				eventType: 'depositHistoryAccountUpdate',
			});
		}

		if (
			this.optionalExtraSubscriptions?.includes('fundingPaymentHistoryAccount')
		) {
			this.accountsToPoll.set(state.fundingPaymentHistory.toString(), {
				key: 'fundingPaymentHistory',
				publicKey: state.fundingPaymentHistory,
				eventType: 'fundingPaymentHistoryAccountUpdate',
			});
		}

		if (
			this.optionalExtraSubscriptions?.includes('fundingRateHistoryAccount')
		) {
			this.accountsToPoll.set(state.fundingRateHistory.toString(), {
				key: 'fundingRateHistory',
				publicKey: state.fundingRateHistory,
				eventType: 'fundingRateHistoryAccountUpdate',
			});
		}

		if (this.optionalExtraSubscriptions?.includes('curveHistoryAccount')) {
			this.accountsToPoll.set(state.extendedCurveHistory.toString(), {
				key: 'extendedCurveHistory',
				publicKey: state.extendedCurveHistory,
				eventType: 'curveHistoryAccountUpdate',
			});
		}

		if (
			this.optionalExtraSubscriptions?.includes('liquidationHistoryAccount')
		) {
			this.accountsToPoll.set(state.liquidationHistory.toString(), {
				key: 'liquidationHistory',
				publicKey: state.liquidationHistory,
				eventType: 'liquidationHistoryAccountUpdate',
			});
		}

		if (this.optionalExtraSubscriptions?.includes('orderHistoryAccount')) {
			const orderState = (await this.program.account.orderState.fetch(
				state.orderState
			)) as OrderStateAccount;

			this.accountsToPoll.set(orderState.orderHistory.toString(), {
				key: 'orderHistory',
				publicKey: orderState.orderHistory,
				eventType: 'orderHistoryAccountUpdate',
			});
		}
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
