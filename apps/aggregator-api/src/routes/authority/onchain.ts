import { PublicKey } from '@solana/web3.js';
import {
	getRevenueShareAccountPublicKey,
	getRevenueShareEscrowAccountPublicKey,
} from '@velocity-exchange/sdk';
import { FastifyPluginAsync } from 'fastify';

type RevenueShareEscrowLike = {
	approvedBuilders: {
		authority: PublicKey;
		maxFeeTenthBps: number;
	}[];
};

type RevenueShareLike = {
	totalBuilderRewards: {
		toString: () => string;
	};
};

function buildAuthorityResponse(args: {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	users: any[];
	builderRevenueShareAccountPubkey: PublicKey | null;
	revenueShareEscrowPubkey: PublicKey | null;
	builderRevenueShareAccountData: RevenueShareLike | null;
	revenueShareEscrowData: RevenueShareEscrowLike | null;
}) {
	const {
		users,
		builderRevenueShareAccountPubkey,
		revenueShareEscrowPubkey,
		builderRevenueShareAccountData,
		revenueShareEscrowData,
	} = args;

	const approvedBuilders =
		revenueShareEscrowData?.approvedBuilders
			.filter((builder) => builder.maxFeeTenthBps > 0)
			.map((builder) => ({
				authority: builder.authority.toString(),
				maxFeeTenthBps: builder.maxFeeTenthBps,
			})) ?? [];

	return {
		success: true,
		builderRevenueShareAccount:
			builderRevenueShareAccountData && builderRevenueShareAccountPubkey
				? {
						accountId: builderRevenueShareAccountPubkey.toString(),
						totalBuilderRewards:
							builderRevenueShareAccountData.totalBuilderRewards.toString(),
				  }
				: null,
		revenueShareEscrow:
			revenueShareEscrowData && revenueShareEscrowPubkey
				? {
						accountId: revenueShareEscrowPubkey.toString(),
						approvedBuilders,
				  }
				: null,
		accounts: users.map((user) => ({
			accountId: user.publicKey.toString(),
			subAccountId: user.account.subAccountId,
			name: Buffer.from(user.account.name).toString('utf8').replace(/\0/g, '').trim(),
		})),
	};
}

const Onchain: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.get<{
		Params: {
			authorityId: string;
		};
	}>(
		'/:authorityId/accounts',
		{
			schema: {
				description: `<strong>This endpoint is currently in BETA and should only be used for test purposes</strong> <br>Retrieve the drift user accounts for a given wallet.`,
				tags: ['Authority'],
				params: {
					type: 'object',
					properties: {
						authorityId: { type: 'string' },
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							builderRevenueShareAccount: {
								type: 'object',
								nullable: true,
								properties: {
									accountId: { type: 'string' },
									totalBuilderRewards: { type: 'string' },
								},
							},
							revenueShareEscrow: {
								type: 'object',
								nullable: true,
								properties: {
									accountId: { type: 'string' },
									approvedBuilders: {
										type: 'array',
										items: {
											type: 'object',
											properties: {
												authority: { type: 'string' },
												maxFeeTenthBps: { type: 'number' },
											},
										},
									},
								},
							},
							accounts: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										accountId: { type: 'string' },
										subAccountId: { type: 'number' },
										name: { type: 'string' },
									},
								},
							},
						},
					},
				},
			},
		},
		async function (request, reply) {
			const { authorityId } = request.params;

			let publicKey: PublicKey;
			try {
				publicKey = new PublicKey(authorityId);
			} catch (error) {
				return reply.code(400).send({
					error: 'ValidationError',
					message: `Invalid account ID format: ${authorityId}`,
				});
			}

			const revenueShareEscrowPubkey = getRevenueShareEscrowAccountPublicKey(
				fastify.velocityClient.program.programId,
				publicKey
			);
			const builderRevenueShareAccountPubkey = getRevenueShareAccountPublicKey(
				fastify.velocityClient.program.programId,
				publicKey
			);

			const [users, revenueShareEscrow, builderRevenueShareAccount] = await Promise.all([
				fastify.velocityClient.getUserAccountsAndAddressesForAuthority(publicKey),
				fastify.velocityClient.program.account.revenueShareEscrow.fetchNullable(
					revenueShareEscrowPubkey
				),
				fastify.velocityClient.program.account.revenueShare.fetchNullable(
					builderRevenueShareAccountPubkey
				),
			]);

			return buildAuthorityResponse({
				users,
				builderRevenueShareAccountPubkey,
				revenueShareEscrowPubkey,
				builderRevenueShareAccountData:
					builderRevenueShareAccount as RevenueShareLike | null,
				revenueShareEscrowData: revenueShareEscrow as RevenueShareEscrowLike | null,
			});
		}
	);
};

export default Onchain;
