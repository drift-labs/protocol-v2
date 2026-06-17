import { DepositRecord, EntityTypes, RecordTypes } from '@backend/common';
import { DepositRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { marketValidation } from '../../hooks/market-validation';
import { archivedMetadataSchema, depositSchema, metadataSchema } from '../../schemas';
import { fetchArchiveData } from '../../utils/fetch-archive-data';

const depositRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getDepositRecords, getDepositRecordsBetweenTimestamps } = DepositRepository();

	fastify.get<{
		Params: {
			symbol: string;
		};
		Querystring: {
			page?: string;
		};
	}>(
		'',
		{
			preValidation: marketValidation({ type: 'spot' }),
			schema: {
				description: `<p>
					Retrieve deposit records for a market, with optional pagination. Results are ordered from newest to oldest, with up to 20 records per request.
				</p>
				<p>
					<strong>Note:</strong> This endpoint provides records for the last 31 days.
				</p>`,
				tags: ['Market'],
				params: {
					type: 'object',
					properties: {
						symbol: { type: 'string' },
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
								items: depositSchema,
								maxItems: 20,
							},
							meta: metadataSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const symbol = request.params.symbol;
			const nextPage = request.getPaginationToken();
			const { records, meta } = await getDepositRecords({
				id: symbol,
				entity: EntityTypes.Market,
				page: nextPage,
			});
			return reply.sendPaginatedResponse({ success: true, records, meta });
		}
	);

	fastify.get<{
		Params: {
			symbol: string;
			year: number;
			month: number;
			day: number;
		};
		Querystring: {
			page?: number;
			format?: string;
		};
	}>(
		'/:year/:month/:day',
		{
			preValidation: marketValidation({}),
			config: {
				allowCsv: true,
				objectName: 'records',
			},
			schema: {
				description:
					'<p>Retrieve deposit records for a market for a given year and month.</p>',
				tags: ['Market'],
				params: {
					type: 'object',
					properties: {
						symbol: { type: 'string' },
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
						day: {
							type: 'integer',
							minimum: 1,
							maximum: 31,
							description: 'Day from 1 to 31',
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
								items: depositSchema,
								maxItems: 20,
							},
							meta: archivedMetadataSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const { symbol, year, month, day } = request.params;
			const page = request.query.page || 1;

			const result = await fetchArchiveData<DepositRecord>({
				id: symbol,
				year,
				month,
				day,
				page,
				recordType: RecordTypes.DepositRecord,
				entity: EntityTypes.Market,
				getLatestRecords: getDepositRecordsBetweenTimestamps,
			});

			return reply.send(result);
		}
	);
};

export default depositRoutes;
