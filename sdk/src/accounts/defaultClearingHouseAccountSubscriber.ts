import {
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
} from './types';
import { AccountSubscriber, NotSubscribedError } from './types';
import {
	CurveHistoryAccount,
	DepositHistoryAccount,
	FundingPaymentHistoryAccount,
	FundingRateHistoryAccount,
	LiquidationHistoryAccount,
	MarketsAccount,
	StateAccount,
	TradeHistoryAccount,
} from '../types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { getClearingHouseStateAccountPublicKey } from '../addresses';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';

export class DefaultClearingHouseAccountSubscriber
	implements ClearingHouseAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	stateAccountSubscriber?: AccountSubscriber<StateAccount>;
	marketsAccountSubscriber?: AccountSubscriber<MarketsAccount>;
	tradeHistoryAccountSubscriber?: AccountSubscriber<TradeHistoryAccount>;
	depositHistoryAccountSubscriber?: AccountSubscriber<DepositHistoryAccount>;
	fundingPaymentHistoryAccountSubscriber?: AccountSubscriber<FundingPaymentHistoryAccount>;
	fundingRateHistoryAccountSubscriber?: AccountSubscriber<FundingRateHistoryAccount>;
	curveHistoryAccountSubscriber?: AccountSubscriber<CurveHistoryAccount>;
	liquidationHistoryAccountSubscriber?: AccountSubscriber<LiquidationHistoryAccount>;

	public constructor(program: Program) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
	}

	public async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		const statePublicKey = await getClearingHouseStateAccountPublicKey(
			this.program.programId
		);
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

		this.marketsAccountSubscriber = new WebSocketAccountSubscriber(
			'markets',
			this.program,
			state.markets
		);
		await this.marketsAccountSubscriber.subscribe((data: MarketsAccount) => {
			this.eventEmitter.emit('marketsAccountUpdate', data);
			this.eventEmitter.emit('update');
		});

		this.tradeHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'tradeHistory',
			this.program,
			state.tradeHistory
		);
		await this.tradeHistoryAccountSubscriber.subscribe(
			(data: TradeHistoryAccount) => {
				this.eventEmitter.emit('tradeHistoryAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.depositHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'depositHistory',
			this.program,
			state.depositHistory
		);
		await this.depositHistoryAccountSubscriber.subscribe(
			(data: DepositHistoryAccount) => {
				this.eventEmitter.emit('depositHistoryAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.fundingPaymentHistoryAccountSubscriber =
			new WebSocketAccountSubscriber(
				'fundingPaymentHistory',
				this.program,
				state.fundingPaymentHistory
			);
		await this.fundingPaymentHistoryAccountSubscriber.subscribe(
			(data: FundingPaymentHistoryAccount) => {
				this.eventEmitter.emit('fundingPaymentHistoryAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.fundingRateHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'fundingRateHistory',
			this.program,
			state.fundingRateHistory
		);
		await this.fundingRateHistoryAccountSubscriber.subscribe(
			(data: FundingRateHistoryAccount) => {
				this.eventEmitter.emit('fundingRateHistoryAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.liquidationHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'liquidationHistory',
			this.program,
			state.liquidationHistory
		);
		await this.liquidationHistoryAccountSubscriber.subscribe(
			(data: LiquidationHistoryAccount) => {
				this.eventEmitter.emit('liquidationHistoryAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.curveHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'curveHistory',
			this.program,
			state.curveHistory
		);
		await this.curveHistoryAccountSubscriber.subscribe(
			(data: CurveHistoryAccount) => {
				this.eventEmitter.emit('curveHistoryAccountUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.eventEmitter.emit('update');

		this.isSubscribed = true;
		return true;
	}

	public async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await this.stateAccountSubscriber.unsubscribe();
		await this.marketsAccountSubscriber.unsubscribe();
		await this.tradeHistoryAccountSubscriber.unsubscribe();
		await this.fundingRateHistoryAccountSubscriber.unsubscribe();
		await this.fundingPaymentHistoryAccountSubscriber.unsubscribe();
		await this.depositHistoryAccountSubscriber.unsubscribe();
		await this.curveHistoryAccountSubscriber.unsubscribe();
		await this.liquidationHistoryAccountSubscriber.unsubscribe();
		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	public getStateAccount(): StateAccount {
		this.assertIsSubscribed();
		return this.stateAccountSubscriber.data;
	}

	public getMarketsAccount(): MarketsAccount {
		this.assertIsSubscribed();
		return this.marketsAccountSubscriber.data;
	}

	public getTradeHistoryAccount(): TradeHistoryAccount {
		this.assertIsSubscribed();
		return this.tradeHistoryAccountSubscriber.data;
	}

	public getDepositHistoryAccount(): DepositHistoryAccount {
		this.assertIsSubscribed();
		return this.depositHistoryAccountSubscriber.data;
	}

	public getFundingPaymentHistoryAccount(): FundingPaymentHistoryAccount {
		this.assertIsSubscribed();
		return this.fundingPaymentHistoryAccountSubscriber.data;
	}

	public getFundingRateHistoryAccount(): FundingRateHistoryAccount {
		this.assertIsSubscribed();
		return this.fundingRateHistoryAccountSubscriber.data;
	}

	public getCurveHistoryAccount(): CurveHistoryAccount {
		this.assertIsSubscribed();
		return this.curveHistoryAccountSubscriber.data;
	}

	public getLiquidationHistoryAccount(): LiquidationHistoryAccount {
		this.assertIsSubscribed();
		return this.liquidationHistoryAccountSubscriber.data;
	}
}
