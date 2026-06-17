import {
	EarnSnapshotRecord,
	EntityTypes,
	RecordTypes,
	ReferralSnapshotRecord,
	TradeSnapshotRecord,
	VaultDepositorSnapshotRecord,
} from '@backend/common';
import { SnapshotRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import {
	earnSnapshotSchema,
	referralSnapshotSchema,
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

	const userAccumulator = (
		records:
			| (TradeSnapshotRecord | EarnSnapshotRecord | VaultDepositorSnapshotRecord)[]
			| undefined
	) => {
		return Object.values(
			(records ?? []).reduce<{
				[key: string]: {
					accountId: string;
					snapshots: (
						| TradeSnapshotRecord
						| EarnSnapshotRecord
						| VaultDepositorSnapshotRecord
					)[];
				};
			}>((acc, record) => {
				if (!acc[record.user]) {
					acc[record.user] = {
						accountId: record.user,
						snapshots: [],
					};
				}

				acc[record.user].snapshots.push(record);

				return acc;
			}, {})
		);
	};

	fastify.get<{
		Params: { authorityId: string };
		Querystring: { days: number };
	}>(
		'/overview',
		{
			schema: {
				tags: ['Authority'],
				params: {
					type: 'object',
					properties: { authorityId: { type: 'string' } },
					required: ['authorityId'],
				},
				querystring: snapShotQuerySchema,
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							products: {
								type: 'object',
								properties: {
									trade: {
										type: 'array',
										items: {
											type: 'object',
											properties: {
												accountId: { type: 'string' },
												snapshots: {
													type: 'array',
													items: tradeSnapshotSchema,
												},
												metrics: tradeSnapshotMetricsSchema,
											},
										},
									},
									earn: {
										type: 'array',
										items: {
											type: 'object',
											properties: {
												accountId: { type: 'string' },
												snapshots: {
													type: 'array',
													items: earnSnapshotSchema,
												},
											},
										},
									},
									vaults: {
										type: 'array',
										items: {
											type: 'object',
											properties: {
												accountId: { type: 'string' },
												snapshots: {
													type: 'array',
													items: vaultDepositorSnapshotSchema,
												},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
		async function (request, reply) {
			const authorityId = request.params.authorityId;
			const { startTs, endTs, frequency } = rangeForDays(request.query.days);

			const [tradeSnapshots, earnSnapshots = [], vaultSnapshots] = await Promise.all([
				getSnapshotsBetweenTimestamps<TradeSnapshotRecord>({
					entity: EntityTypes.Authority,
					id: authorityId,
					recordType: RecordTypes.TradeSnapshotRecord,
					startTs,
					endTs,
					frequency,
				}),
				getSnapshotsBetweenTimestamps<EarnSnapshotRecord>({
					entity: EntityTypes.Authority,
					id: authorityId,
					recordType: RecordTypes.EarnSnapshotRecord,
					startTs,
					endTs,
					frequency: 'daily',
				}),
				getSnapshotsBetweenTimestamps<VaultDepositorSnapshotRecord>({
					entity: EntityTypes.Authority,
					id: authorityId,
					recordType: RecordTypes.VaultDepositorSnapshotRecord,
					startTs,
					endTs,
					frequency,
				}),
			]);

			const { failed, ok: cleanSnapshots } = flagInterestOutliers(earnSnapshots);

			if (failed.length) {
				createVerifySnapshotRecords(failed);
			}

			const tradeByUser = userAccumulator(tradeSnapshots);
			const earnByUser = userAccumulator(cleanSnapshots);
			const vaultsByUser = userAccumulator(vaultSnapshots);

			const tradeWithMetrics = await Promise.all(
				tradeByUser.map(async (user) => {
					const metrics = await getUserVolumeAndFees({
						user: user.accountId,
					});

					return {
						...user,
						metrics,
					};
				})
			);

			return reply.send({
				success: true,
				products: {
					trade: tradeWithMetrics,
					earn: earnByUser,
					vaults: vaultsByUser,
				},
			});
		}
	);

	fastify.get<{
		Params: { authorityId: string };
		Querystring: { days: number };
	}>(
		'/trading',
		{
			schema: {
				tags: ['Authority'],
				params: {
					type: 'object',
					properties: { authorityId: { type: 'string' } },
					required: ['authorityId'],
				},
				querystring: snapShotQuerySchema,
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							accounts: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										accountId: { type: 'string' },
										snapshots: { type: 'array', items: tradeSnapshotSchema },
										metrics: tradeSnapshotMetricsSchema,
									},
								},
							},
						},
					},
				},
			},
		},
		async function (request, reply) {
			const authorityId = request.params.authorityId;
			const { startTs, endTs, frequency } = rangeForDays(request.query.days);

			const authorityRecords = await getSnapshotsBetweenTimestamps<TradeSnapshotRecord>({
				entity: EntityTypes.Authority,
				id: authorityId,
				recordType: RecordTypes.TradeSnapshotRecord,
				startTs,
				endTs,
				frequency,
			});

			const snapshotByUser = userAccumulator(authorityRecords);

			const accountsWithDailyChange = await Promise.all(
				snapshotByUser.map(async (user) => {
					const metrics = await getUserVolumeAndFees({ user: user.accountId });
					return { ...user, metrics };
				})
			);

			return reply.send({
				success: true,
				accounts: accountsWithDailyChange,
			});
		}
	);

	fastify.get<{
		Params: { authorityId: string };
		Querystring: { days: number };
	}>(
		'/earn',
		{
			schema: {
				tags: ['Authority'],
				params: {
					type: 'object',
					properties: { authorityId: { type: 'string' } },
					required: ['authorityId'],
				},
				querystring: snapShotQuerySchema,
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							accounts: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										accountId: { type: 'string' },
										snapshots: { type: 'array', items: earnSnapshotSchema },
									},
								},
							},
						},
					},
				},
			},
		},
		async function (request, reply) {
			const authorityId = request.params.authorityId;
			const { startTs, endTs } = rangeForDays(request.query.days);

			const authorityRecords =
				(await getSnapshotsBetweenTimestamps<EarnSnapshotRecord>({
					entity: EntityTypes.Authority,
					id: authorityId,
					recordType: RecordTypes.EarnSnapshotRecord,
					startTs,
					endTs,
					frequency: 'daily',
				})) ?? [];

			const { failed, ok: cleanSnapshots } = flagInterestOutliers(authorityRecords);

			if (failed.length) {
				createVerifySnapshotRecords(failed);
			}

			const snapshotByUser = userAccumulator(cleanSnapshots);

			return reply.send({
				success: true,
				accounts: snapshotByUser,
			});
		}
	);

	fastify.get<{
		Params: { authorityId: string };
		Querystring: { days: number };
	}>(
		'/vaults',
		{
			schema: {
				tags: ['Authority'],
				params: {
					type: 'object',
					properties: { authorityId: { type: 'string' } },
					required: ['authorityId'],
				},
				querystring: snapShotQuerySchema,
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							accounts: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										accountId: { type: 'string' },
										snapshots: {
											type: 'array',
											items: vaultDepositorSnapshotSchema,
										},
									},
								},
							},
						},
					},
				},
			},
		},
		async function (request, reply) {
			const authorityId = request.params.authorityId;
			const { startTs, endTs, frequency } = rangeForDays(request.query.days);

			const authorityRecords =
				await getSnapshotsBetweenTimestamps<VaultDepositorSnapshotRecord>({
					entity: EntityTypes.Authority,
					id: authorityId,
					recordType: RecordTypes.VaultDepositorSnapshotRecord,
					startTs,
					endTs,
					frequency,
				});

			const snapshotByUser = userAccumulator(authorityRecords);

			return reply.send({
				success: true,
				accounts: snapshotByUser,
			});
		}
	);

	fastify.get<{
		Params: { authorityId: string };
		Querystring: { days: number };
	}>(
		'/referrals',
		{
			schema: {
				tags: ['Authority'],
				params: {
					type: 'object',
					properties: { authorityId: { type: 'string' } },
					required: ['authorityId'],
				},
				querystring: snapShotQuerySchema,
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							snapshots: { type: 'array', items: referralSnapshotSchema },
						},
					},
				},
			},
		},
		async function (request, reply) {
			const authorityId = request.params.authorityId;
			const { startTs, endTs } = rangeForDays(request.query.days);

			const snapshots = await getSnapshotsBetweenTimestamps<ReferralSnapshotRecord>({
				entity: EntityTypes.Authority,
				id: authorityId,
				recordType: RecordTypes.ReferralSnapshotRecord,
				startTs,
				endTs,
				frequency: 'daily',
			});

			return reply.send({
				success: true,
				snapshots,
			});
		}
	);
};

export default snapshotRoutes;
