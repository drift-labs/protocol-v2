import { ClearingHouseAccountSubscriber, ClearingHouseEvents } from './types';
import { AccountSubscriber, NotSubscribedError } from './types';
import {
	CurveHistory,
	DepositHistory,
	FundingPaymentHistory,
	FundingRateHistory,
	LiquidationHistory,
	Markets,
	State,
	TradeHistory,
} from '../types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { getClearingHouseStatePublicKey } from '../addresses';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';

export class DefaultClearingHouseAccountSubscriber
	implements ClearingHouseAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseEvents>;
	stateAccountSubscriber?: AccountSubscriber<State>;
	marketsAccountSubscriber?: AccountSubscriber<Markets>;
	tradeHistoryAccountSubscriber?: AccountSubscriber<TradeHistory>;
	depositHistoryAccountSubscriber?: AccountSubscriber<DepositHistory>;
	fundingPaymentHistoryAccountSubscriber?: AccountSubscriber<FundingPaymentHistory>;
	fundingRateHistoryAccountSubscriber?: AccountSubscriber<FundingRateHistory>;
	curveHistoryAccountSubscriber?: AccountSubscriber<CurveHistory>;
	liquidationHistoryAccountSubscriber?: AccountSubscriber<LiquidationHistory>;

	public constructor(program: Program) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
	}

	public async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		const statePublicKey = await getClearingHouseStatePublicKey(
			this.program.programId
		);
		this.stateAccountSubscriber = new WebSocketAccountSubscriber(
			'state',
			this.program,
			statePublicKey
		);
		await this.stateAccountSubscriber.subscribe((data: State) => {
			this.eventEmitter.emit('stateUpdate', data);
			this.eventEmitter.emit('update');
		});

		const state = this.stateAccountSubscriber.data;

		this.marketsAccountSubscriber = new WebSocketAccountSubscriber(
			'markets',
			this.program,
			state.markets
		);
		await this.marketsAccountSubscriber.subscribe((data: Markets) => {
			this.eventEmitter.emit('marketsUpdate', data);
			this.eventEmitter.emit('update');
		});

		this.tradeHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'tradeHistory',
			this.program,
			state.tradeHistory
		);
		await this.tradeHistoryAccountSubscriber.subscribe((data: TradeHistory) => {
			this.eventEmitter.emit('tradeHistoryUpdate', data);
			this.eventEmitter.emit('update');
		});

		this.depositHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'depositHistory',
			this.program,
			state.depositHistory
		);
		await this.depositHistoryAccountSubscriber.subscribe(
			(data: DepositHistory) => {
				this.eventEmitter.emit('depositHistoryUpdate', data);
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
			(data: FundingPaymentHistory) => {
				this.eventEmitter.emit('fundingPaymentHistoryUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.fundingRateHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'fundingRateHistory',
			this.program,
			state.fundingRateHistory
		);
		await this.fundingRateHistoryAccountSubscriber.subscribe(
			(data: FundingRateHistory) => {
				this.eventEmitter.emit('fundingRateHistoryUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.liquidationHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'liquidationHistory',
			this.program,
			state.liquidationHistory
		);
		await this.liquidationHistoryAccountSubscriber.subscribe(
			(data: LiquidationHistory) => {
				this.eventEmitter.emit('liquidationHistoryUpdate', data);
				this.eventEmitter.emit('update');
			}
		);

		this.curveHistoryAccountSubscriber = new WebSocketAccountSubscriber(
			'curveHistory',
			this.program,
			state.curveHistory
		);
		await this.curveHistoryAccountSubscriber.subscribe((data: CurveHistory) => {
			this.eventEmitter.emit('curveHistoryUpdate', data);
			this.eventEmitter.emit('update');
		});

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

	public getState(): State {
		this.assertIsSubscribed();
		return this.stateAccountSubscriber.data;
	}

	public getMarkets(): Markets {
		this.assertIsSubscribed();
		return this.marketsAccountSubscriber.data;
	}

	public getTradeHistory(): TradeHistory {
		this.assertIsSubscribed();
		return this.tradeHistoryAccountSubscriber.data;
	}

	public getDepositHistory(): DepositHistory {
		this.assertIsSubscribed();
		return this.depositHistoryAccountSubscriber.data;
	}

	public getFundingPaymentHistory(): FundingPaymentHistory {
		this.assertIsSubscribed();
		return this.fundingPaymentHistoryAccountSubscriber.data;
	}

	public getFundingRateHistory(): FundingRateHistory {
		this.assertIsSubscribed();
		return this.fundingRateHistoryAccountSubscriber.data;
	}

	public getCurveHistory(): CurveHistory {
		this.assertIsSubscribed();
		return this.curveHistoryAccountSubscriber.data;
	}

	public getLiquidationHistory(): LiquidationHistory {
		this.assertIsSubscribed();
		return this.liquidationHistoryAccountSubscriber.data;
	}
}
