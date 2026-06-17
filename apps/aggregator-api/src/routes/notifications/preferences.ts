import { NotificationType } from '@backend/common';
import { NotificationRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { notificationPreferencesSchema } from '../../schemas';

const preferencesRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getPreferences, upsertPreferences } = NotificationRepository();

	fastify.get(
		'/preferences',
		{
			schema: {
				description: 'Get notification preferences for an account',
				tags: ['Notifications'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							preferences: notificationPreferencesSchema,
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

			const preferences = await getPreferences(authorityId);

			return reply.send({
				success: true,
				preferences: preferences ?? {
					authorityId,
					pushOptOutTypes: [],
				},
			});
		}
	);

	fastify.put<{
		Body: {
			pushOptOutTypes: NotificationType[];
		};
	}>(
		'/preferences',
		{
			schema: {
				description: 'Update notification preferences for an account',
				tags: ['Notifications'],
				body: {
					type: 'object',
					properties: {
						pushOptOutTypes: {
							type: 'array',
							items: {
								type: 'string',
								enum: Object.values(NotificationType),
							},
							uniqueItems: true,
						},
					},
					required: ['pushOptOutTypes'],
					additionalProperties: false,
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							preferences: notificationPreferencesSchema,
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

			const { pushOptOutTypes } = request.body;
			const uniqueOptOutTypes = [...new Set(pushOptOutTypes)];

			const preferences = await upsertPreferences({
				authorityId,
				pushOptOutTypes: uniqueOptOutTypes,
			});

			return reply.send({
				success: true,
				preferences,
			});
		}
	);
};

export default preferencesRoutes;
