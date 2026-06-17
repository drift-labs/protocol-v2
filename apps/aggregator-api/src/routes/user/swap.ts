import { RecordTypes, SwapRecord } from '@backend/common';
import { SwapRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { archivedMetadataSchema, metadataSchema, swapSchema } from '../../schemas';
import { fetchArchiveData } from '../../utils/fetch-archive-data';

const swapRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getSwapRecords, getSwapRecordsBetweenTimestamps } = SwapRepository();

	fastify.get<{
		Params: {
			accountId: string;
		};
		Querystring: {
			page?: string;
		};
	}>(
		'',
		{
			schema: {
				description: `<p>
					Retrieve swap records for a specific account, with optional pagination. Results are ordered from newest to oldest, with up to 20 records per request.
				</p>
				<p>
					<strong>Note:</strong> This endpoint provides records for the last 31 days.
				</p>`,
				tags: ['User'],
				params: {
					type: 'object',
					properties: {
						accountId: { type: 'string' },
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
								items: swapSchema,
								maxItems: 20,
							},
							meta: metadataSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const accountId = request.params.accountId;
			const nextPage = request.getPaginationToken();
			const { records, meta } = await getSwapRecords({ id: accountId, page: nextPage });
			return reply.sendPaginatedResponse({ success: true, records, meta });
		}
	);

	fastify.get<{
		Params: {
			accountId: string;
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
					'<p>Retrieve trade records for a specific account for a given year and month.</p>',
				tags: ['User'],
				params: {
					type: 'object',
					properties: {
						accountId: { type: 'string' },
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
								items: swapSchema,
								maxItems: 20,
							},
							meta: archivedMetadataSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const { accountId, year, month } = request.params;
			const page = request.query.page || 1;

			const result = await fetchArchiveData<SwapRecord>({
				id: accountId,
				year,
				month,
				page,
				recordType: RecordTypes.SwapRecord,
				getLatestRecords: getSwapRecordsBetweenTimestamps,
			});

			return reply.send(result);
		}
	);
};

export default swapRoutes;
