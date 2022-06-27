import {
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
	DataAndSlot,
} from './types';
import { AccountSubscriber, NotSubscribedError } from './types';
import {
	BankAccount,
	MarketAccount,
	OrderStateAccount,
	StateAccount,
} from '../types';
import { BN, Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import {
	getClearingHouseStateAccountPublicKey,
	getBankPublicKey,
	getMarketPublicKey,
	getOrderStateAccountPublicKey,
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
	marketIndexes: BN[];
	bankIndexes: BN[];
	oracleInfos: OracleInfo[];
	oracleClientCache = new OracleClientCache();

	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	stateAccountSubscriber?: AccountSubscriber<StateAccount>;
	marketAccountSubscribers = new Map<
		number,
		AccountSubscriber<MarketAccount>
	>();
	bankAccountSubscribers = new Map<number, AccountSubscriber<BankAccount>>();
	oracleSubscribers = new Map<string, AccountSubscriber<OraclePriceData>>();
	orderStateAccountSubscriber?: AccountSubscriber<OrderStateAccount>;

	private isSubscribing = false;
	private subscriptionPromise: Promise<boolean>;
	private subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(
		program: Program,
		marketIndexes: BN[],
		bankIndexes: BN[],
		oracleInfos: OracleInfo[]
	) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
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

		// subscribe to market accounts
		await this.subscribeToMarketAccounts();

		// subscribe to bank accounts
		await this.subscribeToBankAccounts();

		// subscribe to oracles
		await this.subscribeToOracles();

		this.eventEmitter.emit('update');

		this.isSubscribing = false;
		this.isSubscribed = true;
		this.subscriptionPromiseResolver(true);

		return true;
	}

	async subscribeToMarketAccounts(): Promise<boolean> {
		for (const marketIndex of this.marketIndexes) {
			await this.subscribeToMarketAccount(marketIndex);
		}
		return true;
	}

	async subscribeToMarketAccount(marketIndex: BN): Promise<boolean> {
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
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
		this.marketAccountSubscribers.set(
			marketIndex.toNumber(),
			accountSubscriber
		);
		return true;
	}

	async subscribeToBankAccounts(): Promise<boolean> {
		for (const bankIndex of this.bankIndexes) {
			await this.subscribeToBankAccount(bankIndex);
		}
		return true;
	}

	async subscribeToBankAccount(bankIndex: BN): Promise<boolean> {
		const bankPublicKey = await getBankPublicKey(
			this.program.programId,
			bankIndex
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
		this.bankAccountSubscribers.set(bankIndex.toNumber(), accountSubscriber);
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
		for (const accountSubscriber of this.marketAccountSubscribers.values()) {
			await accountSubscriber.unsubscribe();
		}
	}

	async unsubscribeFromBankAccounts(): Promise<void> {
		for (const accountSubscriber of this.bankAccountSubscribers.values()) {
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

		const promises = [
			this.stateAccountSubscriber.fetch(),
			this.orderStateAccountSubscriber.fetch(),
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

		await this.unsubscribeFromMarketAccounts();
		await this.unsubscribeFromBankAccounts();
		await this.unsubscribeFromOracles();

		this.isSubscribed = false;
	}

	async addBank(bankIndex: BN): Promise<boolean> {
		if (this.bankAccountSubscribers.has(bankIndex.toNumber())) {
			return true;
		}
		return this.subscribeToBankAccount(bankIndex);
	}

	async addMarket(marketIndex: BN): Promise<boolean> {
		if (this.marketAccountSubscribers.has(marketIndex.toNumber())) {
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
	): DataAndSlot<MarketAccount> | undefined {
		this.assertIsSubscribed();
		return this.marketAccountSubscribers.get(marketIndex.toNumber())
			.dataAndSlot;
	}

	public getOrderStateAccountAndSlot(): DataAndSlot<OrderStateAccount> {
		this.assertIsSubscribed();
		return this.orderStateAccountSubscriber.dataAndSlot;
	}

	public getBankAccountAndSlot(
		bankIndex: BN
	): DataAndSlot<BankAccount> | undefined {
		this.assertIsSubscribed();
		return this.bankAccountSubscribers.get(bankIndex.toNumber()).dataAndSlot;
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
