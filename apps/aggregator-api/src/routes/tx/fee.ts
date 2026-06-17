import { logger } from '@backend/common';
import { DEFAULT_RATE_LIMITS, RateLimitMetric } from '@backend/dynamodb';
import { BorshInstructionCoder, Idl, Program } from '@coral-xyz/anchor';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';
import { PrivyClient } from '@privy-io/server-auth';
import {
	ComputeBudgetProgram,
	Keypair,
	Transaction,
	TransactionInstruction,
	VersionedTransaction,
} from '@solana/web3.js';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
	createRateLimitHook,
	createRateLimitTrackingHook,
	RateLimitRequestDecorator,
} from '../../hooks/rate-limit';

interface AuthenticatedRequest
	extends FastifyRequest<{
			Body: {
				serializedTransaction: string;
			};
		}>,
		RateLimitRequestDecorator {
	userId?: string;
}

// const ALLOWED_VELOCITY_INSTRUCTIONS = new Set<string>([
// 	'placePerpOrder',
// 	'placeSpotOrder',
// 	'cancelOrder',
// ]);

const ALLOWED_NON_VELOCITY_PROGRAMS = new Set<string>([
	'ComputeBudget111111111111111111111111111111',
	'Ed25519SigVerify111111111111111111111111111',
	'11111111111111111111111111111111',
]);

const FeePayerRoute: FastifyPluginAsync = async (fastify): Promise<void> => {
	const FEE_PAYER_PRIVATE_KEY = process.env.FEE_PAYER_PRIVATE_KEY;
	const PRIVY_APP_ID = process.env.PRIVY_APP_ID!;
	const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET!;
	const PRIVY_VERIFICATION_KEY = process.env.PRIVY_VERIFICATION_KEY;

	const privyClient = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);

	if (!PRIVY_APP_ID || !PRIVY_APP_SECRET || !PRIVY_VERIFICATION_KEY) {
		throw new Error('PRIVY_APP_ID, PRIVY_SECRET, and PRIVY_VERIFICATION_KEY must be set');
	}

	const ensureRouteEnabled = async (_request: FastifyRequest, reply: FastifyReply) => {
		if (process.env.FEE_PAYER_ROUTE_DISABLED === 'true') {
			return reply.status(503).send({
				success: false,
				error: 'Fee payer route is temporarily disabled',
			});
		}
	};

	const verifyAccessToken = async (request: AuthenticatedRequest) => {
		const accessToken = request.headers.authorization?.replace('Bearer ', '');
		if (!accessToken) {
			return null;
		}
		try {
			const isVerified = await privyClient.verifyAuthToken(
				accessToken,
				PRIVY_VERIFICATION_KEY
			);
			return isVerified.userId;
		} catch (error) {
			const { message } = error as Error;
			logger.warn(`Error when verifying with privy: ${message}`);
			return null;
		}
	};

	const extractComputeBudgetParams = (
		serializedTx: Uint8Array | Buffer
	): {
		computeUnits?: number;
		computeUnitsPrice?: number;
	} => {
		const result: { computeUnits?: number; computeUnitsPrice?: number } = {};

		let transaction: Transaction | VersionedTransaction;

		try {
			transaction = VersionedTransaction.deserialize(
				serializedTx as Uint8Array<ArrayBufferLike>
			);
		} catch {
			transaction = Transaction.from(serializedTx);
		}

		let instructions: TransactionInstruction[];
		if (transaction instanceof VersionedTransaction) {
			instructions = transaction.message.compiledInstructions.map((ix) => {
				return new TransactionInstruction({
					programId: transaction.message.staticAccountKeys[ix.programIdIndex],
					keys: ix.accountKeyIndexes.map((idx) => ({
						pubkey: transaction.message.staticAccountKeys[idx],
						isSigner: false,
						isWritable: false,
					})),
					data: Buffer.from(ix.data),
				});
			});
		} else {
			instructions = transaction.instructions;
		}

		for (const ix of instructions) {
			if (ix.programId.equals(ComputeBudgetProgram.programId)) {
				const discriminator = ix.data[0];
				if (discriminator === 2) {
					result.computeUnits = ix.data.readUInt32LE(1);
				} else if (discriminator === 3) {
					result.computeUnitsPrice = Number(ix.data.readBigUInt64LE(1));
				}
			}
		}

		return result;
	};

	const decodeAndValidateVelocityInstructions = (
		tx: VersionedTransaction,
		velocityProgram: Program
	) => {
		const msg = tx.message;
		const accountKeys = msg.staticAccountKeys;
		const ixCoder = new BorshInstructionCoder(velocityProgram.idl as Idl);

		const decodedVelocityIxs = [];
		const seenNonVelocityPrograms = new Set<string>();

		for (const compiledIx of msg.compiledInstructions) {
			const programId = accountKeys[compiledIx.programIdIndex];
			const programIdStr = programId.toBase58();

			if (programId.equals(velocityProgram.programId)) {
				const ixData = Buffer.from(compiledIx.data);
				const decodedIx = ixCoder.decode(ixData);

				if (!decodedIx) {
					throw new Error('Failed to decode Velocity instruction');
				}

				// if (!ALLOWED_VELOCITY_INSTRUCTIONS.has(decodedIx.name)) {
				// 	throw new Error(`Disallowed Velocity instruction: ${decodedIx.name}`);
				// }

				const accounts = compiledIx.accountKeyIndexes.map((idx) => accountKeys[idx]);

				decodedVelocityIxs.push({
					name: decodedIx.name,
					data: decodedIx.data,
					programId,
					accounts,
				});

				continue;
			}

			if (!ALLOWED_NON_VELOCITY_PROGRAMS.has(programIdStr)) {
				seenNonVelocityPrograms.add(programIdStr);
			}
		}

		if (decodedVelocityIxs.length === 0) {
			throw new Error('No Velocity instructions found in transaction');
		}

		if (seenNonVelocityPrograms.size > 0) {
			throw new Error('Transaction contains disallowed non-Velocity program IDs');
		}

		return decodedVelocityIxs;
	};

	fastify.post<{
		Body: {
			serializedTransaction: string;
		};
	}>(
		'/sign',
		{
			schema: {
				hide: true,
				description:
					'Sign a transaction using the fee payer with rate limiting on priority fees.',
				tags: ['Transactions'],
				body: {
					type: 'object',
					required: ['serializedTransaction'],
					properties: {
						serializedTransaction: {
							type: 'string',
							description: 'Base64 encoded serialized transaction',
						},
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							tx: { type: 'string' },
						},
					},
					400: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							error: { type: 'string' },
						},
					},
					401: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							error: { type: 'string' },
						},
					},
					403: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							error: { type: 'string' },
						},
					},
					429: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							error: { type: 'string' },
							metric: { type: 'string' },
							currentUsage: { type: 'number' },
							limit: { type: 'number' },
						},
					},
				},
			},
			preHandler: [
				ensureRouteEnabled,

				async (request: AuthenticatedRequest, reply) => {
					const userId = await verifyAccessToken(request);
					if (!userId) {
						return reply.status(401).send({
							success: false,
							error: 'Unauthorized user',
						});
					}
					request.userId = userId;
				},
				async (request: AuthenticatedRequest, reply) => {
					const { serializedTransaction } = request.body;
					const transactionBuffer = Buffer.from(serializedTransaction, 'base64');
					const { computeUnits, computeUnitsPrice } =
						extractComputeBudgetParams(transactionBuffer);

					if (!computeUnits || !computeUnitsPrice) {
						return reply.status(403).send({
							success: false,
							error: 'Unable to get priority fees',
						});
					}

					request.rateLimit = {
						priorityFees: (computeUnits * computeUnitsPrice) / 1_000_000,
					};
				},

				createRateLimitHook({
					limits: [
						{
							metric: RateLimitMetric.PriorityFees,
							valueExtractor: (request: AuthenticatedRequest) =>
								request.rateLimit?.priorityFees || 0,
							limit: process.env.PRIORITY_FEE_LIMIT
								? Number(process.env.PRIORITY_FEE_LIMIT)
								: DEFAULT_RATE_LIMITS[RateLimitMetric.PriorityFees],
						},
					],
					getId: (request: AuthenticatedRequest) => request.userId || null,
				}),
			],

			onResponse: createRateLimitTrackingHook({
				metrics: [
					{
						metric: RateLimitMetric.PriorityFees,
						valueExtractor: (request: AuthenticatedRequest) =>
							request.rateLimit?.priorityFees || 0,
					},
				],
				getId: (request: AuthenticatedRequest) => request.userId || null,
			}),
		},
		async function (request: AuthenticatedRequest, reply) {
			if (!FEE_PAYER_PRIVATE_KEY) {
				return reply.status(400).send({
					success: false,
					error: 'FEE_PAYER is not set',
				});
			}

			const { serializedTransaction } = request.body;

			const transactionBuffer = Buffer.from(serializedTransaction, 'base64');
			const transaction = VersionedTransaction.deserialize(
				transactionBuffer as unknown as Uint8Array
			);

			try {
				// MethodsNamespace<Drift> isn't assignable to MethodsNamespace<Idl> — Anchor's
				// generic namespaces are invariant in the IDL parameter, so the strongly-typed
				// program can't widen to the generic Program<Idl>. The function only uses
				// .idl and .programId, so the runtime contract is unaffected.
				decodeAndValidateVelocityInstructions(
					transaction,
					fastify.centralServerVelocity.velocityClient.program as unknown as Program
				);
			} catch (error) {
				const { message } = error as Error;
				return reply.status(400).send({
					success: false,
					error: message,
				});
			}

			const feePayerWallet = Keypair.fromSecretKey(
				bs58.decode(FEE_PAYER_PRIVATE_KEY) as unknown as Uint8Array
			);

			const message = transaction.message;
			const accountKeys = message.staticAccountKeys;
			const feePayer = accountKeys[0];

			if (!feePayer?.equals(feePayerWallet.publicKey)) {
				return reply.status(403).send({
					success: false,
					error: 'Transaction is not using the correct fee payer',
				});
			}

			transaction.sign([feePayerWallet]);

			const tx = Buffer.from(transaction.serialize()).toString('base64');

			return reply.send({
				success: true,
				tx,
			});
		}
	);
};

export default FeePayerRoute;
