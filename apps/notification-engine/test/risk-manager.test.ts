import { NotificationType, RiskBucket } from '@backend/common';
import { User } from '@velocity-exchange/sdk';
import { RiskManager } from '../src/services/risk-manager';

const mockGet = jest.fn();
const mockGetAccountRisk = jest.fn();
const mockUpdateAccountRisk = jest.fn();
const mockBatchUpdateAccountRisk = jest.fn();
const mockGenerateAccountUpdateKey = jest.fn();
jest.mock('@backend/redis', () => ({
	Redis: jest.fn(() => ({
		get: mockGet,
	})),
	RiskRepository: jest.fn(() => ({
		batchUpdateAccountRisk: mockBatchUpdateAccountRisk,
		updateAccountRisk: mockUpdateAccountRisk,
		getAccountRisk: mockGetAccountRisk,
		generateAccountUpdateKey: mockGenerateAccountUpdateKey.mockImplementation(
			(userId) => `account:${userId}`
		),
	})),
}));

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	isFeatureEnabled: jest.fn().mockReturnValue(true),
	getTimestamp: jest.fn().mockReturnValue(1000000000),
}));

const mockGetMessages = jest.fn();
const mockDeleteMessages = jest.fn();
jest.mock('@backend/sqs', () => ({
	SQS: jest.fn(() => ({
		getMessages: mockGetMessages,
		deleteMessages: mockDeleteMessages,
	})),
}));

const mockInitializeUserPosition = jest.fn();
const mockUpdatePrice = jest.fn();
const mockUpdatePosition = jest.fn();
jest.mock('../src/services/position-tracker', () => ({
	PositionTracker: jest.fn(() => ({
		initializeUserPosition: mockInitializeUserPosition,
		updatePrice: mockUpdatePrice,
		updatePosition: mockUpdatePosition,
	})),
}));

describe('RiskManager', () => {
	const {
		determineRiskBucket,
		isSignificantHealthChange,
		getUserFromUsermap,
		loadAccountStates,
		processMessage,
		processBatch,
		processUserRisk,
		getNotificationQueue,
	} = RiskManager({
		isRunning: true,
		collectStats: false,
		usePositionTracker: false,
	});

	let getHealthSpy = jest.spyOn(User.prototype, 'getHealth').mockReturnValue(75);
	const getHealthComponentsSpy = jest
		.spyOn(User.prototype, 'getHealthComponents')
		.mockReturnValue({ perpPnl: [], perpPositions: [], deposits: [], borrows: [] });
	const subscribeSpy = jest.spyOn(User.prototype, 'subscribe').mockResolvedValue(true);

	const user = '9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S';
	// Zero-filled User account sized to the current on-chain layout
	// (User::SIZE = 4496, programs/velocity/src/state/user.rs). All positions/orders are
	// zero so decodeUser returns an empty account without overrunning the buffer;
	// getHealth/getHealthComponents/subscribe are mocked below, so the fixture only needs
	// to be the right size. The `<slot>::` prefix mirrors the usermap-server payload format.
	const mockBuffer = `319637320::${Buffer.alloc(4496).toString('base64')}`;

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('determineRiskBucket', () => {
		const testCases = [
			{ health: 90, expected: RiskBucket.HEALTHY },
			{ health: 60, expected: RiskBucket.MODERATE },
			{ health: 40, expected: RiskBucket.AT_RISK },
			{ health: 15, expected: RiskBucket.CRITICAL },
			{ health: 6, expected: RiskBucket.CRITICAL },
			{ health: 3, expected: RiskBucket.LIQUIDATABLE },
		];

		test.each(testCases)('returns $expected for health $health', ({ health, expected }) => {
			const result = determineRiskBucket(health);
			expect(result).toBe(expected);
		});
	});

	describe('isSignificantHealthChange', () => {
		test.each([
			[
				15,
				13,
				RiskBucket.CRITICAL,
				RiskBucket.CRITICAL,
				true,
				'significant decrease in CRITICAL',
			],
			[
				15,
				13.5,
				RiskBucket.CRITICAL,
				RiskBucket.CRITICAL,
				false,
				'small decrease in CRITICAL',
			],
			[
				13,
				15,
				RiskBucket.CRITICAL,
				RiskBucket.CRITICAL,
				true,
				'significant increase in CRITICAL',
			],
			[
				35,
				33,
				RiskBucket.AT_RISK,
				RiskBucket.AT_RISK,
				true,
				'significant decrease in AT_RISK',
			],
			[35, 33.5, RiskBucket.AT_RISK, RiskBucket.AT_RISK, false, 'small decrease in AT_RISK'],
			[
				33,
				35,
				RiskBucket.AT_RISK,
				RiskBucket.AT_RISK,
				true,
				'significant increase in AT_RISK',
			],
			[
				50,
				48,
				RiskBucket.HEALTHY,
				RiskBucket.HEALTHY,
				true,
				'significant decrease in HEALTHY',
			],
			[50, 48.5, RiskBucket.HEALTHY, RiskBucket.HEALTHY, false, 'small decrease in HEALTHY'],
			[
				5,
				4,
				RiskBucket.LIQUIDATABLE,
				RiskBucket.LIQUIDATABLE,
				true,
				'significant decrease in LIQUIDATABLE',
			],
			[
				5,
				4.5,
				RiskBucket.LIQUIDATABLE,
				RiskBucket.LIQUIDATABLE,
				false,
				'small decrease in LIQUIDATABLE',
			],
			[
				4,
				5,
				RiskBucket.LIQUIDATABLE,
				RiskBucket.LIQUIDATABLE,
				true,
				'significant increase in LIQUIDATABLE',
			],
			[
				15,
				14.9,
				RiskBucket.CRITICAL,
				RiskBucket.AT_RISK,
				true,
				'risk bucket changed from CRITICAL to AT_RISK',
			],
			[
				35,
				34.9,
				RiskBucket.AT_RISK,
				RiskBucket.HEALTHY,
				true,
				'risk bucket changed from AT_RISK to HEALTHY',
			],
			[
				10,
				9.9,
				RiskBucket.AT_RISK,
				RiskBucket.LIQUIDATABLE,
				true,
				'risk bucket changed from AT_RISK to LIQUIDATABLE',
			],
		])(
			'returns %s for oldHealth=%s, newHealth=%s, oldBucket=%s, newBucket=%s',
			(oldHealth, newHealth, oldBucket, newBucket, expected, _description) => {
				expect(isSignificantHealthChange(oldHealth, newHealth, oldBucket, newBucket)).toBe(
					expected
				);
			}
		);
	});

	describe('addToNotificationQueue', () => {
		const { getNotificationQueue, addToNotificationQueue, resetNotificationQueue } =
			RiskManager();

		beforeEach(() => {
			resetNotificationQueue();
		});

		test('adds notification when account enters CRITICAL from HEALTHY', () => {
			addToNotificationQueue('user1', RiskBucket.HEALTHY, RiskBucket.CRITICAL, 35);

			expect(getNotificationQueue()).toHaveLength(1);
			expect(getNotificationQueue()[0]).toEqual({
				user: 'user1',
				oldBucket: RiskBucket.HEALTHY,
				newBucket: RiskBucket.CRITICAL,
				healthRatio: 35,
				timestamp: 1000000000,
			});
		});

		test('adds notification when account enters CRITICAL from MODERATE', () => {
			addToNotificationQueue('user1', RiskBucket.MODERATE, RiskBucket.CRITICAL, 35);
			expect(getNotificationQueue()).toHaveLength(1);
		});

		test('does not add notification when account is already in CRITICAL', () => {
			addToNotificationQueue('user1', RiskBucket.CRITICAL, RiskBucket.CRITICAL, 35);
			expect(getNotificationQueue()).toHaveLength(0);
		});

		test('does not add notification when account moves from LIQUIDATABLE to CRITICAL', () => {
			addToNotificationQueue('user1', RiskBucket.LIQUIDATABLE, RiskBucket.CRITICAL, 15);
			expect(getNotificationQueue()).toHaveLength(0);
		});

		test('does not add notification when account becomes LIQUIDATABLE', () => {
			addToNotificationQueue('user1', RiskBucket.CRITICAL, RiskBucket.LIQUIDATABLE, 5);
			expect(getNotificationQueue()).toHaveLength(0);
		});
	});

	describe('getUserFromUsermap', () => {
		test('gets user data', async () => {
			mockGet.mockResolvedValue(mockBuffer);

			const result = await getUserFromUsermap(user);

			expect(subscribeSpy).toHaveBeenCalled();
			expect(getHealthSpy).toHaveBeenCalled();
			expect(getHealthComponentsSpy).toHaveBeenCalledWith({
				marginCategory: 'Maintenance',
			});

			expect(result?.healthRatio).toBe(75);
			expect(result?.riskBucket).toBe('MODERATE');
			expect(result?.positions).toEqual({
				perpPnl: [],
				perpPositions: [],
				deposits: [],
				borrows: [],
			});
		});
	});

	describe('loadAccountStates', () => {
		const mockusers = [
			'9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S',
			'9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S',
			'9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S',
		];

		test('loads accounts without position manager', async () => {
			const _result = await loadAccountStates(mockusers);

			expect(mockInitializeUserPosition).toHaveBeenCalledTimes(3);
			expect(mockInitializeUserPosition).toHaveBeenCalledWith(
				'9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S',
				{
					borrows: [],
					deposits: [],
					perpPnl: [],
					perpPositions: [],
				}
			);

			expect(mockBatchUpdateAccountRisk.mock.calls[0][0]).toHaveLength(3);
			expect(mockBatchUpdateAccountRisk).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({
						user: '9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S',
						healthRatio: 75,
						riskBucket: 'MODERATE',
						lastUpdated: expect.any(Number),
					}),
				])
			);
		});
	});

	describe('processMessage', () => {
		test('handles messages without body', async () => {
			const mockMessage = {
				MessageId: '1',
				ReceiptHandle: 'receipt1',
			};

			const result = await processMessage(mockMessage);
			expect(result.status).toBe('skipped');
		});

		test('processes price alert message', async () => {
			const mockMessage = {
				MessageId: '1',
				ReceiptHandle: 'receipt1',
				Body: JSON.stringify({
					Message: JSON.stringify({
						type: NotificationType.PRICE_ALERT,
						data: { symbol: 'SOL-PERP', price: 100 },
					}),
				}),
			};

			mockGetAccountRisk.mockResolvedValue({ riskBucket: 'MODERATE' });
			mockUpdatePrice.mockReturnValue([user]);

			const result = await processMessage(mockMessage);

			expect(mockUpdatePrice).toHaveBeenCalledWith({ price: 100, symbol: 'SOL-PERP' });
			expect(result.status).toBe('success');
			expect(result.processedMessage).toEqual({
				Id: '1',
				ReceiptHandle: 'receipt1',
			});
		});

		test('processes position update message', async () => {
			const newUser = 'newUserTest';
			const mockMessage = {
				MessageId: '1',
				ReceiptHandle: 'receipt1',
				Body: JSON.stringify({
					Message: JSON.stringify({
						type: NotificationType.RECORD_UPDATE,
						data: { user: { S: newUser }, marketIndex: { N: 0 } },
					}),
				}),
			};

			const result = await processMessage(mockMessage);

			expect(mockUpdatePosition).toHaveBeenCalledWith({
				user: newUser,
			});
			expect(result.status).toBe('success');
		});
	});

	describe('processBatch', () => {
		test('handles empty message queue', async () => {
			mockGetMessages.mockResolvedValue([]);

			const result = await processBatch();

			expect(result).toEqual({
				processed: 0,
				succeeded: 0,
				failed: 0,
				skipped: 0,
			});
			expect(mockDeleteMessages).not.toHaveBeenCalled();
		});

		test('processes a batch of messages successfully', async () => {
			const mockMessages = [
				{
					MessageId: '1',
					ReceiptHandle: 'receipt1',
					Body: JSON.stringify({
						Message: JSON.stringify({
							type: NotificationType.PRICE_ALERT,
							data: { symbol: 'SOL-PERP', price: 100 },
						}),
					}),
				},
				{
					MessageId: '2',
					ReceiptHandle: 'receipt2',
					Body: JSON.stringify({
						Message: JSON.stringify({
							type: NotificationType.RECORD_UPDATE,
							data: { user: { S: user } },
						}),
					}),
				},
			];

			mockGetMessages.mockResolvedValue(mockMessages);
			mockUpdatePrice.mockReturnValue([]);
			mockDeleteMessages.mockResolvedValue([]);

			const result = await processBatch();

			expect(result).toEqual({
				processed: 2,
				succeeded: 2,
				failed: 0,
				skipped: 0,
			});

			expect(mockDeleteMessages).toHaveBeenCalledWith([
				{
					Id: '1',
					ReceiptHandle: 'receipt1',
				},
				{
					Id: '2',
					ReceiptHandle: 'receipt2',
				},
			]);
		});

		test('handles failed message processing', async () => {
			const mockMessages = [
				{
					MessageId: '1',
					ReceiptHandle: 'receipt1',
					Body: JSON.stringify({
						Message: JSON.stringify({
							type: NotificationType.PRICE_ALERT,
							data: { symbol: 'SOL-PERP', price: 100 },
						}),
					}),
				},
				// This will cause an error during processing
				{
					MessageId: '2',
					ReceiptHandle: 'receipt2',
				},
			];

			mockGetMessages.mockResolvedValue(mockMessages);
			mockUpdatePrice.mockReturnValue([]);
			mockDeleteMessages.mockResolvedValue([]);

			const result = await processBatch();

			expect(result).toEqual({
				processed: 2,
				succeeded: 1,
				failed: 0,
				skipped: 1,
			});

			expect(mockDeleteMessages).toHaveBeenCalledWith([
				{
					Id: '1',
					ReceiptHandle: 'receipt1',
				},
			]);
		});
	});

	describe('processUserRisk', () => {
		test('does not add notification when staying in same bucket', async () => {
			mockGetAccountRisk.mockResolvedValue({
				riskBucket: RiskBucket.MODERATE,
				healthRatio: 75,
			});
			mockGet.mockResolvedValue(mockBuffer);

			await processUserRisk(user);

			expect(getNotificationQueue()).toHaveLength(0);
			expect(mockUpdateAccountRisk).not.toHaveBeenCalled();
		});

		test('updates with significant changes', async () => {
			mockGetAccountRisk.mockResolvedValue({
				riskBucket: RiskBucket.MODERATE,
				healthRatio: 15,
			});
			mockGet.mockResolvedValue(mockBuffer);

			await processUserRisk(user);

			expect(getNotificationQueue()).toHaveLength(0);
			expect(mockUpdateAccountRisk).toHaveBeenCalledWith(
				'9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S',
				RiskBucket.MODERATE,
				{ healthRatio: 75, lastUpdated: 1000000000, riskBucket: 'MODERATE' }
			);
		});

		test('does add notification when moving bucket', async () => {
			getHealthSpy = jest.spyOn(User.prototype, 'getHealth').mockReturnValue(10);

			mockGetAccountRisk.mockResolvedValue({
				riskBucket: RiskBucket.MODERATE,
				healthRatio: 75,
			});
			mockGet.mockResolvedValue(mockBuffer);

			await processUserRisk(user);

			expect(getNotificationQueue()).toEqual([
				{
					healthRatio: 10,
					newBucket: 'CRITICAL',
					oldBucket: 'MODERATE',
					timestamp: 1000000000,
					user: '9qD4nu8BHktScBXcTuVCh5AEbn4ur2Hun2bSDXheH92S',
				},
			]);

			expect(mockUpdateAccountRisk).toHaveBeenCalledWith(user, RiskBucket.MODERATE, {
				healthRatio: 10,
				riskBucket: RiskBucket.CRITICAL,
				lastUpdated: 1000000000,
			});
		});
	});
});
