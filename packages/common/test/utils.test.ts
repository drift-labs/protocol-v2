import { BN, OrderTriggerCondition, OrderType, QUOTE_PRECISION_EXP } from '@velocity-exchange/sdk';
import { Decimal } from 'decimal.js';
import {
	BaseDynamoRecord,
	CandleResolutions,
	OrderAction,
	OrderActionRecord,
	OrderLabel,
	TradeRecord,
} from '../src';
import {
	batchArray,
	bnStringToNumber,
	calculatePnlFromTrade,
	compareActions,
	enumToStr,
	getActionPriority,
	getOrderLabel,
	getResolutionSeconds,
	getTimestamp,
	getTimestampHour,
	getTimestampsWithInterval,
	roundToDay,
	sleep,
} from '../src/utils';

describe('batchArray', () => {
	it('should correctly batch an array', () => {
		const input = [1, 2, 3, 4, 5, 6, 7];
		const result = batchArray(input, 3);
		expect(result).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
	});

	it('should return an empty array for empty input', () => {
		expect(batchArray([], 5)).toEqual([]);
	});

	it('should handle batch size larger than array length', () => {
		expect(batchArray([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
	});
});

describe('sleep', () => {
	jest.useFakeTimers();

	it('should resolve after the specified time', async () => {
		const sleepPromise = sleep(1000);
		jest.advanceTimersByTime(1000);
		await expect(sleepPromise).resolves.toBeUndefined();
	});
});

describe('enumToStr', () => {
	it('should return the first key of an enum', () => {
		const testEnum = { KEY1: 'value1', KEY2: 'value2' };
		expect(enumToStr(testEnum)).toBe('KEY1');
	});

	it('should return undefined for an empty object', () => {
		expect(enumToStr({})).toBeUndefined();
	});

	it('should return undefined for null or undefined input', () => {
		expect(enumToStr(null as any)).toBeUndefined();
		expect(enumToStr(undefined as any)).toBeUndefined();
	});
});

describe('bnStringToNumber', () => {
	it('should convert string to number without precision', () => {
		expect(bnStringToNumber('123')).toBe(123);
	});

	it('should convert string to number with precision', () => {
		const precision = new BN(100);
		expect(bnStringToNumber('12345', precision)).toBe(123.45);
	});

	it('should return 0 for undefined input', () => {
		expect(bnStringToNumber(undefined)).toBe(0);
	});
});

describe('getOrderLabel', () => {
	it('should classify limit orders', () => {
		expect(
			getOrderLabel({
				orderType: enumToStr(OrderType.LIMIT),
				oraclePriceOffset: 0,
			})
		).toBe(OrderLabel.LIMIT);
	});

	it('should classify oracle limit orders when oraclePriceOffset is numeric', () => {
		expect(
			getOrderLabel({
				orderType: enumToStr(OrderType.LIMIT),
				oraclePriceOffset: 10,
			})
		).toBe(OrderLabel.ORACLE_LIMIT);
	});

	it('should classify trigger orders', () => {
		expect(
			getOrderLabel({
				orderType: enumToStr(OrderType.TRIGGER_MARKET),
				triggerPrice: 50000,
				triggerCondition: enumToStr(OrderTriggerCondition.BELOW),
			})
		).toBe(OrderLabel.STOP_MARKET);

		expect(
			getOrderLabel({
				orderType: enumToStr(OrderType.TRIGGER_LIMIT),
				triggerPrice: 50000,
				triggerCondition: enumToStr(OrderTriggerCondition.ABOVE),
			})
		).toBe(OrderLabel.TAKE_PROFIT_LIMIT);
	});
});

describe('getTimestamp', () => {
	beforeEach(() => {
		jest.setSystemTime(new Date('2023-01-01T00:00:00Z'));
	});

	it('should return current timestamp without days added', () => {
		expect(getTimestamp()).toBe(1672531200);
	});

	it('should return timestamp with days added', () => {
		expect(getTimestamp({ days: 1 })).toBe(1672617600);
	});
});

describe('getResolutionSeconds', () => {
	it('should return correct intervals for all resolutions', () => {
		const cases: [CandleResolutions, number][] = [
			['1', 60],
			['5', 300],
			['15', 900],
			['60', 3600],
			['240', 14400],
			['D', 86400],
			['W', 604800],
			['M', 2592000],
		];

		cases.forEach(([resolution, expected]) => {
			expect(getResolutionSeconds(resolution)).toBe(expected);
		});
	});

	it('should throw error for invalid resolution', () => {
		expect(() => {
			getResolutionSeconds('invalid' as CandleResolutions);
		}).toThrow('Invalid resolution: invalid');
	});
});

describe('getTimestampHour', () => {
	beforeEach(() => {
		jest.setSystemTime(new Date('2023-01-01T14:30:45.123Z'));
	});

	it('should return current hour timestamp with minutes/seconds/ms set to 0', () => {
		const expected = Math.floor(new Date('2023-01-01T14:00:00.000Z').getTime() / 1000);
		expect(getTimestampHour({})).toBe(expected);
	});

	it('should handle days and hours parameters', () => {
		const expected = Math.floor(new Date('2023-01-02T16:00:00.000Z').getTime() / 1000);
		expect(getTimestampHour({ days: 1, hours: 2 })).toBe(expected);
	});
});

describe('roundToDay', () => {
	it('should round timestamp to the start of the day', () => {
		const timestamp = Math.floor(new Date('2023-01-01T14:30:45Z').getTime() / 1000);
		const expected = Math.floor(new Date('2023-01-01T00:00:00Z').getTime() / 1000);
		expect(roundToDay(timestamp)).toBe(expected);
	});
});

describe('getTimestampsWithInterval', () => {
	it('should return an array of timestamps with 1-hour intervals by default', () => {
		const startTimestamp = Math.floor(new Date('2023-01-01T10:00:00Z').getTime() / 1000);
		const endTimestamp = Math.floor(new Date('2023-01-01T13:00:00Z').getTime() / 1000);

		const expected = [
			startTimestamp,
			startTimestamp + 3600,
			startTimestamp + 7200,
			startTimestamp + 10800,
		];

		expect(getTimestampsWithInterval(startTimestamp, endTimestamp)).toEqual(expected);
	});

	it('should handle custom interval hours', () => {
		const startTimestamp = Math.floor(new Date('2023-01-01T10:00:00Z').getTime() / 1000);
		const endTimestamp = Math.floor(new Date('2023-01-01T16:00:00Z').getTime() / 1000);

		const expected = [
			startTimestamp,
			startTimestamp + 7200,
			startTimestamp + 14400,
			startTimestamp + 21600,
		];

		expect(getTimestampsWithInterval(startTimestamp, endTimestamp, 2)).toEqual(expected);
	});
});

describe('getActionPriority', () => {
	it('should return correct priority for known action types', () => {
		expect(getActionPriority(OrderAction.CANCEL)).toBe(1);
		expect(getActionPriority(OrderAction.EXPIRE)).toBe(2);
		expect(getActionPriority(OrderAction.FILL)).toBe(3);
		expect(getActionPriority(OrderAction.TRIGGER)).toBe(4);
		expect(getActionPriority(OrderAction.PLACE)).toBe(5);
	});

	it('should return default priority for unknown action type', () => {
		expect(getActionPriority('unknown')).toBe(99);
		expect(getActionPriority('')).toBe(99);
	});
});

describe('compareActions', () => {
	it('should prioritize higher timestamps', () => {
		const action1 = createMockAction({ ts: 1000, slot: 100, action: OrderAction.FILL });
		const action2 = createMockAction({ ts: 2000, slot: 100, action: OrderAction.FILL });

		expect(compareActions(action1, action2)).toBeGreaterThan(0);
		expect(compareActions(action2, action1)).toBeLessThan(0);
	});

	it('should prioritize higher slots when timestamps are equal', () => {
		const action1 = createMockAction({ ts: 1000, slot: 100, action: OrderAction.FILL });
		const action2 = createMockAction({ ts: 1000, slot: 200, action: OrderAction.FILL });

		expect(compareActions(action1, action2)).toBeGreaterThan(0);
		expect(compareActions(action2, action1)).toBeLessThan(0);
	});

	it('should prioritize cancel actions over fill actions when timestamps and slots are equal', () => {
		const fillAction = createMockAction({ ts: 1000, slot: 100, action: OrderAction.FILL });
		const cancelAction = createMockAction({ ts: 1000, slot: 100, action: OrderAction.CANCEL });

		expect(compareActions(fillAction, cancelAction)).toBeGreaterThan(0);
		expect(compareActions(cancelAction, fillAction)).toBeLessThan(0);
	});

	it('should prioritize expire actions over fill actions when timestamps and slots are equal', () => {
		const fillAction = createMockAction({ ts: 1000, slot: 100, action: OrderAction.FILL });
		const expireAction = createMockAction({ ts: 1000, slot: 100, action: OrderAction.EXPIRE });
		expect(compareActions(fillAction, expireAction)).toBeGreaterThan(0);
		expect(compareActions(expireAction, fillAction)).toBeLessThan(0);
	});

	it('should prioritize cancel over expire when timestamps and slots are equal', () => {
		const cancelAction = createMockAction({ ts: 1000, slot: 100, action: OrderAction.CANCEL });
		const expireAction = createMockAction({ ts: 1000, slot: 100, action: OrderAction.EXPIRE });

		expect(compareActions(cancelAction, expireAction)).toBeLessThan(0);
		expect(compareActions(expireAction, cancelAction)).toBeGreaterThan(0);
	});

	it('should prioritize fills with higher fillRecordId when timestamps, slots, and action types are equal', () => {
		const action1 = createMockAction({
			ts: 1000,
			slot: 100,
			action: OrderAction.FILL,
			fillRecordId: '1000',
		});
		const action2 = createMockAction({
			ts: 1000,
			slot: 100,
			action: OrderAction.FILL,
			fillRecordId: '2000',
		});

		expect(compareActions(action1, action2)).toBeGreaterThan(0);
		expect(compareActions(action2, action1)).toBeLessThan(0);
	});

	it('should handle empty or undefined fillRecordId', () => {
		const action1 = createMockAction({
			ts: 1000,
			slot: 100,
			action: OrderAction.FILL,
			fillRecordId: undefined,
		});
		const action2 = createMockAction({
			ts: 1000,
			slot: 100,
			action: OrderAction.FILL,
			fillRecordId: '2000',
		});
		const action3 = createMockAction({
			ts: 1000,
			slot: 100,
			action: OrderAction.FILL,
			fillRecordId: '',
		});

		expect(compareActions(action1, action2)).toBeGreaterThan(0);
		expect(compareActions(action3, action2)).toBeGreaterThan(0);
		expect(compareActions(action1, action3)).toBe(0);
	});

	it('should correctly order a complex set of actions', () => {
		const actions = [
			createMockAction({ ts: 1000, slot: 100, action: OrderAction.PLACE }),
			createMockAction({ ts: 2000, slot: 200, action: OrderAction.TRIGGER }),
			createMockAction({
				ts: 2000,
				slot: 200,
				action: OrderAction.FILL,
				fillRecordId: '1000',
			}),
			createMockAction({
				ts: 2000,
				slot: 200,
				action: OrderAction.FILL,
				fillRecordId: '2000',
			}),
			createMockAction({ ts: 2000, slot: 200, action: OrderAction.CANCEL }),
			createMockAction({ ts: 2000, slot: 200, action: OrderAction.EXPIRE }),
		];

		const sortedActions = [...actions].sort(compareActions);

		// Expected order (based on actual implementation):
		// 1. ts: 2000, slot: 200, CANCEL
		// 2. ts: 2000, slot: 200, EXPIRE
		// 3. ts: 2000, slot: 200, FILL, fillRecordId: '2000'
		// 4. ts: 2000, slot: 200, FILL, fillRecordId: '1000'
		// 5. ts: 2000, slot: 200, TRIGGER
		// 6. ts: 1000, slot: 100, PLACE

		expect(sortedActions[0].ts).toBe(2000);
		expect(sortedActions[0].slot).toBe(200);
		expect(sortedActions[0].action).toBe(OrderAction.CANCEL);

		expect(sortedActions[1].ts).toBe(2000);
		expect(sortedActions[1].slot).toBe(200);
		expect(sortedActions[1].action).toBe(OrderAction.EXPIRE);

		expect(sortedActions[2].ts).toBe(2000);
		expect(sortedActions[2].slot).toBe(200);
		expect(sortedActions[2].action).toBe(OrderAction.FILL);
		expect(sortedActions[2].fillRecordId).toBe('2000');

		expect(sortedActions[3].ts).toBe(2000);
		expect(sortedActions[3].slot).toBe(200);
		expect(sortedActions[3].action).toBe(OrderAction.FILL);
		expect(sortedActions[3].fillRecordId).toBe('1000');

		expect(sortedActions[4].ts).toBe(2000);
		expect(sortedActions[4].slot).toBe(200);
		expect(sortedActions[4].action).toBe(OrderAction.TRIGGER);

		expect(sortedActions[5].ts).toBe(1000);
		expect(sortedActions[5].slot).toBe(100);
		expect(sortedActions[5].action).toBe(OrderAction.PLACE);
	});
});

function createMockAction(params: {
	ts: number;
	slot: number;
	action: string;
	fillRecordId?: string;
}): OrderActionRecord & BaseDynamoRecord {
	return {
		ts: params.ts,
		slot: params.slot,
		action: params.action,
		fillRecordId: params.fillRecordId,
		txSig: 'test-tx-sig',
		txSigIndex: 0,
		takerOrderId: '0',
		user: 'test-user',
		marketIndex: 0,
		marketType: 'perp',
		symbol: 'TEST-PERP',
	} as any;
}

describe('calculatePnlFromTrade', () => {
	describe('null handling', () => {
		it('should return 0 if taker side is requested but taker is null', () => {
			const trade: TradeRecord = {
				taker: null,
				maker: 'makerAddress',
				takerExistingQuoteEntryAmount: 100,
			} as any;

			expect(calculatePnlFromTrade(trade, true, 'taker').equals(0)).toBe(true);
		});

		it('should return 0 if maker side is requested but maker is null', () => {
			const trade: TradeRecord = {
				taker: 'takerAddress',
				maker: null,
				makerExistingQuoteEntryAmount: 100,
			} as any;

			expect(calculatePnlFromTrade(trade, true, 'maker').equals(0)).toBe(true);
		});

		it('should return 0 if takerExistingQuoteEntryAmount is undefined', () => {
			const trade: TradeRecord = {
				taker: 'takerAddress',
				takerExistingQuoteEntryAmount: undefined,
			} as any;

			expect(calculatePnlFromTrade(trade).equals(0)).toBe(true);
		});
	});

	describe('taker side calculations', () => {
		it('should calculate correct PnL for SHORT direction with fees', () => {
			const trade: TradeRecord = {
				taker: 'takerAddress',
				quoteAssetAmountFilled: 200,
				baseAssetAmountFilled: 2,
				takerExistingQuoteEntryAmount: 100,
				takerExistingBaseAssetAmount: 1,
				takerFee: 5,
				takerOrderDirection: 'short',
			} as any;

			const result = calculatePnlFromTrade(trade, true, 'taker');

			const expectedPnl = new Decimal(200)
				.div(2) // avgExitPrice = 100
				.minus(new Decimal(100).div(1)) // entryPrice = 100
				.mul(1) // base amount
				.minus(5) // fee
				.toSignificantDigits(QUOTE_PRECISION_EXP.toNumber());

			expect(result.equals(expectedPnl)).toBe(true);
		});

		it('should calculate correct PnL for SHORT direction without fees', () => {
			const trade: TradeRecord = {
				taker: 'takerAddress',
				quoteAssetAmountFilled: 200,
				baseAssetAmountFilled: 2,
				takerExistingQuoteEntryAmount: 100,
				takerExistingBaseAssetAmount: 1,
				takerFee: 5,
				takerOrderDirection: 'short',
			} as any;

			const result = calculatePnlFromTrade(trade, false, 'taker');

			const expectedPnl = new Decimal(200)
				.div(2) // avgExitPrice = 100
				.minus(new Decimal(100).div(1)) // entryPrice = 100
				.mul(1) // base amount
				.toSignificantDigits(QUOTE_PRECISION_EXP.toNumber());

			expect(result.equals(expectedPnl)).toBe(true);
		});

		it('should calculate correct PnL for LONG direction', () => {
			const trade: TradeRecord = {
				taker: 'takerAddress',
				quoteAssetAmountFilled: 200,
				baseAssetAmountFilled: 2,
				takerExistingQuoteEntryAmount: 100,
				takerExistingBaseAssetAmount: 1,
				takerFee: 5,
				takerOrderDirection: 'long',
			} as any;

			const result = calculatePnlFromTrade(trade);

			const avgExitPrice = new Decimal(200).div(2); // 100
			const entryPrice = new Decimal(100).div(1); // 100
			const expectedPnl = entryPrice
				.minus(avgExitPrice) // 100 - 100 = 0
				.mul(1) // base
				.minus(5) // fee
				.toSignificantDigits(QUOTE_PRECISION_EXP.toNumber());

			expect(result.equals(expectedPnl)).toBe(true);
		});

		it('should fallback to baseAssetAmountFilled when existingBase is 0', () => {
			const trade: TradeRecord = {
				taker: 'takerAddress',
				quoteAssetAmountFilled: 300,
				baseAssetAmountFilled: 2,
				takerExistingQuoteEntryAmount: 150,
				takerExistingBaseAssetAmount: 0,
				takerFee: 10,
				takerOrderDirection: 'short',
			} as any;

			const result = calculatePnlFromTrade(trade);

			const avgExit = new Decimal(300).div(2); // 150
			const entry = new Decimal(150).div(2); // 75
			const pnl = avgExit
				.minus(entry)
				.mul(2)
				.minus(10)
				.toSignificantDigits(QUOTE_PRECISION_EXP.toNumber());

			expect(result.equals(pnl)).toBe(true);
		});
	});

	describe('maker side calculations', () => {
		it('should calculate correct PnL for maker SHORT direction with fees', () => {
			const trade: TradeRecord = {
				maker: 'makerAddress',
				quoteAssetAmountFilled: 200,
				baseAssetAmountFilled: 2,
				makerExistingQuoteEntryAmount: 100,
				makerExistingBaseAssetAmount: 1,
				makerFee: 3,
				makerOrderDirection: 'short',
			} as any;

			const result = calculatePnlFromTrade(trade, true, 'maker');

			const expectedPnl = new Decimal(200)
				.div(2) // avgExitPrice = 100
				.minus(new Decimal(100).div(1)) // entryPrice = 100
				.mul(1) // base amount
				.minus(3) // maker fee
				.toSignificantDigits(QUOTE_PRECISION_EXP.toNumber());

			expect(result.equals(expectedPnl)).toBe(true);
		});

		it('should calculate correct PnL for maker LONG direction without fees', () => {
			const trade: TradeRecord = {
				maker: 'makerAddress',
				quoteAssetAmountFilled: 180,
				baseAssetAmountFilled: 2,
				makerExistingQuoteEntryAmount: 100,
				makerExistingBaseAssetAmount: 1,
				makerFee: 3,
				makerOrderDirection: 'long',
			} as any;

			const result = calculatePnlFromTrade(trade, false, 'maker');

			const avgExitPrice = new Decimal(180).div(2); // 90
			const entryPrice = new Decimal(100).div(1); // 100
			const expectedPnl = entryPrice
				.minus(avgExitPrice) // 100 - 90 = 10
				.mul(1) // base
				.toSignificantDigits(QUOTE_PRECISION_EXP.toNumber());

			expect(result.equals(expectedPnl)).toBe(true);
		});

		it('should use maker fields not taker fields', () => {
			const trade: TradeRecord = {
				taker: 'takerAddress',
				maker: 'makerAddress',
				quoteAssetAmountFilled: 200,
				baseAssetAmountFilled: 2,
				takerExistingQuoteEntryAmount: 100,
				takerExistingBaseAssetAmount: 1,
				makerExistingQuoteEntryAmount: 150,
				makerExistingBaseAssetAmount: 1,
				takerFee: 10,
				makerFee: 5,
				takerOrderDirection: 'short',
				makerOrderDirection: 'long',
			} as any;

			const takerResult = calculatePnlFromTrade(trade, true, 'taker');
			const makerResult = calculatePnlFromTrade(trade, true, 'maker');

			// Taker: (200/2 - 100/1) * 1 - 10 = -10
			const expectedTakerPnl = new Decimal(200)
				.div(2)
				.minus(new Decimal(100).div(1))
				.mul(1)
				.minus(10)
				.toSignificantDigits(QUOTE_PRECISION_EXP.toNumber());

			// Maker: (150/1 - 200/2) * 1 - 5 = 45
			const expectedMakerPnl = new Decimal(150)
				.div(1)
				.minus(new Decimal(200).div(2))
				.mul(1)
				.minus(5)
				.toSignificantDigits(QUOTE_PRECISION_EXP.toNumber());

			expect(takerResult.equals(expectedTakerPnl)).toBe(true);
			expect(makerResult.equals(expectedMakerPnl)).toBe(true);
			expect(takerResult.equals(makerResult)).toBe(false);
		});
	});
});
