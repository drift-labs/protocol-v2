import { EntityTypes, InsuranceFundStakeRecord, RecordTypes } from '@backend/common';
import { InsuranceFundStakeRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { archivedMetadataSchema, insuranceFundStakeSchema, metadataSchema } from '../../schemas';
import { fetchArchiveData } from '../../utils/fetch-archive-data';

const insuranceFundStake: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getInsuranceFundStakeRecords, getInsuranceFundStakeRecordsBetweenTimestamps } =
		InsuranceFundStakeRepository();

	fastify.get<{
		Params: {
			authorityId: string;
		};
		Querystring: {
			page?: string;
		};
	}>(
		'',
		{
			schema: {
				description: `<p>
					Retrieve insurance fund stake records for a authority, with optional pagination. Results are ordered from newest to oldest, with up to 20 records per request.
				</p>
				<p>
					<strong>Note:</strong> This endpoint provides records for the last 31 days.
				</p>`,
				tags: ['Authority'],
				params: {
					type: 'object',
					properties: {
						authorityId: { type: 'string' },
					},
				},
				querystring: {
					type: 'object',
					properties: {
						page: { type: 'string' },
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							records: {
								type: 'array',
								items: insuranceFundStakeSchema,
								maxItems: 20,
							},
							meta: metadataSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const authorityId = request.params.authorityId;
			const nextPage = request.getPaginationToken();
			const { records, meta } = await getInsuranceFundStakeRecords({
				id: authorityId,
				page: nextPage,
			});
			return reply.sendPaginatedResponse({ success: true, records, meta });
		}
	);

	fastify.get<{
		Params: {
			authorityId: string;
			year: number;
			month: number;
		};
		Querystring: {
			page?: number;
			format?: string;
		};
	}>(
		'/:year/:month',
		{
			config: {
				allowCsv: true,
				objectName: 'records',
			},
			schema: {
				description:
					'<p>Retrieve insurance fund stake records for a authority for a given year and month.</p>',
				tags: ['Authority'],
				params: {
					type: 'object',
					properties: {
						authorityId: { type: 'string' },
						year: {
							type: 'integer',
							minimum: 2022,
							description: 'Year in YYYY format',
						},
						month: {
							type: 'integer',
							minimum: 1,
							maximum: 12,
							description: 'Month from 1 to 12',
						},
					},
				},
				querystring: {
					type: 'object',
					properties: {
						page: { type: 'number' },
						format: { type: 'string', default: 'json', enum: ['json', 'csv'] },
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							records: {
								type: 'array',
								items: insuranceFundStakeSchema,
								maxItems: 20,
							},
							meta: archivedMetadataSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const { authorityId, year, month } = request.params;
			const page = request.query.page || 1;

			const result = await fetchArchiveData<InsuranceFundStakeRecord>({
				id: authorityId,
				year,
				month,
				page,
				entity: EntityTypes.Authority,
				recordType: RecordTypes.InsuranceFundStakeRecord,
				getLatestRecords: getInsuranceFundStakeRecordsBetweenTimestamps,
			});

			return reply.send(result);
		}
	);
};

export default insuranceFundStake;
