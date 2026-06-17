import { getPerpMarkets } from '@backend/common';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import type { SwiftOrderMessage } from '@velocity-exchange/common';
import {
	BASE_PRECISION,
	BN,
	PositionDirection,
	PostOnlyParams,
	PRICE_PRECISION,
} from '@velocity-exchange/sdk';
import { Decimal } from 'decimal.js';
import { FastifyPluginAsync } from 'fastify';
import { marketValidation } from '../../hooks/market-validation';

const Orders: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.post<{
		Body: {
			accountId: string;
			symbol: string;
			direction: 'long' | 'short';
			amount: string;
			orderType: 'market' | 'limit';
			marginMode?: 'cross' | 'isolated';
			positionMaxLeverage: number;
			builderParams?: {
				builderIdx: number;
				builderFeeTenthBps: number;
			};
			price?: string;
			reduceOnly?: boolean;
			postOnly?: boolean;
			useSwift?: boolean;
			simulate?: boolean;
		};
	}>(
		'/order/place',
		{
			preValidation: marketValidation({ type: 'perp', paramType: 'body' }),
			schema: {
				description: `<strong>This endpoint is currently in BETA and should only be used for test purposes</strong> <br>Build a transaction to place a perp order on Velocity`,
				tags: ['Transactions'],
				body: {
					type: 'object',
					required: ['accountId', 'symbol', 'direction', 'amount', 'orderType'],
					properties: {
						accountId: { type: 'string' },
						symbol: { type: 'string' },
						direction: {
							type: 'string',
							enum: ['long', 'short'],
							description: 'Order direction',
						},
						amount: { type: 'string', description: 'Base asset amount' },
						orderType: {
							type: 'string',
							enum: ['market', 'limit'],
							description: 'Order type',
						},
						marginMode: {
							type: 'string',
							enum: ['cross', 'isolated'],
							description: 'Position margin mode (cross or isolated)',
						},
						price: {
							type: 'string',
							description: 'Limit price (required for limit orders)',
						},
						reduceOnly: {
							type: 'boolean',
							description: 'Whether order is reduce-only',
						},
						postOnly: {
							type: 'boolean',
							description: 'Whether order is post-only (limit orders only)',
						},
						useSwift: {
							type: 'boolean',
							description:
								'Whether to prepare a Swift order message instead of a transaction',
							default: false,
						},
						positionMaxLeverage: {
							type: 'number',
							description: 'Total leverage to use',
						},
						builderParams: {
							type: 'object',
							description:
								'Optional builder code params. Note: currently only applied in Velocity Swift order flow.',
							required: ['builderIdx', 'builderFeeTenthBps'],
							additionalProperties: false,
							properties: {
								builderIdx: {
									type: 'number',
									minimum: 0,
									description:
										'Index in the user approved builders list (RevenueShareEscrow).',
								},
								builderFeeTenthBps: {
									type: 'number',
									minimum: 1,
									description:
										'Fee for this order in tenth-bps. Must be <= approved builder max.',
								},
							},
						},
						simulate: {
							type: 'boolean',
							description:
								'Whether to simulate transaction before returning (default: true)',
							default: true,
						},
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							tx: {
								type: 'string',
								nullable: true,
								description: 'Base64 encoded transaction (non-Swift only)',
							},
							swift: {
								type: 'object',
								nullable: true,
								properties: {
									payload: {
										type: 'object',
										properties: {
											market_index: {
												type: 'number',
												description: 'Swift server perp market index',
											},
											market_type: {
												type: 'string',
												description: 'Swift server market type',
											},
											message: {
												type: 'string',
												description:
													'UTF-8 encoded hex string to sign and send to the Swift server',
											},
											signature: {
												type: 'string',
												description:
													'Base64 wallet signature. This is returned empty and must be filled client-side before sending.',
											},
											signing_authority: {
												type: 'string',
												description:
													'Authority that signs the Swift order message',
											},
											taker_authority: {
												type: 'string',
												description:
													'Taker authority expected by the Swift server',
											},
										},
									},
									meta: {
										type: 'object',
										properties: {
											signedMsgOrderUuid: {
												type: 'string',
												description:
													'Base64 encoded signed message order UUID for tracking',
											},
											slotForSignedMsg: {
												type: 'string',
												description:
													'Slot encoded into the signed Swift order message',
											},
											slotsTillAuctionEnd: { type: 'number' },
											expirationTimeMs: { type: 'number' },
										},
									},
								},
							},
							message: { type: 'string' },
						},
					},
					400: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							error: { type: 'string' },
							code: { type: 'number', nullable: true },
							name: { type: 'string', nullable: true },
							details: { type: 'string', nullable: true },
							message: { type: 'string', nullable: true },
						},
					},
				},
			},
		},
		async function (request, reply) {
			try {
				await fastify.ensureVelocityClientSubscribed();

				const {
					accountId,
					symbol,
					direction,
					amount,
					orderType,
					marginMode,
					price,
					reduceOnly,
					postOnly,
					positionMaxLeverage,
					builderParams,
					useSwift = false,
					simulate = true,
				} = request.body;

				const marketIndex = getPerpMarkets().find(
					(market) => market.symbol === symbol
				)!.marketIndex;

				const userAccountPubkey = new PublicKey(accountId);
				const baseAmount = new BN(
					new Decimal(amount).mul(BASE_PRECISION.toString()).floor().toString()
				);
				const posDirection =
					direction === 'long' ? PositionDirection.LONG : PositionDirection.SHORT;

				let orderResult;

				if (orderType === 'market') {
					if (useSwift) {
						orderResult = await fastify.centralServerVelocity.getOpenPerpMarketOrderTxn(
							{
								userAccountPublicKey: userAccountPubkey,
								useSwift: true,
								marketIndex: marketIndex,
								direction: posDirection,
								amount: baseAmount,
								positionMaxLeverage,
								marginMode,
								assetType: 'base',
								builderParams,
							}
						);
					} else {
						orderResult = await fastify.centralServerVelocity.getOpenPerpMarketOrderTxn(
							{
								userAccountPublicKey: userAccountPubkey,
								useSwift: false,
								marketIndex: marketIndex,
								direction: posDirection,
								amount: baseAmount,
								positionMaxLeverage,
								marginMode,
								assetType: 'base',
								builderParams,
							}
						);
					}
				} else {
					// Limit order
					if (!price) {
						return reply.status(400).send({
							success: false,
							error: 'price is required for limit orders',
						});
					}

					const limitPrice = new BN(
						new Decimal(price).mul(PRICE_PRECISION.toString()).floor().toString()
					);

					if (useSwift) {
						orderResult =
							await fastify.centralServerVelocity.getOpenPerpNonMarketOrderTxn({
								userAccountPublicKey: userAccountPubkey,
								useSwift: true,
								marketIndex: marketIndex,
								direction: posDirection,
								baseAssetAmount: baseAmount,
								positionMaxLeverage,
								marginMode,
								reduceOnly: reduceOnly ?? false,
								postOnly: postOnly
									? PostOnlyParams.MUST_POST_ONLY
									: PostOnlyParams.NONE,
								builderParams,
								orderConfig: {
									orderType: 'limit',
									limitPrice: limitPrice,
								},
							});
					} else {
						orderResult =
							await fastify.centralServerVelocity.getOpenPerpNonMarketOrderTxn({
								userAccountPublicKey: userAccountPubkey,
								useSwift: false,
								marketIndex: marketIndex,
								direction: posDirection,
								baseAssetAmount: baseAmount,
								positionMaxLeverage,
								marginMode,
								reduceOnly: reduceOnly ?? false,
								postOnly: postOnly
									? PostOnlyParams.MUST_POST_ONLY
									: PostOnlyParams.NONE,
								builderParams,
								orderConfig: {
									orderType: 'limit',
									limitPrice: limitPrice,
								},
							});
					}
				}

				if (useSwift) {
					const swiftOrder = orderResult as SwiftOrderMessage;
					const user = await fastify.centralServerVelocity.getUser(userAccountPubkey);
					const takerAuthority = user.getUserAccount().authority.toString();

					return reply.send({
						success: true,
						tx: null,
						swift: {
							payload: {
								market_index: swiftOrder.marketIndex,
								market_type: 'perp',
								message: swiftOrder.hexEncodedSwiftOrderMessage.string,
								signature: '',
								signing_authority: takerAuthority,
								taker_authority: takerAuthority,
							},
							meta: {
								signedMsgOrderUuid: Buffer.from(
									swiftOrder.signedMsgOrderUuid
								).toString('base64'),
								slotForSignedMsg: swiftOrder.slotForSignedMsg.toString(),
								slotsTillAuctionEnd: swiftOrder.slotsTillAuctionEnd,
								expirationTimeMs: swiftOrder.expirationTimeMs,
							},
						},
						message: `${
							orderType === 'market' ? 'Market' : 'Limit'
						} Swift payload created successfully. Sign the message, populate swift.payload.signature with the base64 signature, and POST the payload to https://swift.velocity.exchange/orders.`,
					});
				}

				const orderTxn = orderResult as Transaction | VersionedTransaction;

				const simResult = await fastify.simulateTransaction(orderTxn, {
					skipSimulation: !simulate,
				});

				if (!simResult.success) {
					return reply.status(400).send(simResult);
				}

				const serializedTransaction = Buffer.from(orderTxn.serialize());
				const base64Transaction = serializedTransaction.toString('base64');

				return reply.send({
					success: true,
					tx: base64Transaction,
					message: `${
						orderType === 'market' ? 'Market' : 'Limit'
					} order transaction created${
						simulate ? ' and simulated' : ''
					} successfully. Sign and send to place order.`,
				});
			} catch (error) {
				await fastify.handleVelocityError(error, reply);
			}
		}
	);

	fastify.post<{
		Body: {
			accountId: string;
			orderIds?: number[];
			simulate?: boolean;
		};
	}>(
		'/order/cancel',
		{
			schema: {
				description: `<strong>This endpoint is currently in BETA and should only be used for test purposes</strong> <br>Build a transaction to cancel orders on Velocity. If orderIds is provided, cancels specific orders. Otherwise, cancels all orders.`,
				tags: ['Transactions'],
				body: {
					type: 'object',
					required: ['accountId'],
					properties: {
						accountId: {
							type: 'string',
							description: 'User account public key (not authority)',
						},
						orderIds: {
							type: 'array',
							items: { type: 'number' },
							description:
								'Optional: Array of specific order IDs to cancel. If not provided, cancels all orders.',
						},
						simulate: {
							type: 'boolean',
							description:
								'Whether to simulate transaction before returning (default: true)',
							default: true,
						},
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							tx: { type: 'string', description: 'Base64 encoded transaction' },
							message: { type: 'string' },
						},
					},
					400: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							error: { type: 'string' },
							code: { type: 'number', nullable: true },
							name: { type: 'string', nullable: true },
							details: { type: 'string', nullable: true },
							message: { type: 'string', nullable: true },
						},
					},
				},
			},
		},
		async function (request, reply) {
			try {
				await fastify.ensureVelocityClientSubscribed();

				const { accountId, orderIds, simulate = true } = request.body;
				const userAccountPubkey = new PublicKey(accountId);

				let cancelTxn;

				if (orderIds && orderIds.length > 0) {
					cancelTxn = await fastify.centralServerVelocity.getCancelOrdersTxn(
						userAccountPubkey,
						orderIds
					);
				} else {
					cancelTxn = await fastify.centralServerVelocity.getCancelAllOrdersTxn(
						userAccountPubkey
					);
				}

				const simResult = await fastify.simulateTransaction(cancelTxn, {
					skipSimulation: !simulate,
				});

				if (!simResult.success) {
					return reply.status(400).send(simResult);
				}

				const serializedTransaction = Buffer.from(cancelTxn.serialize());
				const base64Transaction = serializedTransaction.toString('base64');

				return reply.send({
					success: true,
					tx: base64Transaction,
					message:
						orderIds && orderIds.length > 0
							? `Cancel orders transaction created${
									simulate ? ' and simulated' : ''
							  } successfully. Sign and send to cancel orders.`
							: `Cancel all orders transaction created${
									simulate ? ' and simulated' : ''
							  } successfully. Sign and send to cancel orders.`,
				});
			} catch (error) {
				await fastify.handleVelocityError(error, reply);
			}
		}
	);
};

export default Orders;
