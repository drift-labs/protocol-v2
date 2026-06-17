import { EntityTypes, PoolSnapshotRecord, RecordTypes } from '@backend/common';
import { SnapshotRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { dlpSnapshotSchema, snapShotQuerySchema } from '../../schemas';

import { rangeForDays } from '../../utils';
import { applyPrecisions } from '../../utils/apply-precisions';

const snapshotRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getSnapshotsBetweenTimestamps } = SnapshotRepository();

	fastify.addHook('preSerialization', async (_, __, payload) => {
		return applyPrecisions(payload);
	});

	fastify.get<{
		Querystring: {
			days: number;
		};
	}>(
		'/snapshots',
		{
			schema: {
				tags: ['Stats'],
				querystring: snapShotQuerySchema,
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							snapshots: { type: 'array', items: dlpSnapshotSchema },
						},
					},
				},
			},
		},
		async function (request, reply) {
			const { startTs, endTs } = rangeForDays(request.query.days);
			const frequency = request.query.days <= 7 ? 'hourly' : 'daily';

			const snapshots = await getSnapshotsBetweenTimestamps<PoolSnapshotRecord>({
				entity: EntityTypes.Pool,
				id: 'ELgW8UwFRAUc7YpRMzJiuVVwSFmPHMW9knY6hBx9vRxa', // DLP POOL
				recordType: RecordTypes.PoolSnapshotRecord,
				startTs,
				endTs,
				frequency,
			});

			return reply.send({
				success: true,
				snapshots,
			});
		}
	);
};

export default snapshotRoutes;
