import {
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
	ClearingHouseAccountTypes,
} from './types';
import { AccountSubscriber, NotSubscribedError } from './types';
import {
	DepositHistoryAccount,
	ExtendedCurveHistoryAccount,
	FundingPaymentHistoryAccount,
	FundingRateHistoryAccount,
	LiquidationHistoryAccount,
	MarketAccount,
	OrderHistoryAccount,
	OrderStateAccount,
	StateAccount,
	TradeHistoryAccount,
	UserAccount,
	UserOrdersAccount,
	UserPositionsAccount,
} from '../types';
import { BN, Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	getClearingHouseStateAccountPublicKey,
	getMarketPublicKey,
	getUserAccountPublicKey,
	getUserOrdersAccountPublicKey,
	getUserPositionsAccountPublicKey,
} from '../addresses/pda';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { ClearingHouseConfigType } from '../factory/clearingHouse';
import { PublicKey } from '@solana/web3.js';

export class WebSocketClearingHouseAccountSubscriber
	implements ClearingHouseAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	authority: PublicKey;

	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	stateAccountSubscriber?: AccountSubscriber<StateAccount>;
	marketAccountSubscribers = new Map<
		number,
		AccountSubscriber<MarketAccount>
	>();
	tradeHistoryAccountSubscriber?: AccountSubscriber<TradeHistoryAccount>;
	depositHistoryAccountSubscriber?: AccountSubscriber<DepositHistoryAccount>;
	fundingPaymentHistoryAccountSubscriber?: AccountSubscriber<FundingPaymentHistoryAccount>;
	fundingRateHistoryAccountSubscriber?: AccountSubscriber<FundingRateHistoryAccount>;
	curveHistoryAccountSubscriber?: AccountSubscriber<ExtendedCurveHistoryAccount>;
	liquidationHistoryAccountSubscriber?: AccountSubscriber<LiquidationHistoryAccount>;
	orderStateAccountSubscriber?: AccountSubscriber<OrderStateAccount>;
	orderHistoryAccountSubscriber?: AccountSubscriber<OrderHistoryAccount>;

	userAccountSubscriber?: AccountSubscriber<UserAccount>;
	userPositionsAccountSubscriber?: AccountSubscriber<UserPositionsAccount>;
	userOrdersAccountSubscriber?: AccountSubscriber<UserOrdersAccount>;

	optionalExtraSubscriptions: ClearingHouseAccountTypes[] = [];

	type: ClearingHouseConfigType = 'websocket';

	private isSubscribing = false;
	private subscriptionPromise: Promise<boolean>;
	private subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(program: Program, authority: PublicKey) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.authority = authority;
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

		const state = this.stateAccountSubscriber.data;

		this.orderStateAccountSubscriber = new WebSocketAccountSubscriber(
			'orderState',
			this.program,
			state.orderState
		);

		await this.orderStateAccountSubscriber.subscribe(
			(data: OrderStateAccount) => {
				this.eventEmitter.emit('orderStateAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		const orderState = this.orderStateAccountSubscriber.data;

		// subscribe to user accounts
		await this.subscribeToUserAccounts();

		// subscribe to market accounts
		await this.subscribeToMarketAccounts();

		// create subscribers for other state accounts

		this.tradeHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'tradeHistory',
			this.program,
			state.tradeHistory
		);

		this.depositHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'depositHistory',
			this.program,
			state.depositHistory
		);

		this.fundingPaymentHistoryAccountSubscriber =
			new WebSocketAccountSubscriber(
				'fundingPaymentHistory',
				this.program,
				state.fundingPaymentHistory
			);

		this.fundingRateHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'fundingRateHistory',
			this.program,
			state.fundingRateHistory
		);

		this.liquidationHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'liquidationHistory',
			this.program,
			state.liquidationHistory
		);

		this.curveHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'extendedCurveHistory',
			this.program,
			state.extendedCurveHistory
		);

		this.orderHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'orderHistory',
			this.program,
			orderState.orderHistory
		);

		const extraSusbcribersToUse: {
			subscriber: AccountSubscriber<any>;
			eventType: keyof ClearingHouseAccountEvents;
		}[] = [];

		if (optionalSubscriptions?.includes('tradeHistoryAccount'))
			extraSusbcribersToUse.push({
				subscriber: this.tradeHistoryAccountSubscriber,
				eventType: 'tradeHistoryAccountUpdate',
			});

		if (optionalSubscriptions?.includes('depositHistoryAccount'))
			extraSusbcribersToUse.push({
				subscriber: this.depositHistoryAccountSubscriber,
				eventType: 'depositHistoryAccountUpdate',
			});

		if (optionalSubscriptions?.includes('fundingPaymentHistoryAccount'))
			extraSusbcribersToUse.push({
				subscriber: this.fundingPaymentHistoryAccountSubscriber,
				eventType: 'fundingPaymentHistoryAccountUpdate',
			});

		if (optionalSubscriptions?.includes('fundingRateHistoryAccount'))
			extraSusbcribersToUse.push({
				subscriber: this.fundingRateHistoryAccountSubscriber,
				eventType: 'fundingRateHistoryAccountUpdate',
			});

		if (optionalSubscriptions?.includes('liquidationHistoryAccount'))
			extraSusbcribersToUse.push({
				subscriber: this.liquidationHistoryAccountSubscriber,
				eventType: 'liquidationHistoryAccountUpdate',
			});

		if (optionalSubscriptions?.includes('curveHistoryAccount'))
			extraSusbcribersToUse.push({
				subscriber: this.curveHistoryAccountSubscriber,
				eventType: 'curveHistoryAccountUpdate',
			});

		if (optionalSubscriptions?.includes('orderHistoryAccount'))
			extraSusbcribersToUse.push({
				subscriber: this.orderHistoryAccountSubscriber,
				eventType: 'orderHistoryAccountUpdate',
			});

		this.optionalExtraSubscriptions = optionalSubscriptions ?? [];

		// await all subcriptions in parallel to boost performance
		//// the state account subscription above can't happen in here, because some of these susbcriptions are dependent on clearing house state being available
		await Promise.all(
			extraSusbcribersToUse.map(({ subscriber, eventType }) =>
				subscriber.subscribe((data) => {
					this.eventEmitter.emit(eventType, data);
					this.eventEmitter.emit('update');
				})
			)
		);

		this.eventEmitter.emit('update');

		this.isSubscribing = false;
		this.isSubscribed = true;
		this.subscriptionPromiseResolver(true);

		return true;
	}

	async subscribeToMarketAccounts(): Promise<boolean> {
		for (let i = 0; i < 10; i++) {
			const marketPublicKey = await getMarketPublicKey(
				this.program.programId,
				new BN(i)
			);
			const accountSubscriber = new WebSocketAccountSubscriber<MarketAccount>(
				'market',
				this.program,
				marketPublicKey
			);
			await accountSubscriber.subscribe((data: MarketAccount) => {
				this.eventEmitter.emit('marketAccountUpdate', data);
				this.eventEmitter.emit('update');
			});
			this.marketAccountSubscribers.set(i, accountSubscriber);
		}
		return true;
	}

	async subscribeToUserAccounts(): Promise<boolean> {
		const userPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority
		);
		this.userAccountSubscriber = new WebSocketAccountSubscriber(
			'user',
			this.program,
			userPublicKey
		);
		await this.userAccountSubscriber.subscribe((data: UserAccount) => {
			this.eventEmitter.emit('userAccountUpdate', data);
			this.eventEmitter.emit('update');
		});

		const userPositionsPublicKey = await getUserPositionsAccountPublicKey(
			this.program.programId,
			userPublicKey
		);

		this.userPositionsAccountSubscriber = new WebSocketAccountSubscriber(
			'userPositions',
			this.program,
			userPositionsPublicKey
		);

		await this.userPositionsAccountSubscriber.subscribe(
			(data: UserPositionsAccount) => {
				this.eventEmitter.emit('userPositionsAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		const userOrdersPublicKey = await getUserOrdersAccountPublicKey(
			this.program.programId,
			userPublicKey
		);

		this.userOrdersAccountSubscriber = new WebSocketAccountSubscriber(
			'userOrders',
			this.program,
			userOrdersPublicKey
		);
		await this.userOrdersAccountSubscriber.subscribe(
			(data: UserOrdersAccount) => {
				this.eventEmitter.emit('userOrdersAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		return true;
	}

	async unsubscribeFromUserAccounts(): Promise<void> {
		await this.userAccountSubscriber.unsubscribe();
		await this.userPositionsAccountSubscriber.unsubscribe();
		await this.userOrdersAccountSubscriber.unsubscribe();
	}

	async unsubscribeFromMarketAccounts(): Promise<void> {
		for (const accountSubscriber of this.marketAccountSubscribers.values()) {
			await accountSubscriber.unsubscribe();
		}
	}

	public async fetch(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		const promises = this.optionalExtraSubscriptions
			.map((optionalSubscription) => {
				const subscriber = `${optionalSubscription}Subscriber`;
				return this[subscriber].fetch();
			})
			.concat([this.stateAccountSubscriber.fetch()])
			.concat([
				this.userAccountSubscriber.fetch(),
				this.userPositionsAccountSubscriber.fetch(),
				this.userOrdersAccountSubscriber.fetch(),
			])
			.concat(
				Array.from(this.marketAccountSubscribers.values()).map((subscriber) =>
					subscriber.fetch()
				)
			);

		await Promise.all(promises);
	}

	public async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await this.stateAccountSubscriber.unsubscribe();
		await this.orderStateAccountSubscriber.unsubscribe();

		await this.unsubscribeFromUserAccounts();
		await this.unsubscribeFromMarketAccounts();

		if (this.optionalExtraSubscriptions.includes('tradeHistoryAccount')) {
			await this.tradeHistoryAccountSubscriber.unsubscribe();
		}

		if (this.optionalExtraSubscriptions.includes('fundingRateHistoryAccount')) {
			await this.fundingRateHistoryAccountSubscriber.unsubscribe();
		}

		if (
			this.optionalExtraSubscriptions.includes('fundingPaymentHistoryAccount')
		) {
			await this.fundingPaymentHistoryAccountSubscriber.unsubscribe();
		}

		if (this.optionalExtraSubscriptions.includes('depositHistoryAccount')) {
			await this.depositHistoryAccountSubscriber.unsubscribe();
		}

		if (this.optionalExtraSubscriptions.includes('curveHistoryAccount')) {
			await this.curveHistoryAccountSubscriber.unsubscribe();
		}

		if (this.optionalExtraSubscriptions.includes('liquidationHistoryAccount')) {
			await this.liquidationHistoryAccountSubscriber.unsubscribe();
		}

		if (this.optionalExtraSubscriptions.includes('orderHistoryAccount')) {
			await this.orderHistoryAccountSubscriber.unsubscribe();
		}

		this.isSubscribed = false;
	}

	public async updateAuthority(newAuthority: PublicKey): Promise<boolean> {
		// unsubscribe from old user accounts
		await this.unsubscribeFromUserAccounts();
		// update authority
		this.authority = newAuthority;
		// subscribe to new user accounts
		return this.subscribeToUserAccounts();
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
		return this.stateAccountSubscriber.data;
	}

	public getMarketAccount(marketIndex: BN): MarketAccount | undefined {
		this.assertIsSubscribed();
		return this.marketAccountSubscribers.get(marketIndex.toNumber()).data;
	}

	public getTradeHistoryAccount(): TradeHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('tradeHistoryAccount');
		return this.tradeHistoryAccountSubscriber.data;
	}

	public getDepositHistoryAccount(): DepositHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('depositHistoryAccount');
		return this.depositHistoryAccountSubscriber.data;
	}

	public getFundingPaymentHistoryAccount(): FundingPaymentHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('fundingPaymentHistoryAccount');
		return this.fundingPaymentHistoryAccountSubscriber.data;
	}

	public getFundingRateHistoryAccount(): FundingRateHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('fundingRateHistoryAccount');
		return this.fundingRateHistoryAccountSubscriber.data;
	}

	public getCurveHistoryAccount(): ExtendedCurveHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('curveHistoryAccount');
		return this.curveHistoryAccountSubscriber.data;
	}

	public getLiquidationHistoryAccount(): LiquidationHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('liquidationHistoryAccount');
		return this.liquidationHistoryAccountSubscriber.data;
	}

	public getOrderHistoryAccount(): OrderHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('orderHistoryAccount');
		return this.orderHistoryAccountSubscriber.data;
	}

	public getOrderStateAccount(): OrderStateAccount {
		this.assertIsSubscribed();
		return this.orderStateAccountSubscriber.data;
	}

	public getUserAccount(): UserAccount {
		this.assertIsSubscribed();
		return this.userAccountSubscriber.data;
	}

	public getUserPositionsAccount(): UserPositionsAccount {
		this.assertIsSubscribed();
		return this.userPositionsAccountSubscriber.data;
	}

	public getUserOrdersAccount(): UserOrdersAccount {
		this.assertIsSubscribed();
		return this.userOrdersAccountSubscriber.data;
	}
}
