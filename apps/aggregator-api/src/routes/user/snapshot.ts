import {
	EarnSnapshotRecord,
	EntityTypes,
	RecordTypes,
	TradeSnapshotRecord,
	VaultDepositorSnapshotRecord,
} from '@backend/common';
import { SnapshotRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import {
	earnSnapshotSchema,
	snapShotQuerySchema,
	tradeSnapshotMetricsSchema,
	tradeSnapshotSchema,
	vaultDepositorSnapshotSchema,
} from '../../schemas';

import { flagInterestOutliers, rangeForDays } from '../../utils';
import { applyPrecisions } from '../../utils/apply-precisions';
import { CacheProxyClient } from '../../utils/cache-proxy-client';

const snapshotRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getSnapshotsBetweenTimestamps, createVerifySnapshotRecords } = SnapshotRepository();
	const { getUserVolumeAndFees } = CacheProxyClient();

	fastify.addHook('preSerialization', async (_, __, payload) => {
		return applyPrecisions(payload);
	});

	fastify.get<{
		Params: {
			accountId: string;
		};
		Querystring: {
			days: number;
		};
	}>(
		'/trading',
		{
			schema: {
				tags: ['User'],
				params: {
					type: 'object',
					properties: { accountId: { type: 'string' } },
					required: ['accountId'],
				},
				querystring: snapShotQuerySchema,
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							snapshots: { type: 'array', items: tradeSnapshotSchema },
							metrics: tradeSnapshotMetricsSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const accountId = request.params.accountId;
			const { startTs, endTs, frequency } = rangeForDays(request.query.days);
			const [snapshots, metrics] = await Promise.all([
				getSnapshotsBetweenTimestamps<TradeSnapshotRecord>({
					entity: EntityTypes.User,
					id: accountId,
					recordType: RecordTypes.TradeSnapshotRecord,
					startTs,
					endTs,
					frequency,
				}),
				getUserVolumeAndFees({ user: accountId }),
			]);

			return reply.send({
				success: true,
				snapshots,
				metrics,
			});
		}
	);

	fastify.get<{
		Params: { accountId: string };
		Querystring: { days: number };
	}>(
		'/earn',
		{
			schema: {
				tags: ['User'],
				params: {
					type: 'object',
					properties: { accountId: { type: 'string' } },
					required: ['accountId'],
				},
				querystring: snapShotQuerySchema,
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							snapshots: { type: 'array', items: earnSnapshotSchema },
							meta: {
								flagged: { type: 'number ' },
							},
						},
					},
				},
			},
		},
		async function (request, reply) {
			const accountId = request.params.accountId;
			const { startTs, endTs } = rangeForDays(request.query.days);

			const snapshots =
				(await getSnapshotsBetweenTimestamps<EarnSnapshotRecord>({
					entity: EntityTypes.User,
					id: accountId,
					recordType: RecordTypes.EarnSnapshotRecord,
					startTs,
					endTs,
					frequency: 'daily',
				})) ?? [];

			const { failed, ok } = flagInterestOutliers(snapshots);

			if (failed.length) {
				createVerifySnapshotRecords(failed);
			}

			return reply.send({
				success: true,
				snapshots: ok,
				meta: { flagged: failed.length },
			});
		}
	);

	fastify.get<{
		Params: { accountId: string };
		Querystring: { days: number };
	}>(
		'/vaults',
		{
			schema: {
				tags: ['User'],
				params: {
					type: 'object',
					properties: { accountId: { type: 'string' } },
					required: ['accountId'],
				},
				querystring: snapShotQuerySchema,
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							snapshots: { type: 'array', items: vaultDepositorSnapshotSchema },
						},
					},
				},
			},
		},
		async function (request, reply) {
			const accountId = request.params.accountId;
			const { startTs, endTs, frequency } = rangeForDays(request.query.days);

			const snapshots = await getSnapshotsBetweenTimestamps<VaultDepositorSnapshotRecord>({
				entity: EntityTypes.User,
				id: accountId,
				recordType: RecordTypes.VaultDepositorSnapshotRecord,
				startTs,
				endTs,
				frequency,
			});

			return reply.send({ success: true, snapshots });
		}
	);
};

export default snapshotRoutes;
