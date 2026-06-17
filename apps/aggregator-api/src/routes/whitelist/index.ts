import { WhitelistRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { validationErrorMessages } from '../../errors/validation-messages';
import { solanaAuth } from '../../hooks/solana-auth';
import { whitelistSchema } from '../../schemas';

const whitelistRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { createWhitelist, getWhitelist, updateWhitelist, removeWhitelist } =
		WhitelistRepository();

	fastify.addHook('preHandler', solanaAuth);
	fastify.setErrorHandler(validationErrorMessages);

	fastify.addSchema({
		$id: 'whitelistAuthHeaders',
		type: 'object',
		required: ['x-wallet-address', 'x-signature', 'x-signed-message'],
		properties: {
			'x-wallet-address': {
				type: 'string',
				description: 'Solana wallet address',
			},
			'x-signature': {
				type: 'string',
				description: 'Signed message signature',
			},
			'x-signed-message': {
				type: 'string',
				description:
					'JSON string containing timestamp and action. Format: {"action": "string", "ts": "Unix timestamp (seconds)", "walletAddress": "string", "isDelegate"?: boolean, "driftUserAccount"?: "string"}',
			},
		},
	});

	fastify.addHook('onRoute', (routeOptions) => {
		if (!routeOptions.schema) routeOptions.schema = {};
		routeOptions.schema.headers = { $ref: 'whitelistAuthHeaders#' };
		routeOptions.schema.hide = true;
	});

	fastify.post<{
		Body: {
			address: string;
			label: string;
			token: string;
			chainId: string;
		};
	}>(
		'',
		{
			schema: {
				description: 'Create a whitelist item',
				body: {
					type: 'object',
					properties: {
						address: { type: 'string' },
						label: { type: 'string' },
						token: { type: 'string' },
						chainId: { type: 'string' },
					},
					required: ['address', 'label', 'token', 'chainId'],
					additionalProperties: false,
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							item: whitelistSchema,
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

			const { address, label, token, chainId } = request.body;

			const item = await createWhitelist({
				authorityId,
				address,
				label,
				token,
				chainId,
			});

			return reply.send({
				success: true,
				item,
			});
		}
	);

	fastify.get(
		'',
		{
			schema: {
				description: 'Get all whitelist items for a user',
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							items: {
								type: 'array',
								items: whitelistSchema,
							},
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

			const items = await getWhitelist({ authorityId });

			return reply.send({
				success: true,
				items,
			});
		}
	);

	fastify.put<{
		Params: {
			whitelistId: string;
		};
		Body: {
			address: string;
			label: string;
			token: string;
			chainId: string;
		};
	}>(
		'/:whitelistId',
		{
			schema: {
				description: 'Update a whitelist item',
				params: {
					type: 'object',
					properties: {
						whitelistId: { type: 'string' },
					},
					required: ['whitelistId'],
				},
				body: {
					type: 'object',
					properties: {
						address: { type: 'string' },
						label: { type: 'string' },
						token: { type: 'string' },
						chainId: { type: 'string' },
					},
					required: ['address', 'label', 'token', 'chainId'],
					additionalProperties: false,
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							item: whitelistSchema,
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

			const { whitelistId } = request.params;
			const { address, label, token, chainId } = request.body;

			const item = await updateWhitelist({
				authorityId,
				whitelistId,
				address,
				label,
				token,
				chainId,
			});

			return reply.send({
				success: true,
				item,
			});
		}
	);

	fastify.delete<{
		Params: {
			whitelistId: string;
		};
	}>(
		'/:whitelistId',
		{
			schema: {
				description: 'Delete a whitelist item',
				params: {
					type: 'object',
					properties: {
						whitelistId: { type: 'string' },
					},
					required: ['whitelistId'],
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
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

			const { whitelistId } = request.params;

			await removeWhitelist({
				authorityId,
				whitelistId,
			});

			return reply.send({
				success: true,
			});
		}
	);
};

export default whitelistRoutes;
