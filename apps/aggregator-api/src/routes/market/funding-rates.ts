import { EntityTypes, FundingRateRecord, RecordTypes } from '@backend/common';
import { FundingRateRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { marketValidation } from '../../hooks/market-validation';
import { archivedMetadataSchema, fundingRateSchema, metadataSchema } from '../../schemas';
import { fetchArchiveData } from '../../utils/fetch-archive-data';

const fundingRateRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getFundingRateRecords, getFundingRateRecordsBetweenTimestamps } =
		FundingRateRepository();

	fastify.get<{
		Params: {
			symbol: string;
		};
		Querystring: {
			page?: string;
			limit?: number;
		};
	}>(
		'',
		{
			preValidation: marketValidation({ type: 'perp' }),
			schema: {
				description: `<p>
            Retrieve funding rates for a perp market, with optional pagination. Results are ordered from newest to oldest.
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
						limit: { type: 'number', minimum: 1, maximum: 750, default: 20 },
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							records: {
								type: 'array',
								items: fundingRateSchema,
								maxItems: 750,
							},
							meta: metadataSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const symbol = request.params.symbol;
			const limit = request.query.limit;
			const nextPage = request.getPaginationToken();
			const { records, meta } = await getFundingRateRecords({
				id: symbol,
				page: nextPage,
				limit,
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
			preValidation: marketValidation({ type: 'perp' }),
			config: {
				allowCsv: true,
				objectName: 'records',
			},
			schema: {
				description:
					'<p>Retrieve funding rates for a perp market for a given year and month.</p>',
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
								items: fundingRateSchema,
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

			const result = await fetchArchiveData<FundingRateRecord>({
				id: symbol,
				year,
				month,
				day,
				page,
				entity: EntityTypes.Market,
				recordType: RecordTypes.FundingRateRecord,
				getLatestRecords: getFundingRateRecordsBetweenTimestamps,
			});

			return reply.send(result);
		}
	);
};

export default fundingRateRoutes;
