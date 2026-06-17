import { getSpotMarkets } from '@backend/common';
import { PublicKey } from '@solana/web3.js';
import { BN } from '@velocity-exchange/sdk';
import { Decimal } from 'decimal.js';
import { FastifyPluginAsync } from 'fastify';
import { marketValidation } from '../../hooks/market-validation';

const Deposits: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.post<{
		Body: {
			accountId: string;
			amount: string;
			symbol: string;
			simulate?: boolean;
		};
	}>(
		'/deposit',
		{
			preValidation: marketValidation({ type: 'spot', paramType: 'body', required: true }),
			schema: {
				description: `<strong>This endpoint is currently in BETA and should only be used for test purposes</strong> <br>Build a transaction to deposit collateral into a Velocity account`,
				tags: ['Transactions'],
				body: {
					type: 'object',
					properties: {
						accountId: { type: 'string', description: 'User wallet public key' },
						amount: { type: 'string', description: 'Amount to deposit in base units' },
						symbol: {
							type: 'string',
							description: 'Spot market symbol',
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
							message: { type: 'string' },
						},
					},
				},
			},
		},
		async function (request, reply) {
			try {
				await fastify.ensureVelocityClientSubscribed();

				const { accountId, amount, symbol, simulate = true } = request.body;

				if (!accountId || !amount || !symbol) {
					return reply.status(400).send({
						success: false,
						error: 'Missing required fields: accountId and amount',
					});
				}

				const market = getSpotMarkets().find((m) => m.symbol === symbol);
				if (!market) {
					return reply.status(400).send({
						success: false,
						error: `Invalid symbol: ${symbol}`,
					});
				}

				let userPubkey: PublicKey;
				try {
					userPubkey = new PublicKey(accountId);
				} catch (e) {
					return reply.status(400).send({
						success: false,
						error: 'Invalid public key format for accountId',
					});
				}

				let amountBn: BN;
				try {
					amountBn = new BN(
						new Decimal(amount).mul(market.precision.toString()).toString()
					);
					if (amountBn.lte(new BN(0))) {
						throw new Error('Amount must be greater than 0');
					}
				} catch (e) {
					return reply.status(400).send({
						success: false,
						error: 'Invalid amount: must be a positive number',
					});
				}

				const depositTxn = await fastify.centralServerVelocity.getDepositTxn(
					userPubkey,
					amountBn,
					market.marketIndex
				);

				const simResult = await fastify.simulateTransaction(depositTxn, {
					skipSimulation: !simulate,
				});

				if (!simResult.success) {
					return reply.status(400).send(simResult);
				}

				const serializedTransaction = Buffer.from(depositTxn.serialize());
				const base64Transaction = serializedTransaction.toString('base64');

				return reply.send({
					success: true,
					tx: base64Transaction,
					message: `Deposit transaction created${
						simulate ? ' and simulated' : ''
					} successfully for ${symbol}. Sign and send to complete deposit.`,
				});
			} catch (error) {
				await fastify.handleVelocityError(error, reply);
			}
		}
	);

	fastify.post<{
		Body: {
			accountId: string;
			amount: string;
			symbol: string;
			simulate?: boolean;
		};
	}>(
		'/withdraw',
		{
			preValidation: marketValidation({ type: 'spot', paramType: 'body', required: true }),
			schema: {
				description: `<strong>This endpoint is currently in BETA and should only be used for test purposes</strong> <br>Build a transaction to withdraw collateral from a Velocity account`,
				tags: ['Transactions'],
				body: {
					type: 'object',
					properties: {
						accountId: { type: 'string', description: 'User wallet public key' },
						amount: { type: 'string', description: 'Amount to withdraw in base units' },
						symbol: {
							type: 'string',
							description: 'Spot market symbol',
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
							message: { type: 'string' },
						},
					},
				},
			},
		},
		async function (request, reply) {
			try {
				await fastify.ensureVelocityClientSubscribed();

				const { accountId, amount, symbol, simulate = true } = request.body;

				if (!accountId || !amount || !symbol) {
					return reply.status(400).send({
						success: false,
						error: 'Missing required fields: accountId and amount',
					});
				}

				const market = getSpotMarkets().find((m) => m.symbol === symbol);
				if (!market) {
					return reply.status(400).send({
						success: false,
						error: `Invalid symbol: ${symbol}`,
					});
				}

				let userPubkey: PublicKey;
				try {
					userPubkey = new PublicKey(accountId);
				} catch (e) {
					return reply.status(400).send({
						success: false,
						error: 'Invalid public key format for accountId',
					});
				}

				let amountBn: BN;
				try {
					amountBn = new BN(
						new Decimal(amount).mul(market.precision.toString()).toString()
					);
					if (amountBn.lte(new BN(0))) {
						throw new Error('Amount must be greater than 0');
					}
				} catch (e) {
					return reply.status(400).send({
						success: false,
						error: 'Invalid amount: must be a positive number',
					});
				}

				const withdrawTxn = await fastify.centralServerVelocity.getWithdrawTxn(
					userPubkey,
					amountBn,
					market.marketIndex
				);

				const simResult = await fastify.simulateTransaction(withdrawTxn, {
					skipSimulation: !simulate,
				});

				if (!simResult.success) {
					return reply.status(400).send(simResult);
				}

				const serializedTransaction = Buffer.from(withdrawTxn.serialize());
				const base64Transaction = serializedTransaction.toString('base64');

				return reply.send({
					success: true,
					tx: base64Transaction,
					message: `Withdrawal transaction created${
						simulate ? ' and simulated' : ''
					} successfully for ${symbol}. Sign and send to complete withdrawal.`,
				});
			} catch (error) {
				await fastify.handleVelocityError(error, reply);
			}
		}
	);
};

export default Deposits;
