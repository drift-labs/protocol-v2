import { PublicKey } from '@solana/web3.js';
import { getRevenueShareEscrowAccountPublicKey } from '@velocity-exchange/sdk';
import { FastifyPluginAsync } from 'fastify';

const Builder: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.post<{
		Body: {
			builderId: string;
			simulate?: boolean;
		};
	}>(
		'/builder/init',
		{
			schema: {
				description: `<strong>This endpoint is currently in BETA and should only be used for test purposes</strong> <br>Build a transaction for a builder to initialize their revenue share account`,
				tags: ['Transactions'],
				body: {
					type: 'object',
					required: ['builderId'],
					additionalProperties: false,
					properties: {
						builderId: {
							type: 'string',
							description: 'Builder wallet public key',
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

				const { builderId, simulate = true } = request.body;

				let builderPubkey: PublicKey;
				try {
					builderPubkey = new PublicKey(builderId);
				} catch (e) {
					return reply.status(400).send({
						success: false,
						error: 'Invalid public key format for builderId',
					});
				}

				const initBuilderTxn =
					await fastify.centralServerVelocity.getCreateRevenueShareAccountTxn(
						builderPubkey
					);

				const simResult = await fastify.simulateTransaction(initBuilderTxn, {
					skipSimulation: !simulate,
				});

				if (!simResult.success) {
					return reply.status(400).send(simResult);
				}

				const serializedTransaction = Buffer.from(initBuilderTxn.serialize());
				const base64Transaction = serializedTransaction.toString('base64');

				return reply.send({
					success: true,
					tx: base64Transaction,
					message: `Builder revenue share init transaction created${
						simulate ? ' and simulated' : ''
					}. Sign and send to complete setup.`,
				});
			} catch (error) {
				await fastify.handleVelocityError(error, reply);
			}
		}
	);

	fastify.post<{
		Body: {
			authorityId: string;
			builderId: string;
			maxFeeTenthBps: number;
			numOrders?: number;
			simulate?: boolean;
		};
	}>(
		'/builder/approve',
		{
			schema: {
				description: `<strong>This endpoint is currently in BETA and should only be used for test purposes</strong> <br>Build a single transaction to create a user's builder escrow and approve a builder`,
				tags: ['Transactions'],
				body: {
					type: 'object',
					required: ['authorityId', 'builderId', 'maxFeeTenthBps'],
					additionalProperties: false,
					properties: {
						authorityId: {
							type: 'string',
							description: 'User authority wallet public key',
						},
						builderId: {
							type: 'string',
							description: 'Builder wallet public key',
						},
						maxFeeTenthBps: {
							type: 'number',
							description:
								'Builder max fee cap in tenth-bps units. Must be > 0 to approve.',
						},
						numOrders: {
							type: 'number',
							description:
								'Revenue share escrow concurrent order capacity (1-128, default: 16).',
							default: 16,
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

				const {
					authorityId,
					builderId,
					maxFeeTenthBps,
					numOrders = 16,
					simulate = true,
				} = request.body;

				if (!Number.isInteger(maxFeeTenthBps) || maxFeeTenthBps <= 0) {
					return reply.status(400).send({
						success: false,
						error: 'maxFeeTenthBps must be a positive integer',
					});
				}

				if (!Number.isInteger(numOrders) || numOrders < 1 || numOrders > 128) {
					return reply.status(400).send({
						success: false,
						error: 'numOrders must be an integer between 1 and 128',
					});
				}

				let userPubkey: PublicKey;
				try {
					userPubkey = new PublicKey(authorityId);
				} catch (e) {
					return reply.status(400).send({
						success: false,
						error: 'Invalid public key format for authorityId',
					});
				}

				let builderPubkey: PublicKey;
				try {
					builderPubkey = new PublicKey(builderId);
				} catch (e) {
					return reply.status(400).send({
						success: false,
						error: 'Invalid public key format for builderId',
					});
				}

				const revenueShareEscrow =
					await fastify.velocityClient.program.account.revenueShareEscrow.fetchNullable(
						getRevenueShareEscrowAccountPublicKey(
							fastify.velocityClient.program.programId,
							userPubkey
						)
					);

				let txn;
				if (revenueShareEscrow) {
					txn = await fastify.centralServerVelocity.getConfigureApprovedBuilderTxn(
						userPubkey,
						builderPubkey,
						maxFeeTenthBps
					);
				} else {
					txn = await fastify.centralServerVelocity.getCreateRevenueShareEscrowTxn(
						userPubkey,
						{
							numOrders,
							builder: {
								builderAuthority: builderPubkey,
								maxFeeTenthBps,
							},
						}
					);
				}

				const simResult = await fastify.simulateTransaction(txn, {
					skipSimulation: !simulate,
				});

				if (!simResult.success) {
					return reply.status(400).send(simResult);
				}

				const serializedTransaction = Buffer.from(txn.serialize());
				const base64Transaction = serializedTransaction.toString('base64');

				return reply.send({
					success: true,
					tx: base64Transaction,
					message: `Builder escrow + approval transaction created${
						simulate ? ' and simulated' : ''
					}. Sign and send to enable this builder for the user account.`,
				});
			} catch (error) {
				await fastify.handleVelocityError(error, reply);
			}
		}
	);
};

export default Builder;
