import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ClaimStatus, ClaimType, DevicePlatform } from '@backend/common';
import { ClaimRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { claimSchema } from '../../schemas';

const claimRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getClaim, reserveClaim, resetClaim } = ClaimRepository();
	const isDevnet = process.env.ENV === 'devnet';

	fastify.get<{
		Params: {
			campaignId: string;
		};
	}>(
		'/:campaignId',
		{
			schema: {
				hide: true,
				description: 'Get the authenticated authority claim status for a campaign',
				tags: ['Claim'],
				params: {
					type: 'object',
					required: ['campaignId'],
					properties: {
						campaignId: { type: 'string' },
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							claim: claimSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const authorityId = request.walletAddress;
			if (!authorityId) {
				return reply.code(401).send({ success: false, error: 'Unauthorized' });
			}

			const { campaignId } = request.params;
			const claim = await getClaim({ authorityId, campaignId });

			return reply.send({
				success: true,
				claim: claim ?? {
					campaignId,
					authorityId,
					status: null,
				},
			});
		}
	);

	if (isDevnet) {
		fastify.post<{
			Body: {
				campaignId: string;
			};
		}>(
			'/reset',
			{
				schema: {
					hide: false,
					description: 'Reset a claim for the authenticated authority',
					tags: ['Claim'],
					body: {
						type: 'object',
						required: ['campaignId'],
						properties: {
							campaignId: { type: 'string' },
						},
					},
					response: {
						200: {
							type: 'object',
							properties: {
								success: { type: 'boolean' },
								claim: claimSchema,
							},
						},
					},
				},
			},
			async function (request, reply) {
				const authorityId = request.walletAddress;
				if (!authorityId) {
					return reply.code(401).send({ success: false, error: 'Unauthorized' });
				}

				const { campaignId } = request.body;
				const existingClaim = await getClaim({ authorityId, campaignId });

				if (!existingClaim) {
					return reply.code(404).send({ success: false, error: 'Claim not found' });
				}

				try {
					const claim = await resetClaim({
						authorityId,
						campaignId,
					});

					return reply.send({
						success: true,
						claim,
					});
				} catch (error) {
					if (!(error instanceof ConditionalCheckFailedException)) {
						throw error;
					}

					return reply.code(404).send({ success: false, error: 'Claim not found' });
				}
			}
		);
	}

	fastify.post<{
		Body: {
			campaignId: string;
			deviceId: string;
			targetUserAccount: string;
			platform?: DevicePlatform;
		};
	}>(
		'',
		{
			schema: {
				hide: true,
				description: 'Reserve a claim for the authenticated authority',
				tags: ['Claim'],
				body: {
					type: 'object',
					required: ['campaignId', 'deviceId', 'targetUserAccount'],
					properties: {
						campaignId: { type: 'string' },
						deviceId: { type: 'string' },
						platform: {
							type: 'string',
							enum: Object.values(DevicePlatform),
						},
						targetUserAccount: { type: 'string' },
					},
				},
				response: {
					202: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							claim: claimSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const authorityId = request.walletAddress;
			if (!authorityId) {
				return reply.code(401).send({ success: false, error: 'Unauthorized' });
			}

			const { campaignId, deviceId, platform, targetUserAccount } = request.body;
			const existingClaim = await getClaim({ authorityId, campaignId });

			if (!existingClaim) {
				return reply.code(404).send({ success: false, error: 'Claim not found' });
			}

			const now = Math.floor(Date.now() / 1000);
			if (existingClaim.campaignStartTs > now || existingClaim.campaignEndTs < now) {
				return reply.code(400).send({
					success: false,
					error: 'Campaign is not active',
				});
			}

			if (existingClaim.status !== ClaimStatus.ELIGIBLE) {
				return reply.code(409).send({
					success: false,
					error: 'Claim is not available',
					claim: existingClaim,
				});
			}

			if (
				existingClaim.claimType === ClaimType.ACCRUAL &&
				((existingClaim.claimableAmount ?? 0) <= 0 ||
					(existingClaim.progressAmount ?? 0) < (existingClaim.progressCap ?? 0))
			) {
				return reply.code(409).send({
					success: false,
					error: 'Claim is not available',
					claim: existingClaim,
				});
			}

			try {
				const claim = await reserveClaim({
					authorityId,
					campaignId,
					deviceId,
					platform,
					targetUserAccount,
				});

				return reply.code(202).send({
					success: true,
					claim,
				});
			} catch (error) {
				if (!(error instanceof ConditionalCheckFailedException)) {
					throw error;
				}

				const currentClaim = await getClaim({ authorityId, campaignId });

				return reply.code(409).send({
					success: false,
					error: 'Claim has already been reserved',
					claim: currentClaim ?? existingClaim,
				});
			}
		}
	);
};

export default claimRoutes;
