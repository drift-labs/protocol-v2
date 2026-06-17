import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
	BaseDynamoRecord,
	enumToStr,
	getTimestamp,
	LiquidationRecord,
	NotificationChannel,
	NotificationStatus,
	NotificationType,
	RecordTypes,
} from '@backend/common';
import { OrderTriggerCondition, OrderType } from '@velocity-exchange/sdk';
import { RecordProcessor } from '../../src/processors/record-processor';

const mockGet = jest.fn();
const mockPut = jest.fn();
const mockCreateNotifications = jest.fn();
const mockGetLastNotifcation = jest.fn();
const mockGetRecordKeys = jest.fn();
const mockGetOrderRecordById = jest.fn();

jest.mock('@backend/dynamodb', () => ({
	...jest.requireActual('@backend/dynamodb'),
	DynamoDB: () => ({
		get: mockGet,
		put: mockPut,
	}),
	NotificationRepository: () => ({
		getLastNotificationByType: mockGetLastNotifcation,
		createNotifications: mockCreateNotifications,
	}),
	OrderRepository: () => ({
		getOrderRecordById: mockGetOrderRecordById,
	}),
	getRecordKeys: () => mockGetRecordKeys(),
	getOrderRecordPrimaryKeys: () => mockGetRecordKeys(),
}));

describe('RecordProcessor', () => {
	const { processRecord } = RecordProcessor();

	beforeEach(() => {
		jest.clearAllMocks();
		process.env.ENABLE_TRADE_RECORD_NOTIFICATIONS = 'true';
		process.env.TRADE_RECORD_NOTIFICATION_WHITELIST =
			'C13FZykQfLXKuMAMh2iuG7JxhQqd8otujNRAgVETU6id';
		mockGet.mockResolvedValue({ Item: null });
		mockGetOrderRecordById.mockResolvedValue(null);
		mockGetRecordKeys.mockReturnValue({
			pk: 'ORDER#123',
			sk: 'USER#456',
		});
	});

	afterEach(() => {
		delete process.env.ENABLE_TRADE_RECORD_NOTIFICATIONS;
		delete process.env.TRADE_RECORD_NOTIFICATION_WHITELIST;
	});

	const createRecord = (newImage: Record<string, any>) => {
		return {
			...unmarshall({
				pk: {
					S: 'USER#C13FZykQfLXKuMAMh2iuG7JxhQqd8otujNRAgVETU6id',
				},
				sk: {
					S: 'TRADE#TS#1738119113#SLOT#317044856#SIG#2w7XjuwWHFBa7kFHqVFZNVofCrSDmeZu7uhy1uGjYDqkS2geS37tX23EV5msf224ka7wpvDYiwhC7Cv9z1tDqzwj#INDEX#00002',
				},
				action: {
					S: 'fill',
				},
				actionExplanation: {
					S: 'orderFilledWithAmmJit',
				},
				baseAssetAmountFilled: {
					N: '1.72',
				},
				createdAt: {
					N: '1738119142',
				},
				entity: {
					S: 'user',
				},
				filler: {
					S: 'C13FZykQfLXKuMAMh2iuG7JxhQqd8otujNRAgVETU6id',
				},
				fillerReward: {
					N: '0',
				},
				fillRecordId: {
					S: '9530732',
				},
				GSI1PK: {
					S: 'USER#C13FZykQfLXKuMAMh2iuG7JxhQqd8otujNRAgVETU6id',
				},
				GSI1SK: {
					S: 'TRADE#MARKET#SOL-PERP#TS#1738119113#SLOT#317044856#SIG#2w7XjuwWHFBa7kFHqVFZNVofCrSDmeZu7uhy1uGjYDqkS2geS37tX23EV5msf224ka7wpvDYiwhC7Cv9z1tDqzwj#INDEX#00002',
				},
				maker: {
					NULL: true,
				},
				makerFee: {
					N: '0',
				},
				makerOrderBaseAssetAmount: {
					N: '0',
				},
				makerOrderCumulativeBaseAssetAmountFilled: {
					N: '0',
				},
				makerOrderCumulativeQuoteAssetAmountFilled: {
					N: '0',
				},
				makerOrderDirection: {
					NULL: true,
				},
				makerOrderId: {
					NULL: true,
				},
				makerRebate: {
					N: '0',
				},
				marketFilter: {
					S: 'perp',
				},
				marketIndex: {
					N: '0',
				},
				marketType: {
					S: 'perp',
				},
				oraclePrice: {
					N: '230.167352',
				},
				quoteAssetAmountFilled: {
					N: '396.19684',
				},
				quoteAssetAmountSurplus: {
					N: '-0.460333',
				},
				referrerReward: {
					N: '0',
				},
				slot: {
					N: '317044856',
				},
				source: {
					S: 'seq',
				},
				spotFulfillmentMethodFee: {
					N: '0',
				},
				symbol: {
					S: 'SOL-PERP',
				},
				taker: {
					S: 'C13FZykQfLXKuMAMh2iuG7JxhQqd8otujNRAgVETU6id',
				},
				takerFee: {
					N: '0.029715',
				},
				takerOrderBaseAssetAmount: {
					N: '10.9',
				},
				takerOrderCumulativeBaseAssetAmountFilled: {
					N: '10.9',
				},
				takerOrderCumulativeQuoteAssetAmountFilled: {
					N: '2510.7823',
				},
				takerOrderDirection: {
					S: 'short',
				},
				takerOrderId: {
					N: '288496271',
				},
				ts: {
					N: `${getTimestamp()}`,
				},
				ttl: {
					N: '1740797513',
				},
				txSig: {
					S: '2w7XjuwWHFBa7kFHqVFZNVofCrSDmeZu7uhy1uGjYDqkS2geS37tX23EV5msf224ka7wpvDYiwhC7Cv9z1tDqzwj',
				},
				txSigIndex: {
					N: '2',
				},
				user: {
					S: 'C13FZykQfLXKuMAMh2iuG7JxhQqd8otujNRAgVETU6id',
				},
				userOrderId: {
					N: '288496271',
				},
			}),
			...newImage,
		};
	};

	describe('Trade/Prediction', () => {
		const authorityId = 'BxTExiVRt9EHe4b47ZDQLDGxee1hPexvkmaDFMLZTDvv';

		beforeEach(() => {
			mockGet.mockResolvedValue({
				Item: {
					authority: authorityId,
				},
			});
		});

		it.each([
			[
				'limit',
				{
					orderType: enumToStr(OrderType.LIMIT),
					price: 50000,
					oraclePriceOffset: 0,
				},
				'Limit Order Filled',
				'Your Limit Order of 10.9 SOL-PERP at $230.347 has been filled',
				230.347,
			],
			[
				'stop market',
				{
					orderType: enumToStr(OrderType.TRIGGER_MARKET),
					price: 0,
					triggerPrice: 50000,
					triggerCondition: enumToStr(OrderTriggerCondition.BELOW),
				},
				'SL Market Order Filled',
				'Your SL Market Order of 10.9 SOL-PERP at $230.347 has been filled',
				230.347,
			],
			[
				'stop limit',
				{
					orderType: enumToStr(OrderType.TRIGGER_LIMIT),
					price: 50000,
					triggerPrice: 49000,
					triggerCondition: enumToStr(OrderTriggerCondition.BELOW),
				},
				'SL Limit Order Filled',
				'Your SL Limit Order of 10.9 SOL-PERP at $230.347 has been filled',
				230.347,
			],
			[
				'take profit market',
				{
					orderType: enumToStr(OrderType.TRIGGER_MARKET),
					price: 0,
					triggerPrice: 50000,
					triggerCondition: enumToStr(OrderTriggerCondition.ABOVE),
				},
				'TP Market Order Filled',
				'Your TP Market Order of 10.9 SOL-PERP at $230.347 has been filled',
				230.347,
			],
			[
				'take profit limit',
				{
					orderType: enumToStr(OrderType.TRIGGER_LIMIT),
					price: 50000,
					triggerPrice: 51000,
					triggerCondition: enumToStr(OrderTriggerCondition.ABOVE),
				},
				'TP Limit Order Filled',
				'Your TP Limit Order of 10.9 SOL-PERP at $230.347 has been filled',
				230.347,
			],
			[
				'oracle limit',
				{
					orderType: enumToStr(OrderType.LIMIT),
					price: 50000,
					oraclePriceOffset: 1000,
				},
				'Oracle Limit Order Filled',
				'Your Oracle Limit Order of 10.9 SOL-PERP at $230.347 has been filled',
				230.347,
			],
		])(
			'should process a fully filled %s order',
			async (_, mockOrder, expectedTitle, expectedBody, expectedPrice) => {
				const mockRecord = createRecord({}) as BaseDynamoRecord;
				mockGetOrderRecordById.mockResolvedValue(mockOrder);

				await processRecord(mockRecord as any);

				expect(mockCreateNotifications).toHaveBeenCalledWith([
					expect.objectContaining({
						authorityId,
						user: 'C13FZykQfLXKuMAMh2iuG7JxhQqd8otujNRAgVETU6id',
						type: NotificationType.RECORD_UPDATE,
						status: NotificationStatus.PENDING,
						title: expectedTitle,
						body: expectedBody,
						channels: [NotificationChannel.APP, NotificationChannel.PUSH],
						data: expect.objectContaining({
							symbol: 'SOL-PERP',
							direction: 'SHORT',
							size: 10.9,
							price: expectedPrice,
							recordType: RecordTypes.TradeRecord,
						}),
						createdAt: expect.any(Number),
					}),
				]);
			}
		);

		it('should skip processing for partially filled orders', async () => {
			const mockRecord = createRecord({
				takerOrderBaseAssetAmount: 20,
			}) as BaseDynamoRecord;

			await processRecord(mockRecord as any);

			expect(mockGetOrderRecordById).not.toHaveBeenCalled();
			expect(mockCreateNotifications).not.toHaveBeenCalled();
		});

		it('should skip trade record notifications when feature is disabled', async () => {
			process.env.ENABLE_TRADE_RECORD_NOTIFICATIONS = 'false';
			process.env.TRADE_RECORD_NOTIFICATION_WHITELIST = '';
			const mockRecord = createRecord({}) as BaseDynamoRecord;

			await processRecord(mockRecord as any);

			expect(mockGetOrderRecordById).not.toHaveBeenCalled();
			expect(mockCreateNotifications).not.toHaveBeenCalled();
		});

		it('should process trade record notifications for a whitelisted user even when feature is disabled', async () => {
			process.env.ENABLE_TRADE_RECORD_NOTIFICATIONS = 'false';
			const mockRecord = createRecord({}) as BaseDynamoRecord;
			mockGetOrderRecordById.mockResolvedValue({
				orderType: enumToStr(OrderType.LIMIT),
				price: 50000,
				oraclePriceOffset: 0,
			});

			await processRecord(mockRecord as any);

			expect(mockCreateNotifications).toHaveBeenCalled();
		});

		it('should skip trade record notifications when user is not whitelisted', async () => {
			process.env.TRADE_RECORD_NOTIFICATION_WHITELIST =
				'NotTheUser111111111111111111111111111111111111';
			const mockRecord = createRecord({}) as BaseDynamoRecord;

			await processRecord(mockRecord as any);

			expect(mockGetOrderRecordById).not.toHaveBeenCalled();
			expect(mockCreateNotifications).not.toHaveBeenCalled();
		});

		it('should use maker direction when the projected user is the maker', async () => {
			const makerUser = 'Maker111111111111111111111111111111111111111';
			process.env.TRADE_RECORD_NOTIFICATION_WHITELIST = makerUser;
			const mockRecord = createRecord({
				user: makerUser,
				userOrderId: 918273,
				maker: makerUser,
				makerOrderId: 918273,
				makerOrderDirection: 'long',
				makerOrderBaseAssetAmount: 10.9,
				makerOrderCumulativeBaseAssetAmountFilled: 10.9,
				makerOrderCumulativeQuoteAssetAmountFilled: 2510.7823,
			}) as BaseDynamoRecord;

			mockGetOrderRecordById.mockResolvedValue({
				orderType: enumToStr(OrderType.LIMIT),
				price: 50000,
				oraclePriceOffset: 0,
			});

			await processRecord(mockRecord as any);

			expect(mockGetOrderRecordById).toHaveBeenCalledWith({
				user: makerUser,
				orderId: 918273,
			});
			expect(mockCreateNotifications).toHaveBeenCalledWith([
				expect.objectContaining({
					user: makerUser,
					data: expect.objectContaining({
						direction: 'LONG',
						size: 10.9,
						price: 230.347,
					}),
				}),
			]);
		});

		it('should skip unsupported order labels', async () => {
			const mockRecord = createRecord({}) as BaseDynamoRecord;
			mockGetOrderRecordById.mockResolvedValue({
				orderType: 'MARKET',
			});

			await processRecord(mockRecord as any);

			expect(mockCreateNotifications).not.toHaveBeenCalled();
		});

		it('should throw when order is not found', async () => {
			const mockRecord = createRecord({}) as BaseDynamoRecord;

			await expect(processRecord(mockRecord as any)).rejects.toThrow(
				'Order not found for user: C13FZykQfLXKuMAMh2iuG7JxhQqd8otujNRAgVETU6id, userOrderId: 288496271'
			);
			expect(mockCreateNotifications).not.toHaveBeenCalled();
		});

		it('should handle notification creation errors', async () => {
			const mockRecord = createRecord({}) as BaseDynamoRecord;
			mockGetOrderRecordById.mockResolvedValue({
				orderType: enumToStr(OrderType.TRIGGER_LIMIT),
				price: 50000,
				triggerPrice: 49000,
				triggerCondition: enumToStr(OrderTriggerCondition.BELOW),
			});
			mockCreateNotifications.mockRejectedValueOnce(new Error('Notification error'));

			await expect(processRecord(mockRecord as any)).rejects.toThrow('Notification error');
		});
	});

	describe('Liquidation', () => {
		it('should process a liquidation record successfully with actions', async () => {
			const mockRecord = createRecord({
				sk: 'LIQUIDATION#TS#1738119113#SLOT#317044856#SIG#2w7XjuwWHFBa7kFHqVFZNVofCrSDmeZu7uhy1uGjYDqkS2geS37tX23EV5msf224ka7wpvDYiwhC7Cv9z1tDqzwj#INDEX#00002',
			}) as LiquidationRecord & BaseDynamoRecord;

			mockGet.mockResolvedValueOnce({
				Item: {
					authority: 'BxTExiVRt9EHe4b47ZDQLDGxee1hPexvkmaDFMLZTDvv',
				},
			});

			await processRecord(mockRecord);

			expect(mockCreateNotifications).toHaveBeenCalledWith([
				expect.objectContaining({
					authorityId: 'BxTExiVRt9EHe4b47ZDQLDGxee1hPexvkmaDFMLZTDvv',
					user: 'C13FZykQfLXKuMAMh2iuG7JxhQqd8otujNRAgVETU6id',
					type: NotificationType.RECORD_UPDATE,
					status: 'PENDING',
					title: 'Liquidation called!',
					body: 'We regret to inform you that your cross account has been triggered into liquidation.',
					channels: [NotificationChannel.APP, NotificationChannel.PUSH],
					data: expect.objectContaining({
						recordType: RecordTypes.LiquidationRecord,
					}),
					actions: [
						{
							label: 'View your account',
							link: 'https://app.drift.trade/overview',
						},
					],
					createdAt: expect.any(Number),
				}),
			]);
		});

		it('should not process liquidation record when age check fails', async () => {
			const oldRecord = createRecord({
				sk: 'LIQUIDATION#TS#1738119113#SLOT#317044856#SIG#2w7XjuwWHFBa7kFHqVFZNVofCrSDmeZu7uhy1uGjYDqkS2geS37tX23EV5msf224ka7wpvDYiwhC7Cv9z1tDqzwj#INDEX#00002',
				ts: 1000000000, // Very old timestamp
			}) as LiquidationRecord & BaseDynamoRecord;

			await processRecord(oldRecord);

			// Should not attempt to get authority or create notifications
			expect(mockGet).not.toHaveBeenCalled();
			expect(mockCreateNotifications).not.toHaveBeenCalled();
		});

		it('should not process liquidation record when in cooldown period', async () => {
			const mockRecord = createRecord({
				sk: 'LIQUIDATION#TS#1738119113#SLOT#317044856#SIG#2w7XjuwWHFBa7kFHqVFZNVofCrSDmeZu7uhy1uGjYDqkS2geS37tX23EV5msf224ka7wpvDYiwhC7Cv9z1tDqzwj#INDEX#00002',
			}) as LiquidationRecord & BaseDynamoRecord;

			mockGet.mockResolvedValueOnce({
				Item: {
					authority: 'BxTExiVRt9EHe4b47ZDQLDGxee1hPexvkmaDFMLZTDvv',
				},
			});

			const recentTime = getTimestamp() - 300; // 5 minutes ago
			mockGetLastNotifcation.mockResolvedValue({
				notificationId: 'recent-notification',
				type: NotificationType.RECORD_UPDATE,
				status: NotificationStatus.PENDING,
				createdAt: recentTime,
			});

			await processRecord(mockRecord);

			expect(mockGet).toHaveBeenCalled();
			expect(mockCreateNotifications).not.toHaveBeenCalled();
		});
	});
});
