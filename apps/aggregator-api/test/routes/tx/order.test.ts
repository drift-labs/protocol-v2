import {
	Keypair,
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import { BN, PositionDirection, PostOnlyParams, PRICE_PRECISION } from '@velocity-exchange/sdk';
import Fastify, { FastifyInstance } from 'fastify';
import ordersRoutes from '../../../src/routes/tx/order';

const mockEnsureVelocityClientSubscribed = jest.fn();
const mockGetOpenPerpMarketOrderTxn = jest.fn();
const mockGetOpenPerpNonMarketOrderTxn = jest.fn();
const mockGetCancelOrdersTxn = jest.fn();
const mockGetCancelAllOrdersTxn = jest.fn();
const mockGetUser = jest.fn();
const mockSimulateTransaction = jest.fn();
const mockHandleVelocityError = jest.fn();

jest.mock('@backend/common', () => ({
	getPerpMarkets: jest.fn(() => [
		{ symbol: 'SOL-PERP', marketIndex: 0 },
		{ symbol: 'BTC-PERP', marketIndex: 1 },
		{ symbol: 'ETH-PERP', marketIndex: 2 },
	]),
}));

describe('Orders Routes', () => {
	let app: FastifyInstance;
	const mockUserKeypair = Keypair.generate();
	const mockBlockhash = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

	const createMockTransaction = () => {
		const instruction = SystemProgram.transfer({
			fromPubkey: mockUserKeypair.publicKey,
			toPubkey: Keypair.generate().publicKey,
			lamports: 1000000,
		});

		const message = new TransactionMessage({
			payerKey: mockUserKeypair.publicKey,
			recentBlockhash: mockBlockhash,
			instructions: [instruction],
		}).compileToV0Message();

		return new VersionedTransaction(message);
	};

	const createMockSwiftOrder = () => ({
		hexEncodedSwiftOrderMessage: {
			string: 'deadbeef',
		},
		slotForSignedMsg: new BN(123),
		signedMsgOrderUuid: Uint8Array.from([1, 2, 3, 4]),
		marketIndex: 0,
		slotsTillAuctionEnd: 35,
		expirationTimeMs: 12000,
	});

	beforeEach(async () => {
		app = Fastify();

		// Mock the required properties
		(app as any).ensureVelocityClientSubscribed = mockEnsureVelocityClientSubscribed;
		(app as any).centralServerVelocity = {
			getOpenPerpMarketOrderTxn: mockGetOpenPerpMarketOrderTxn,
			getOpenPerpNonMarketOrderTxn: mockGetOpenPerpNonMarketOrderTxn,
			getCancelOrdersTxn: mockGetCancelOrdersTxn,
			getCancelAllOrdersTxn: mockGetCancelAllOrdersTxn,
			getUser: mockGetUser,
		};
		(app as any).simulateTransaction = mockSimulateTransaction;
		(app as any).handleVelocityError = mockHandleVelocityError;

		await app.register(ordersRoutes);
		await app.ready();

		// Reset mocks
		mockEnsureVelocityClientSubscribed.mockReset();
		mockGetOpenPerpMarketOrderTxn.mockReset();
		mockGetOpenPerpNonMarketOrderTxn.mockReset();
		mockGetCancelOrdersTxn.mockReset();
		mockGetCancelAllOrdersTxn.mockReset();
		mockGetUser.mockReset();
		mockSimulateTransaction.mockReset();
		mockHandleVelocityError.mockReset();

		// Default mock implementations
		mockEnsureVelocityClientSubscribed.mockResolvedValue(undefined);
		mockGetUser.mockResolvedValue({
			getUserAccount: () => ({
				authority: mockUserKeypair.publicKey,
			}),
			unsubscribe: jest.fn().mockResolvedValue(undefined),
		});
		mockSimulateTransaction.mockResolvedValue({ success: true });
		mockHandleVelocityError.mockImplementation(async (error, reply) => {
			reply.status(500).send({
				success: false,
				error: error.message,
			});
		});
	});

	afterEach(async () => {
		await app.close();
		jest.clearAllMocks();
	});

	describe('POST /order/place', () => {
		describe('Market Orders', () => {
			it('should successfully create a long market order with simulation', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'market',
						simulate: true,
					},
				});

				expect(response.statusCode).toBe(200);
				const payload = JSON.parse(response.payload);

				expect(payload).toHaveProperty('success', true);
				expect(payload).toHaveProperty('tx');

				expect(mockEnsureVelocityClientSubscribed).toHaveBeenCalledTimes(1);
				expect(mockGetOpenPerpMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						userAccountPublicKey: expect.any(PublicKey),
						useSwift: false,
						marketIndex: 0,
						direction: PositionDirection.LONG,
						amount: new BN(1000000000),
						assetType: 'base',
					})
				);
				expect(mockSimulateTransaction).toHaveBeenCalledWith(mockTx, {
					skipSimulation: false,
				});
			});

			it('should pass isolated margin mode for market orders', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'market',
						marginMode: 'isolated',
					},
				});

				expect(response.statusCode).toBe(200);
				expect(mockGetOpenPerpMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						marginMode: 'isolated',
					})
				);
			});

			it('should successfully create a short market order', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'BTC-PERP',
						direction: 'short',
						amount: '0.5',
						orderType: 'market',
					},
				});

				expect(response.statusCode).toBe(200);

				expect(mockGetOpenPerpMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						marketIndex: 1,
						direction: PositionDirection.SHORT,
					})
				);
			});

			it('should handle market order without simulation', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'market',
						simulate: false,
					},
				});

				expect(response.statusCode).toBe(200);
				const payload = JSON.parse(response.payload);

				expect(payload.message).not.toContain('simulated');
				expect(mockSimulateTransaction).toHaveBeenCalledWith(mockTx, {
					skipSimulation: true,
				});
			});

			it('should default simulate to true for market orders', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'market',
					},
				});

				expect(response.statusCode).toBe(200);
				expect(mockSimulateTransaction).toHaveBeenCalledWith(mockTx, {
					skipSimulation: false,
				});
			});

			it('should successfully create a swift market order payload', async () => {
				const mockSwiftOrder = createMockSwiftOrder();
				mockGetOpenPerpMarketOrderTxn.mockResolvedValue(mockSwiftOrder);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'market',
						useSwift: true,
					},
				});

				expect(response.statusCode).toBe(200);
				const payload = JSON.parse(response.payload);

				expect(payload).toEqual({
					success: true,
					tx: null,
					swift: {
						payload: {
							market_index: 0,
							market_type: 'perp',
							message: 'deadbeef',
							signature: '',
							signing_authority: mockUserKeypair.publicKey.toString(),
							taker_authority: mockUserKeypair.publicKey.toString(),
						},
						meta: {
							signedMsgOrderUuid: Buffer.from([1, 2, 3, 4]).toString('base64'),
							slotForSignedMsg: '123',
							slotsTillAuctionEnd: 35,
							expirationTimeMs: 12000,
						},
					},
					message:
						'Market Swift payload created successfully. Sign the message, populate swift.payload.signature with the base64 signature, and POST the payload to https://swift.velocity.exchange/orders.',
				});

				expect(mockGetOpenPerpMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						useSwift: true,
					})
				);
				expect(mockGetUser).toHaveBeenCalledWith(expect.any(PublicKey));
				expect(mockSimulateTransaction).not.toHaveBeenCalled();
			});

			it('should handle decimal amounts correctly for market orders', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1.5',
						orderType: 'market',
					},
				});

				expect(response.statusCode).toBe(200);

				expect(mockGetOpenPerpMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						amount: new BN(1500000000),
					})
				);
			});

			it('should use correct market index for different symbols', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpMarketOrderTxn.mockResolvedValue(mockTx);

				await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'ETH-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'market',
					},
				});

				expect(mockGetOpenPerpMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						marketIndex: 2,
					})
				);
			});
		});

		describe('Limit Orders', () => {
			it('should successfully create a long limit order with price', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpNonMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'limit',
						price: '100',
						simulate: true,
					},
				});

				expect(response.statusCode).toBe(200);
				const payload = JSON.parse(response.payload);

				expect(payload).toHaveProperty('success', true);
				expect(payload.message).toContain('Limit order');

				expect(mockGetOpenPerpNonMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						userAccountPublicKey: expect.any(PublicKey),
						useSwift: false,
						marketIndex: 0,
						direction: PositionDirection.LONG,
						baseAssetAmount: expect.any(BN),
						reduceOnly: false,
						postOnly: PostOnlyParams.NONE,
						orderConfig: {
							orderType: 'limit',
							limitPrice: expect.any(BN),
						},
					})
				);

				const calledConfig = mockGetOpenPerpNonMarketOrderTxn.mock.calls[0][0].orderConfig;
				expect(calledConfig.limitPrice.toString()).toBe(
					new BN(100).mul(PRICE_PRECISION).toString()
				);
			});

			it('should pass isolated margin mode for limit orders', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpNonMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'limit',
						price: '100',
						marginMode: 'isolated',
					},
				});

				expect(response.statusCode).toBe(200);
				expect(mockGetOpenPerpNonMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						marginMode: 'isolated',
					})
				);
			});

			it('should successfully create a short limit order', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpNonMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'short',
						amount: '2',
						orderType: 'limit',
						price: '95.50',
					},
				});

				expect(response.statusCode).toBe(200);

				expect(mockGetOpenPerpNonMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						direction: PositionDirection.SHORT,
					})
				);
			});

			it('should return 400 when price is missing for limit order', async () => {
				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'limit',
					},
				});

				expect(response.statusCode).toBe(400);
				const payload = JSON.parse(response.payload);

				expect(payload).toEqual({
					success: false,
					error: 'price is required for limit orders',
				});

				expect(mockGetOpenPerpNonMarketOrderTxn).not.toHaveBeenCalled();
			});

			it('should handle reduceOnly flag for limit orders', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpNonMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'limit',
						price: '100',
						reduceOnly: true,
					},
				});

				expect(response.statusCode).toBe(200);

				expect(mockGetOpenPerpNonMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						reduceOnly: true,
					})
				);
			});

			it('should handle postOnly flag for limit orders', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpNonMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'limit',
						price: '100',
						postOnly: true,
					},
				});

				expect(response.statusCode).toBe(200);

				expect(mockGetOpenPerpNonMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						postOnly: PostOnlyParams.MUST_POST_ONLY,
					})
				);
			});

			it('should use PostOnlyParams.NONE when postOnly is false', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpNonMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'limit',
						price: '100',
						postOnly: false,
					},
				});

				expect(response.statusCode).toBe(200);

				expect(mockGetOpenPerpNonMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						postOnly: PostOnlyParams.NONE,
					})
				);
			});

			it('should handle both reduceOnly and postOnly flags together', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpNonMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'limit',
						price: '100',
						reduceOnly: true,
						postOnly: true,
					},
				});

				expect(response.statusCode).toBe(200);

				expect(mockGetOpenPerpNonMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						reduceOnly: true,
						postOnly: PostOnlyParams.MUST_POST_ONLY,
					})
				);
			});

			it('should handle decimal prices correctly', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpNonMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'limit',
						price: '123.456',
					},
				});

				expect(response.statusCode).toBe(200);

				expect(mockGetOpenPerpNonMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						orderConfig: {
							orderType: 'limit',
							limitPrice: new BN(123456000),
						},
					})
				);
			});

			it('should successfully create a swift limit order payload', async () => {
				const mockSwiftOrder = createMockSwiftOrder();
				mockGetOpenPerpNonMarketOrderTxn.mockResolvedValue(mockSwiftOrder);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'limit',
						price: '100',
						useSwift: true,
					},
				});

				expect(response.statusCode).toBe(200);
				const payload = JSON.parse(response.payload);

				expect(payload.tx).toBeNull();
				expect(payload.swift).toEqual({
					payload: {
						market_index: 0,
						market_type: 'perp',
						message: 'deadbeef',
						signature: '',
						signing_authority: mockUserKeypair.publicKey.toString(),
						taker_authority: mockUserKeypair.publicKey.toString(),
					},
					meta: {
						signedMsgOrderUuid: Buffer.from([1, 2, 3, 4]).toString('base64'),
						slotForSignedMsg: '123',
						slotsTillAuctionEnd: 35,
						expirationTimeMs: 12000,
					},
				});

				expect(mockGetOpenPerpNonMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						useSwift: true,
					})
				);
				expect(mockGetUser).toHaveBeenCalledWith(expect.any(PublicKey));
				expect(mockSimulateTransaction).not.toHaveBeenCalled();
			});
		});

		describe('Validation and Error Handling', () => {
			it('should return 400 when simulation fails', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpMarketOrderTxn.mockResolvedValue(mockTx);
				mockSimulateTransaction.mockResolvedValue({
					success: false,
					error: 'Insufficient balance',
					code: 1,
					name: 'InsufficientBalance',
					details: 'Not enough funds',
				});

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'market',
						simulate: true,
					},
				});

				expect(response.statusCode).toBe(400);
				const payload = JSON.parse(response.payload);

				expect(payload).toEqual({
					success: false,
					error: 'Insufficient balance',
					code: 1,
					name: 'InsufficientBalance',
					details: 'Not enough funds',
				});
			});

			it('should handle getOpenPerpMarketOrderTxn throwing an error', async () => {
				mockGetOpenPerpMarketOrderTxn.mockRejectedValue(
					new Error('Failed to create order')
				);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'market',
					},
				});

				expect(response.statusCode).toBe(500);
				expect(mockHandleVelocityError).toHaveBeenCalled();
			});

			it('should handle getOpenPerpNonMarketOrderTxn throwing an error', async () => {
				mockGetOpenPerpNonMarketOrderTxn.mockRejectedValue(
					new Error('Failed to create limit order')
				);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'limit',
						price: '100',
					},
				});

				expect(response.statusCode).toBe(500);
				expect(mockHandleVelocityError).toHaveBeenCalled();
			});

			it('should return valid base64 encoded transaction', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpMarketOrderTxn.mockResolvedValue(mockTx);

				const response = await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'market',
					},
				});

				expect(response.statusCode).toBe(200);
				const payload = JSON.parse(response.payload);

				// Verify the transaction can be deserialized
				const txBuffer = Buffer.from(payload.tx, 'base64');
				expect(() => VersionedTransaction.deserialize(txBuffer)).not.toThrow();
			});

			it('should use useSwift: false for orders', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpMarketOrderTxn.mockResolvedValue(mockTx);

				await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'market',
					},
				});

				expect(mockGetOpenPerpMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						useSwift: false,
					})
				);
			});

			it('should use assetType: base for market orders', async () => {
				const mockTx = createMockTransaction();
				mockGetOpenPerpMarketOrderTxn.mockResolvedValue(mockTx);

				await app.inject({
					method: 'POST',
					url: '/order/place',
					payload: {
						accountId: mockUserKeypair.publicKey.toString(),
						symbol: 'SOL-PERP',
						direction: 'long',
						amount: '1',
						orderType: 'market',
					},
				});

				expect(mockGetOpenPerpMarketOrderTxn).toHaveBeenCalledWith(
					expect.objectContaining({
						assetType: 'base',
					})
				);
			});
		});
	});

	describe('POST /order/cancel', () => {
		it('should successfully cancel specific orders by orderIds', async () => {
			const mockTx = createMockTransaction();
			mockGetCancelOrdersTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/order/cancel',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					orderIds: [1, 2, 3],
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload).toHaveProperty('success', true);
			expect(payload).toHaveProperty('tx');
			expect(payload).toHaveProperty('message');
			expect(payload.message).toContain('Cancel orders');
			expect(payload.message).toContain('simulated');

			expect(mockEnsureVelocityClientSubscribed).toHaveBeenCalledTimes(1);
			expect(mockGetCancelOrdersTxn).toHaveBeenCalledWith(expect.any(PublicKey), [1, 2, 3]);
			expect(mockSimulateTransaction).toHaveBeenCalledWith(mockTx, {
				skipSimulation: false,
			});
		});

		it('should successfully cancel all orders when orderIds not provided', async () => {
			const mockTx = createMockTransaction();
			mockGetCancelAllOrdersTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/order/cancel',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload.success).toBe(true);
			expect(payload.message).toContain('Cancel all orders');

			expect(mockGetCancelAllOrdersTxn).toHaveBeenCalledWith(expect.any(PublicKey));
			expect(mockGetCancelOrdersTxn).not.toHaveBeenCalled();
		});

		it('should successfully cancel all orders when orderIds is empty array', async () => {
			const mockTx = createMockTransaction();
			mockGetCancelAllOrdersTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/order/cancel',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					orderIds: [],
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload.message).toContain('Cancel all orders');
			expect(mockGetCancelAllOrdersTxn).toHaveBeenCalled();
			expect(mockGetCancelOrdersTxn).not.toHaveBeenCalled();
		});

		it('should cancel orders without simulation when simulate is false', async () => {
			const mockTx = createMockTransaction();
			mockGetCancelOrdersTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/order/cancel',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					orderIds: [1],
					simulate: false,
				},
			});

			expect(response.statusCode).toBe(200);
			const payload = JSON.parse(response.payload);

			expect(payload.message).not.toContain('simulated');
			expect(mockSimulateTransaction).toHaveBeenCalledWith(mockTx, {
				skipSimulation: true,
			});
		});

		it('should default simulate to true when not provided', async () => {
			const mockTx = createMockTransaction();
			mockGetCancelAllOrdersTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/order/cancel',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
				},
			});

			expect(response.statusCode).toBe(200);
			expect(mockSimulateTransaction).toHaveBeenCalledWith(mockTx, {
				skipSimulation: false,
			});
		});

		it('should handle single order cancellation', async () => {
			const mockTx = createMockTransaction();
			mockGetCancelOrdersTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/order/cancel',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					orderIds: [5],
				},
			});

			expect(response.statusCode).toBe(200);

			expect(mockGetCancelOrdersTxn).toHaveBeenCalledWith(expect.any(PublicKey), [5]);
		});

		it('should handle multiple order cancellation', async () => {
			const mockTx = createMockTransaction();
			mockGetCancelOrdersTxn.mockResolvedValue(mockTx);

			const response = await app.inject({
				method: 'POST',
				url: '/order/cancel',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					orderIds: [10, 20, 30, 40, 50],
				},
			});

			expect(response.statusCode).toBe(200);

			expect(mockGetCancelOrdersTxn).toHaveBeenCalledWith(
				expect.any(PublicKey),
				[10, 20, 30, 40, 50]
			);
		});

		it('should return 400 when simulation fails', async () => {
			const mockTx = createMockTransaction();
			mockGetCancelOrdersTxn.mockResolvedValue(mockTx);
			mockSimulateTransaction.mockResolvedValue({
				success: false,
				error: 'Order not found',
				code: 2,
				name: 'OrderNotFound',
				details: 'Cannot cancel non-existent order',
			});

			const response = await app.inject({
				method: 'POST',
				url: '/order/cancel',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					orderIds: [999],
					simulate: true,
				},
			});

			expect(response.statusCode).toBe(400);
			const payload = JSON.parse(response.payload);

			expect(payload).toEqual({
				success: false,
				error: 'Order not found',
				code: 2,
				name: 'OrderNotFound',
				details: 'Cannot cancel non-existent order',
			});
		});

		it('should handle getCancelOrdersTxn throwing an error', async () => {
			mockGetCancelOrdersTxn.mockRejectedValue(new Error('Failed to cancel orders'));

			const response = await app.inject({
				method: 'POST',
				url: '/order/cancel',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
					orderIds: [1],
				},
			});

			expect(response.statusCode).toBe(500);
			expect(mockHandleVelocityError).toHaveBeenCalled();
		});

		it('should handle getCancelAllOrdersTxn throwing an error', async () => {
			mockGetCancelAllOrdersTxn.mockRejectedValue(new Error('Failed to cancel all orders'));

			const response = await app.inject({
				method: 'POST',
				url: '/order/cancel',
				payload: {
					accountId: mockUserKeypair.publicKey.toString(),
				},
			});

			expect(response.statusCode).toBe(500);
			expect(mockHandleVelocityError).toHaveBeenCalled();
		});
	});
});
