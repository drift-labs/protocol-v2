import { getPerpMarkets } from '@backend/common';
import { PublicKey } from '@solana/web3.js';
import { FastifyPluginAsync } from 'fastify';

const Settle: FastifyPluginAsync = async (fastify): Promise<void> => {
	const perpMarkets = getPerpMarkets();
	const symbolToMarketIndex = new Map(
		perpMarkets.map((market) => [market.symbol, market.marketIndex] as const)
	);

	fastify.post<{
		Body: {
			accountId: string;
			symbols?: string[];
			simulate?: boolean;
		};
	}>(
		'/settlePnl',
		{
			schema: {
				description: `<strong>This endpoint is currently in BETA and should only be used for test purposes</strong> <br>Build a transaction to settle unrealized perp PnL into the user's settled balance. If <code>symbols</code> is omitted, the transaction targets all configured perp markets.`,
				tags: ['Transactions'],
				body: {
					type: 'object',
					required: ['accountId'],
					additionalProperties: false,
					properties: {
						accountId: {
							type: 'string',
							description:
								'Velocity user account public key (subaccount address, not authority)',
						},
						symbols: {
							type: 'array',
							description:
								'Optional market filter. Provide perp market symbols to settle; omit to target all configured perp markets.',
							items: { type: 'string' },
							minItems: 1,
						},
						simulate: {
							type: 'boolean',
							description:
								'Whether to simulate settlement before returning the transaction (default: true).',
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

				const { accountId, symbols, simulate = true } = request.body;

				const userAccountPubkey = new PublicKey(accountId);

				const symbolsToSettle =
					symbols && symbols.length > 0
						? [...new Set(symbols.map((symbol) => symbol.trim()))]
						: [...symbolToMarketIndex.keys()];

				if (!symbolsToSettle.length) {
					return reply.status(400).send({
						success: false,
						error: 'No configured perp markets found to settle',
					});
				}

				const invalidSymbols = symbolsToSettle.filter(
					(symbol) => !symbolToMarketIndex.has(symbol)
				);
				if (invalidSymbols.length > 0) {
					return reply.status(400).send({
						success: false,
						error: `Invalid perp symbols: ${invalidSymbols.join(', ')}`,
					});
				}

				const indexesToSettle = symbolsToSettle.map(
					(symbol) => symbolToMarketIndex.get(symbol)!
				);

				if (!indexesToSettle.length) {
					return reply.status(400).send({
						success: false,
						error: 'No configured perp markets found to settle',
					});
				}

				const settlePnlTxn = await fastify.centralServerVelocity.getSettlePnlTxn(
					userAccountPubkey,
					indexesToSettle
				);

				const simResult = await fastify.simulateTransaction(settlePnlTxn, {
					skipSimulation: !simulate,
				});

				if (!simResult.success) {
					return reply.status(400).send(simResult);
				}

				const serializedTransaction = Buffer.from(settlePnlTxn.serialize());
				const base64Transaction = serializedTransaction.toString('base64');

				return reply.send({
					success: true,
					tx: base64Transaction,
					message: `Settle PnL transaction created${
						simulate ? ' and simulated' : ''
					} successfully for ${
						indexesToSettle.length
					} market(s). Sign and send to realize unsettled perp PnL.`,
				});
			} catch (error) {
				await fastify.handleVelocityError(error, reply);
			}
		}
	);
};

export default Settle;
