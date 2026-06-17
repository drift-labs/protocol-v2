import { NotificationChannel, NotificationStatus, NotificationType } from '@backend/common';
import { NotificationRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';

// `type` is intentionally a free-form string: the notifier providers
// (firebase, redis, dialect) all dispatch on `channels`, not on `type`.
// Dialect uses `type` only to pick a template id and falls back to
// DEFAULT_DIALECT_NOTIFICATION_TYPE_ID for unknown values, so dashboard
// types pass through fine.
const createBodySchema = {
	type: 'object',
	required: ['authorityIds', 'title', 'body', 'type'],
	properties: {
		authorityIds: {
			type: 'array',
			items: { type: 'string', minLength: 1 },
			minItems: 1,
			maxItems: 10000,
		},
		title: { type: 'string', minLength: 1 },
		body: { type: 'string', minLength: 1 },
		type: { type: 'string', minLength: 1 },
		channels: {
			type: 'array',
			items: { type: 'string', enum: Object.values(NotificationChannel) },
			uniqueItems: true,
			minItems: 1,
		},
		data: { type: 'object', additionalProperties: true },
		actions: {
			type: 'array',
			items: {
				type: 'object',
				required: ['label', 'link'],
				properties: {
					label: { type: 'string' },
					link: { type: 'string' },
				},
			},
		},
		ttlSeconds: { type: 'integer', minimum: 60, maximum: 60 * 60 * 24 * 365 },
	},
	additionalProperties: false,
} as const;

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days

const notificationsRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { createNotifications } = NotificationRepository();

	fastify.post<{
		Body: {
			authorityIds: string[];
			title: string;
			body: string;
			type: string;
			channels?: NotificationChannel[];
			data?: Record<string, unknown>;
			actions?: { label: string; link: string }[];
			ttlSeconds?: number;
		};
	}>(
		'',
		{
			schema: {
				hide: true,
				description:
					'Create PENDING notification rows for a list of authorities. The realtime-archiver Dynamo stream → EventBridge Pipe → notifier Lambda chain delivers them.',
				tags: ['Admin'],
				body: createBodySchema,
				response: {
					201: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							count: { type: 'integer' },
						},
					},
				},
			},
		},
		async (request, reply) => {
			const { authorityIds, title, body, type, channels, data, actions, ttlSeconds } =
				request.body;

			const records = authorityIds.map((authorityId) => ({
				authorityId,
				title,
				body,
				// Repo signature is typed against the enum in @backend/common;
				// dashboard-specific values pass through to Dialect's default
				// template (providers dispatch on `channels`, not `type`).
				type: type as NotificationType,
				status: NotificationStatus.PENDING,
				channels: channels ?? [NotificationChannel.APP],
				data,
				actions,
			}));

			await createNotifications(records, {
				ttlSeconds: ttlSeconds ?? DEFAULT_TTL_SECONDS,
			});

			return reply.code(201).send({ success: true, count: records.length });
		}
	);
};

export default notificationsRoutes;
