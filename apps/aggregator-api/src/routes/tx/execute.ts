import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { FastifyPluginAsync } from 'fastify';

const Execute: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.post<{
		Body: {
			signedTx: string;
			simulate?: boolean;
		};
	}>(
		'/execute',
		{
			schema: {
				description: `<strong>This endpoint is currently in BETA and should only be used for test purposes</strong> <br>Send a signed transaction to be executed on chain. Optionally simulate before executing to catch errors early.`,
				tags: ['Transactions'],
				body: {
					type: 'object',
					properties: {
						signedTx: {
							type: 'string',
							description: 'Base64 encoded signed transaction',
						},
						simulate: {
							type: 'boolean',
							description:
								'Simulate transaction before executing to catch potential errors (default: true)',
							default: false,
						},
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							txSig: { type: 'string' },
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
						},
					},
				},
			},
		},
		async function (request, reply) {
			try {
				const { signedTx, simulate = false } = request.body;

				if (!signedTx) {
					return reply.status(400).send({
						success: false,
						error: 'Missing signedTransaction in request body',
					});
				}

				const txBuffer = Buffer.from(signedTx, 'base64');
				let transaction: Transaction | VersionedTransaction;

				try {
					transaction = VersionedTransaction.deserialize(txBuffer);
				} catch {
					transaction = Transaction.from(txBuffer);
				}

				const simResult = await fastify.simulateTransaction(transaction, {
					skipSimulation: !simulate,
				});

				if (!simResult.success) {
					return reply.status(400).send(simResult);
				}

				const { txSig } = await fastify.centralServerVelocity.sendSignedTransaction(
					transaction
				);

				return reply.send({
					success: true,
					txSig: txSig,
					message: 'Transaction executed successfully',
				});
			} catch (error) {
				await fastify.handleVelocityError(error, reply);
			}
		}
	);
};

export default Execute;
