import { getTimestamp } from '@backend/common';
import { OracleFeed } from '../src/services/oracle-feed';

const mockPublishMessage = jest.fn();
jest.mock('@backend/sns', () => ({
	SNS: () => ({
		publishMessage: mockPublishMessage,
	}),
}));

jest.mock('@velocity-exchange/sdk', () => ({
	...jest.requireActual('@velocity-exchange/sdk'),
	initialize: jest.fn(() => ({
		SPOT_MARKETS: [
			{
				symbol: 'JLP',
				marketIndex: 1,
				oracle: { toString: () => '5Mb11e5rt1Sp6A286B145E4TmgMzsM2UX9nCF2vas5bs' },
				oracleSource: { pythLazer: {} },
			},
			{
				symbol: 'dSOL',
				marketIndex: 1,
				oracle: { toString: () => '4YstsHafLyDbYFxmJbgoEr33iJJEp6rNPgLTQRgXDkG2' },
				oracleSource: { pythLazer: {} },
			},
		],
		PERP_MARKETS: [
			{
				symbol: 'SOL-PERP',
				marketIndex: 0,
				oracle: { toString: () => 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG' },
				oracleSource: { pyth: {} },
			},
		],
	})),
}));

jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	getTimestamp: jest.fn(),
	DEFAULT_SNS_TOPIC: 'arn:aws:sns:eu-west-1:011528263343:NotificationTest',
}));

jest.mock('@velocity-exchange/sdk/lib/node/oracles/oracleClientCache', () => ({
	OracleClientCache: jest.fn().mockImplementation(() => ({
		get: jest.fn().mockReturnValue({
			getOraclePriceDataFromBuffer: jest.fn((_buffer) => ({
				price: '170084',
				confidence: '963',
				slot: '315759744',
			})),
		}),
	})),
}));

describe('OracleFeed', () => {
	const {
		handleStreamData,
		shouldPublishPrice,
		publishToSNS,
		setLastPrices,
		getLastPrices,
		resetLastPrices,
	} = OracleFeed();

	beforeEach(() => {
		jest.clearAllMocks();
		process.env.SNS_TOPIC_ARN = 'test-topic-arn';
		process.env.PRICE_THRESHOLD = '0.001';
		process.env.MIN_UPDATE_INTERVAL_MS = '5';
		(getTimestamp as jest.Mock).mockReturnValue(1000000000);
	});

	describe('handleStreamData', () => {
		it('should process and publish valid oracle data', async () => {
			const mockChunk = {
				filters: ['account'],
				account: {
					account: {
						pubkey: Buffer.from(
							'40b4cedaaf84d2208ddef1f84eabf2752dc8fc626564b53aeeb322e7b41277b6',
							'hex'
						),
						lamports: '1823520',
						owner: Buffer.from(
							'e036d0100c646c3c8715b460aa9c5a7a0f5334d9c8073e679f7bff71b824f8d9',
							'hex'
						),
						executable: false,
						rentEpoch: '18446744073709551615',
						data: Buffer.from([
							0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd, 0x43, 0xa9, 0x26, 0x4d,
							0x3e, 0xf2, 0xc0, 0xa5, 0xec, 0xe0, 0x11, 0x4f, 0x87, 0xc2, 0xa8, 0x67,
							0x45, 0xd1, 0x02, 0x66, 0xa2, 0x73, 0x0b, 0xcb, 0xac, 0x3b, 0x0a, 0xac,
							0x4f, 0x54, 0xa6, 0xb3, 0x00, 0x02, 0x65, 0x6c, 0xc2, 0xa3, 0x9d, 0xd7,
							0x95, 0xbd, 0xec, 0xb5, 0x9d, 0xe8, 0x10, 0xd4, 0xf4, 0xd1, 0xe7, 0x4c,
							0x25, 0xfe, 0x4c, 0x42, 0xd0, 0xbf, 0x1c, 0x65, 0xa3, 0x8d, 0x74, 0xdf,
							0x48, 0xe9, 0x10, 0x87, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x82, 0x78,
							0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0xff, 0xff, 0xff, 0xb5, 0xa7,
							0x91, 0x67, 0x00, 0x00, 0x00, 0x00, 0xb4, 0xa7, 0x91, 0x67, 0x00, 0x00,
							0x00, 0x00, 0x30, 0x1a, 0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0xdb, 0xe3,
							0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x1c, 0xd2, 0x12, 0x00, 0x00,
							0x00, 0x00,
						]),
						writeVersion: '1641418363245',
						txnSignature: Buffer.from(
							'1ac891443585e9448456c6bfd232ab868e7f0909e89b2d6a6927dd986fd42e7c30a4b161f12e223d9e274039b5222ab11bdb',
							'hex'
						),
					},
					slot: '315759176',
					isStartup: false,
				},
				slot: undefined,
				transaction: undefined,
				transactionStatus: undefined,
				block: undefined,
				ping: undefined,
				pong: undefined,
				blockMeta: undefined,
				entry: undefined,
			};

			await handleStreamData(mockChunk);

			expect(mockPublishMessage).toHaveBeenCalledWith({
				message:
					'{"type":"PRICE_ALERT","data":{"oracle":"5Mb11e5rt1Sp6A286B145E4TmgMzsM2UX9nCF2vas5bs","symbol":"JLP","price":0.170084,"confidence":0.000963,"timestamp":1000000000,"slot":315759744,"priceChange":0}}',
				messageAttributes: {
					type: {
						DataType: 'String',
						StringValue: 'PRICE_ALERT',
					},
					symbol: {
						DataType: 'String',
						StringValue: 'JLP',
					},
					oracle: {
						DataType: 'String',
						StringValue: '5Mb11e5rt1Sp6A286B145E4TmgMzsM2UX9nCF2vas5bs',
					},
				},
				topicArn: 'arn:aws:sns:eu-west-1:011528263343:NotificationTest',
			});
		});

		it('should skip invalid chunks', async () => {
			const invalidChunk = {
				account: {},
			};

			await handleStreamData(invalidChunk);
			expect(mockPublishMessage).not.toHaveBeenCalled();
		});
	});

	describe('shouldPublishPrice', () => {
		it('should publish if no previous price exists', () => {
			const result = shouldPublishPrice('testPubKey', {
				slot: 12345,
				price: 100,
				confidence: 1,
			});

			expect(result).toBe(true);
		});

		it('should not publish if within minimum interval', () => {
			setLastPrices('testPubKey', {
				price: 100,
				confidence: 1,
			});

			const result = shouldPublishPrice('testPubKey', {
				slot: 12345,
				price: 101,
				confidence: 1,
			});

			expect(result).toBe(false);
		});

		it('should publish if price change exceeds threshold', async () => {
			setLastPrices('testPubKey', {
				price: 100,
				confidence: 1,
				lastPublished: getTimestamp() - 5,
			});

			const result = shouldPublishPrice('testPubKey', {
				slot: 12345,
				price: 101,
				confidence: 1,
			});

			expect(result).toBe(true);
		});

		it('should not publish if price change is below threshold', () => {
			setLastPrices('testPubKey', {
				price: 100,
				confidence: 1,
			});

			const result = shouldPublishPrice('testPubKey', {
				slot: 12345,
				price: 100.05,
				confidence: 1,
			});

			expect(result).toBe(false);
		});
	});

	describe('publishToSNS', () => {
		it('should publish price data to SNS', async () => {
			await publishToSNS('dSOL_4YstsHafLyDbYFxmJbgoEr33iJJEp6rNPgLTQRgXDkG2', {
				slot: 12345,
				price: 100,
				confidence: 1,
			});

			expect(mockPublishMessage).toHaveBeenCalledWith({
				message: `{"type":"PRICE_ALERT","data":{"oracle":"4YstsHafLyDbYFxmJbgoEr33iJJEp6rNPgLTQRgXDkG2","symbol":"dSOL","price":100,"confidence":1,"timestamp":1000000000,"slot":12345,"priceChange":0}}`,
				messageAttributes: {
					type: {
						DataType: 'String',
						StringValue: 'PRICE_ALERT',
					},
					symbol: { DataType: 'String', StringValue: 'dSOL' },
					oracle: {
						DataType: 'String',
						StringValue: '4YstsHafLyDbYFxmJbgoEr33iJJEp6rNPgLTQRgXDkG2',
					},
				},
				topicArn: 'arn:aws:sns:eu-west-1:011528263343:NotificationTest',
			});
		});

		it('should update lastPrices after publishing', async () => {
			await publishToSNS('dSOL_4YstsHafLyDbYFxmJbgoEr33iJJEp6rNPgLTQRgXDkG2', {
				slot: 12345,
				price: 100,
				confidence: 1,
			});

			expect(getLastPrices()['dSOL_4YstsHafLyDbYFxmJbgoEr33iJJEp6rNPgLTQRgXDkG2']).toEqual({
				price: 100,
				confidence: 1,
				lastPublished: expect.any(Number),
			});
		});

		it('should handle publishing errors', async () => {
			resetLastPrices();

			mockPublishMessage.mockRejectedValueOnce(new Error('SNS error'));

			await publishToSNS('4YstsHafLyDbYFxmJbgoEr33iJJEp6rNPgLTQRgXDkG2', {
				slot: 12345,
				price: 100,
				confidence: 1,
			});

			// Should not throw and should still update lastPrices
			expect(getLastPrices()['4YstsHafLyDbYFxmJbgoEr33iJJEp6rNPgLTQRgXDkG2']).toBeUndefined();
		});
	});
});
