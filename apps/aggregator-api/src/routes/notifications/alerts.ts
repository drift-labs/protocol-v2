import { AlertDirection } from '@backend/common';
import { AlertRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { marketValidation } from '../../hooks/market-validation';
import { alertSchema } from '../../schemas';

const alertRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getAlerts, createAlert, removeAlert } = AlertRepository();

	fastify.post<{
		Body: {
			symbol: string;
			targetPrice: number;
			direction: AlertDirection;
		};
	}>(
		'',
		{
			preValidation: marketValidation({ type: undefined, paramType: 'body' }),
			schema: {
				description: 'Create a new price alert',
				tags: ['Notifications'],
				body: {
					type: 'object',
					properties: {
						symbol: { type: 'string' },
						targetPrice: { type: 'number' },
						direction: {
							type: 'string',
							enum: ['ABOVE', 'BELOW'],
						},
					},
					required: ['symbol', 'targetPrice', 'direction'],
					additionalProperties: false,
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							alert: alertSchema,
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

			const { symbol, targetPrice, direction } = request.body;

			const alert = await createAlert({
				authorityId,
				symbol,
				targetPrice,
				direction,
			});

			return reply.send({
				success: true,
				alert,
			});
		}
	);

	fastify.get(
		'',
		{
			schema: {
				description: 'Get all alerts for a user',
				tags: ['Notifications'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							alerts: {
								type: 'array',
								items: alertSchema,
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

			const alerts = await getAlerts({
				authorityId,
			});

			return reply.send({
				success: true,
				alerts,
			});
		}
	);

	fastify.delete<{
		Params: {
			alertId: string;
		};
	}>(
		'/:alertId',
		{
			schema: {
				description: 'Delete an alert',
				tags: ['Notifications'],
				params: {
					type: 'object',
					properties: {
						alertId: { type: 'string' },
					},
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

			const { alertId } = request.params;

			await removeAlert({
				authorityId,
				alertId,
			});

			return reply.send({
				success: true,
			});
		}
	);
};

export default alertRoutes;
