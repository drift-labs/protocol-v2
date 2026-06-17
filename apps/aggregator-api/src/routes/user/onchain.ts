import {
	bnStringToNumber,
	getPerpMarketSymbol,
	getSpotMarketSymbol,
	SerializedMarketFilter,
	simpleSerialize,
} from '@backend/common';
import { PublicKey } from '@solana/web3.js';
import {
	BASE_PRECISION,
	BASE_PRECISION_EXP,
	BN,
	calculateFeesAndFundingPnl,
	getSignedTokenAmount,
	getTokenAmount,
	QUOTE_PRECISION,
	SpotMarketAccount,
	TEN_THOUSAND,
	ZERO,
} from '@velocity-exchange/sdk';
import { FastifyPluginAsync } from 'fastify';
import { applyPrecisions } from '../../utils/apply-precisions';

const Onchain: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.addHook('preSerialization', async (_, __, payload) => {
		return applyPrecisions(payload);
	});

	fastify.get<{
		Params: {
			accountId: string;
		};
	}>(
		'/:accountId',
		{
			schema: {
				description: `<strong>This endpoint is currently in BETA and should only be used for test purposes</strong> <br>Retrieve the current state of the user account from on chain.`,
				tags: ['User'],
				params: {
					type: 'object',
					properties: {
						accountId: { type: 'string' },
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							account: {
								type: 'object',
								properties: {
									balance: { type: 'string' },
									totalCollateral: { type: 'string' },
									freeCollateral: { type: 'string' },
									health: { type: 'string' },
									initialMargin: { type: 'string' },
									maintenanceMargin: { type: 'string' },
									leverage: { type: 'string' },
								},
							},
							positions: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										symbol: { type: 'string' },
										marketIndex: { type: 'integer' },
										marginMode: { type: 'string' },
										baseAssetAmount: { type: 'string' },
										quoteEntryAmount: { type: 'string' },
										settledPnl: { type: 'string' },
										feesAndFunding: { type: 'string' },
										liquidationPrice: { type: 'string' },
									},
								},
							},
							balances: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										symbol: { type: 'string' },
										marketIndex: { type: 'integer' },
										balance: { type: 'string' },
										openOrders: { type: 'integer' },
										liquidationPrice: { type: 'string' },
									},
								},
							},
							orders: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										symbol: { type: 'string' },
										marketIndex: { type: 'integer' },
										marketType: { type: 'string' },
										orderId: { type: 'integer' },
										price: { type: 'string' },
										baseAssetAmount: { type: 'string' },
										baseAssetAmountFilled: { type: 'string' },
										quoteAssetAmountFilled: { type: 'string' },
										status: { type: 'string' },
										orderType: { type: 'string' },
										direction: { type: 'string' },
										reduceOnly: { type: 'boolean' },
										postOnly: { type: 'boolean' },
										triggerPrice: { type: 'string' },
										triggerCondition: { type: 'string' },
									},
								},
							},
						},
					},
				},
			},
		},
		async function (request, reply) {
			const { accountId } = request.params;

			await fastify.ensureVelocityClientSubscribed();

			const client = fastify.velocityClient;
			const centralServer = fastify.centralServerVelocity;

			let publicKey: PublicKey;
			try {
				publicKey = new PublicKey(accountId);
			} catch (error) {
				return reply.code(400).send({
					error: 'ValidationError',
					message: `Invalid account ID format: ${accountId}`,
				});
			}

			let spotMarkets: SpotMarketAccount[];
			try {
				spotMarkets = await client.getSpotMarketAccounts();
			} catch (error) {
				return reply.code(503).send({
					error: 'RPCError',
					message:
						'Failed to fetch spot market data from the RPC node. Please try again later.',
				});
			}

			const user = await centralServer.getUser(publicKey);

			if (!user.getUserAccount()) {
				return reply.code(503).send({
					error: 'RPCError',
					message: `Failed to fetch user account ${publicKey}. Please try again later.`,
				});
			}

			return {
				account: {
					balance: bnStringToNumber(user.getNetUsdValue().toString(), QUOTE_PRECISION),
					initialMargin: bnStringToNumber(
						user.getInitialMarginRequirement().toString(),
						QUOTE_PRECISION
					),
					maintenanceMargin: bnStringToNumber(
						user.getMaintenanceMarginRequirement().toString(),
						QUOTE_PRECISION
					),
					health: user.getHealth(),
					totalCollateral: bnStringToNumber(
						user.getTotalCollateral().toString(),
						QUOTE_PRECISION
					),
					freeCollateral: bnStringToNumber(
						user.getFreeCollateral().toString(),
						QUOTE_PRECISION
					),
					leverage: bnStringToNumber(user.getLeverage().toString(), TEN_THOUSAND),
				},
				positions: user
					.getActivePerpPositions()
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					.filter((position: any) => position.baseAssetAmount.abs().gt(ZERO))
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					.map((position: any) => {
						const isIsolated = user.isPerpPositionIsolated(position);
						const marginType = isIsolated ? 'Isolated' : 'Cross';
						const liquidationPrice = user.liquidationPrice(
							position.marketIndex,
							ZERO,
							ZERO,
							'Maintenance',
							false,
							ZERO,
							marginType
						);

						return {
							symbol: getPerpMarketSymbol(position.marketIndex),
							marketIndex: position.marketIndex,
							baseAssetAmount: bnStringToNumber(
								position.baseAssetAmount.toString(),
								BASE_PRECISION
							),
							quoteEntryAmount: bnStringToNumber(
								position.quoteEntryAmount.toString(),
								QUOTE_PRECISION
							),
							settledPnl: bnStringToNumber(
								position.settledPnl.toString(),
								QUOTE_PRECISION
							),
							feesAndFunding: bnStringToNumber(
								calculateFeesAndFundingPnl(
									client.getPerpMarketAccount(position.marketIndex)!,
									position
								).toString(),
								QUOTE_PRECISION
							),
							liquidationPrice: bnStringToNumber(
								liquidationPrice.gt(ZERO) ? liquidationPrice.toString() : '0',
								QUOTE_PRECISION
							),
							marginMode: isIsolated ? 'isolated' : 'cross',
						};
					}),
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				balances: user.getActiveSpotPositions().map((balance: any) => {
					const spotMarket = spotMarkets.find(
						(market) => market.marketIndex === balance.marketIndex
					);

					if (!spotMarket)
						throw new Error(`Unable to find spot market: ${balance.marketIndex}`);

					return {
						symbol: getSpotMarketSymbol(balance.marketIndex),
						marketIndex: balance.marketIndex,
						balance: bnStringToNumber(
							getTokenAmount(
								getSignedTokenAmount(balance.scaledBalance, balance.balanceType),
								spotMarket,
								balance.balanceType
							).toString(),
							new BN(10).pow(new BN(spotMarket.decimals))
						),
						openOrders: balance.openOrders,
						liquidationPrice: bnStringToNumber(
							user.spotLiquidationPrice(balance.marketIndex).gt(ZERO)
								? user.spotLiquidationPrice(balance.marketIndex).toString()
								: '0',
							QUOTE_PRECISION
						),
					};
				}),
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				orders: user.getOpenOrders().map((order: any) => {
					const serializedOrder = simpleSerialize(order);
					const decimals =
						serializedOrder.marketType === SerializedMarketFilter.PERP
							? BASE_PRECISION_EXP
							: spotMarkets.find((market) => market.marketIndex === order.marketIndex)
									?.decimals;

					if (!decimals)
						throw new Error(
							`Unable to find precision for spot market: ${order.marketIndex}`
						);

					const precision = new BN(10).pow(new BN(decimals));

					return {
						symbol:
							serializedOrder.marketType === SerializedMarketFilter.PERP
								? getPerpMarketSymbol(serializedOrder.marketIndex)
								: getSpotMarketSymbol(serializedOrder.marketIndex),
						marketIndex: serializedOrder.marketIndex,
						marketType: serializedOrder.marketType,
						orderId: serializedOrder.orderId,
						price: bnStringToNumber(serializedOrder.price, QUOTE_PRECISION),
						baseAssetAmount: bnStringToNumber(
							serializedOrder.baseAssetAmount,
							precision
						),
						baseAssetAmountFilled: bnStringToNumber(
							serializedOrder.baseAssetAmountFilled,
							precision
						),
						quoteAssetAmountFilled: bnStringToNumber(
							serializedOrder.baseAssetAmountFilled,
							QUOTE_PRECISION
						),
						status: serializedOrder.status,
						orderType: serializedOrder.orderType,
						direction: serializedOrder.direction,
						reduceOnly: serializedOrder.reduceOnly,
						postOnly: serializedOrder.postOnly,
						triggerPrice: bnStringToNumber(
							serializedOrder.triggerPrice,
							QUOTE_PRECISION
						),
						triggerCondition: serializedOrder.triggerCondition,
					};
				}),
			};
		}
	);
};

export default Onchain;
