import {
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
	AccountAndSlot,
} from './types';
import { AccountSubscriber, NotSubscribedError } from './types';
import {
	BankAccount,
	MarketAccount,
	OrderStateAccount,
	StateAccount,
	UserAccount,
} from '../types';
import { BN, Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	getClearingHouseStateAccountPublicKey,
	getBankPublicKey,
	getMarketPublicKey,
	getUserAccountPublicKey,
	getOrderStateAccountPublicKey,
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
	bankAccountSubscribers = new Map<number, AccountSubscriber<BankAccount>>();
	orderStateAccountSubscriber?: AccountSubscriber<OrderStateAccount>;

	userAccountSubscriber?: AccountSubscriber<UserAccount>;

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

		const orderStatePublicKey = await getOrderStateAccountPublicKey(
			this.program.programId
		);

		this.orderStateAccountSubscriber = new WebSocketAccountSubscriber(
			'orderState',
			this.program,
			orderStatePublicKey
		);

		await this.orderStateAccountSubscriber.subscribe(
			(data: OrderStateAccount) => {
				this.eventEmitter.emit('orderStateAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		// subscribe to user accounts
		await this.subscribeToUserAccounts();

		// subscribe to market accounts
		await this.subscribeToMarketAccounts();

		// subscribe to bank accounts
		await this.subscribeToBankAccounts();

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

	async subscribeToBankAccounts(): Promise<boolean> {
		for (let i = 0; i < 5; i++) {
			const bankPublicKey = await getBankPublicKey(
				this.program.programId,
				new BN(i)
			);
			const accountSubscriber = new WebSocketAccountSubscriber<BankAccount>(
				'bank',
				this.program,
				bankPublicKey
			);
			await accountSubscriber.subscribe((data: BankAccount) => {
				this.eventEmitter.emit('bankAccountUpdate', data);
				this.eventEmitter.emit('update');
			});
			this.bankAccountSubscribers.set(i, accountSubscriber);
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

		return true;
	}

	async unsubscribeFromUserAccounts(): Promise<void> {
		await this.userAccountSubscriber.unsubscribe();
	}

	async unsubscribeFromMarketAccounts(): Promise<void> {
		for (const accountSubscriber of this.marketAccountSubscribers.values()) {
			await accountSubscriber.unsubscribe();
		}
	}

	async unsubscribeFromBankAccounts(): Promise<void> {
		for (const accountSubscriber of this.bankAccountSubscribers.values()) {
			await accountSubscriber.unsubscribe();
		}
	}

	public async fetch(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		const promises = [
			this.stateAccountSubscriber.fetch(),
			this.orderStateAccountSubscriber.fetch(),
			this.userAccountSubscriber.fetch(),
		]
			.concat(
				Array.from(this.marketAccountSubscribers.values()).map((subscriber) =>
					subscriber.fetch()
				)
			)
			.concat(
				Array.from(this.bankAccountSubscribers.values()).map((subscriber) =>
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
		await this.unsubscribeFromBankAccounts();

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

	public getStateAccountAndSlot(): AccountAndSlot<StateAccount> {
		this.assertIsSubscribed();
		return this.stateAccountSubscriber.accountAndSlot;
	}

	public getMarketAccountAndSlot(
		marketIndex: BN
	): AccountAndSlot<MarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.marketAccountSubscribers.get(marketIndex.toNumber())
			.accountAndSlot;
	}

	public getOrderStateAccountAndSlot(): AccountAndSlot<OrderStateAccount> {
		this.assertIsSubscribed();
		return this.orderStateAccountSubscriber.accountAndSlot;
	}

	public getBankAccountAndSlot(
		bankIndex: BN
	): AccountAndSlot<BankAccount> | undefined {
		this.assertIsSubscribed();
		return this.bankAccountSubscribers.get(bankIndex.toNumber()).accountAndSlot;
	}

	public getUserAccountAndSlot(): AccountAndSlot<UserAccount> {
		this.assertIsSubscribed();
		return this.userAccountSubscriber.accountAndSlot;
	}
}
