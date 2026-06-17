import {
	getTimestamp,
	NotificationChannel,
	NotificationStatus,
	NotificationType,
} from '@backend/common';
import { NotificationRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { metadataSchema, notificationSchema } from '../../schemas';

const notificationRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getNotifications, updateNotificationStatus, createNotifications } =
		NotificationRepository();

	fastify.get<{
		Querystring: {
			status?: NotificationStatus;
			page?: string;
		};
	}>(
		'',
		{
			schema: {
				description: 'Get notifications for a user with optional filtering and pagination',
				tags: ['Notifications'],
				params: {
					type: 'object',
					properties: {},
				},
				querystring: {
					type: 'object',
					properties: {
						page: { type: 'string' },
						status: {
							type: 'string',
							enum: Object.values(NotificationStatus),
						},
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							records: {
								type: 'array',
								items: notificationSchema,
								maxItems: 20,
							},
							meta: metadataSchema,
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

			const { status } = request.query;
			const nextPage = request.getPaginationToken();

			const result = await getNotifications({
				authorityId,
				status: status ?? NotificationStatus.SENT,
				page: nextPage,
			});

			return reply.sendPaginatedResponse({
				success: true,
				records: result.records,
				meta: result.meta,
			});
		}
	);

	fastify.put<{
		Params: {
			notificationId: string;
		};
	}>(
		'/:notificationId/read',
		{
			schema: {
				description: 'Update notification status (e.g., mark as read)',
				tags: ['Notifications'],
				params: {
					type: 'object',
					properties: {
						notificationId: { type: 'string' },
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

			const { notificationId } = request.params;
			await updateNotificationStatus({ authorityId, notificationId });
			return reply.send({ success: true });
		}
	);

	fastify.post(
		'/send-test',
		{
			schema: {
				hide: true,
				description: 'Test sending a test notification to a device',
				tags: ['Notifications'],
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

			await createNotifications([
				{
					authorityId,
					type: NotificationType.TEST,
					status: NotificationStatus.PENDING,
					title: 'Sending Test Notification',
					body: `Message sent @ ${getTimestamp()}`,
					channels: [NotificationChannel.APP, NotificationChannel.PUSH],
				},
			]);

			return reply.send({
				success: true,
			});
		}
	);
};

export default notificationRoutes;
