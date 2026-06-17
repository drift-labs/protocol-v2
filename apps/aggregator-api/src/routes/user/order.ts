import { SerializedMarketFilter } from '@backend/common';
import { OrderRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { marketValidation } from '../../hooks/market-validation';
import { metadataSchema, orderActionSchema, orderSchema } from '../../schemas';

const orderRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	// Order routes
	const { getOrderRecords, getOrderActionRecords, getOrderRecordFromAction } = OrderRepository();

	fastify.get<{
		Params: {
			accountId: string;
			marketFilter: SerializedMarketFilter;
		};
		Querystring: {
			page?: string;
			hasFill?: boolean;
			startTs?: number;
			endTs?: number;
		};
	}>(
		'/:marketFilter',
		{
			schema: {
				description: `<p>
					Retrieve orders for a specific account and market type, with optional pagination. Results are ordered from newest to oldest, with up to 20 records per request.
				</p>
				<p>
					<strong>Note:</strong> This endpoint provides records for the last 31 days.
				</p>`,
				tags: ['User'],
				params: {
					type: 'object',
					properties: {
						accountId: { type: 'string' },
						marketFilter: {
							type: 'string',
							enum: Object.values(SerializedMarketFilter),
						},
					},
				},
				querystring: {
					type: 'object',
					properties: {
						page: { type: 'string' },
						startTs: {
							type: 'number',
							description: 'Start timestamp (unix seconds).',
						},
						endTs: {
							type: 'number',
							description: 'End timestamp (unix seconds).',
						},
						hasFill: {
							type: 'boolean',
							description:
								'When true, only orders with at least one fill are returned.',
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
								items: orderSchema,
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
			const marketFilter = request.params.marketFilter;
			const nextPage = request.getPaginationToken();
			const hasFill = request.query.hasFill;
			const { startTs, endTs } = request.query;

			const { records, meta } = await getOrderRecords({
				id: accountId,
				marketFilter,
				page: nextPage,
				hasFill,
				startTs,
				endTs,
			});
			return reply.sendPaginatedResponse({ success: true, records, meta });
		}
	);

	fastify.get<{
		Params: {
			accountId: string;
			orderId: number;
		};
	}>(
		'/id/:orderId',
		{
			schema: {
				description: `<p>
					Retrieve order for user by orderId.
				</p>
				<p>
					<strong>Note:</strong> This endpoint provides orders within the last 31 days.
				</p>`,
				tags: ['User'],
				params: {
					type: 'object',
					properties: {
						accountId: { type: 'string' },
						orderId: {
							type: 'number',
						},
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							record: orderSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const accountId = request.params.accountId;
			const orderId = request.params.orderId;
			const record = await getOrderRecordFromAction({
				user: accountId,
				orderId,
				includeLatest: true,
			});
			return reply.send({ success: true, record });
		}
	);

	fastify.get<{
		Params: {
			accountId: string;
			marketFilter: SerializedMarketFilter;
			symbol: string;
		};
		Querystring: {
			page?: string;
			hasFill?: boolean;
			startTs?: number;
			endTs?: number;
		};
	}>(
		'/:marketFilter/:symbol',
		{
			preValidation: marketValidation({}),
			schema: {
				description: `<p>
					Retrieve order records for a specific account and market, with optional pagination. Results are ordered from newest to oldest, with up to 20 records per request.
				</p>
				<p>
					<strong>Note:</strong> This endpoint provides records for the last 31 days.
				</p>`,
				tags: ['User'],
				params: {
					type: 'object',
					properties: {
						accountId: { type: 'string' },
						marketFilter: {
							type: 'string',
							enum: Object.values(SerializedMarketFilter),
						},
						symbol: { type: 'string' },
					},
				},
				querystring: {
					type: 'object',
					properties: {
						page: { type: 'string' },
						hasFill: {
							type: 'boolean',
							description:
								'When true, only orders with at least one fill are returned.',
						},
						startTs: {
							type: 'number',
							description: 'Start timestamp (unix seconds).',
						},
						endTs: {
							type: 'number',
							description: 'End timestamp (unix seconds).',
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
								items: orderSchema,
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
			const marketFilter = request.params.marketFilter;
			const symbol = request.params.symbol;
			const nextPage = request.getPaginationToken();
			const hasFill = request.query.hasFill;
			const { startTs, endTs } = request.query;
			const { records, meta } = await getOrderRecords({
				id: accountId,
				marketFilter,
				symbol,
				page: nextPage,
				hasFill,
				startTs,
				endTs,
			});
			return reply.sendPaginatedResponse({ success: true, records, meta });
		}
	);

	fastify.get<{
		Params: {
			accountId: string;
			orderId: number;
		};
		Querystring: {
			page?: string;
		};
	}>(
		'/:orderId/actions',
		{
			schema: {
				description: `<p>
					Retrieve the update actions to an order. Results are ordered from newest to oldest, with up to 20 records per request.
				</p>
				<p>
					<strong>Note:</strong> This endpoint provides records for the last 31 days.
				</p>`,
				tags: ['User'],
				params: {
					type: 'object',
					properties: {
						accountId: { type: 'string' },
						orderId: { type: 'number' },
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
								items: orderActionSchema,
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
			const orderId = request.params.orderId;
			const nextPage = request.getPaginationToken();
			const { records, meta } = await getOrderActionRecords({
				accountId,
				orderId,
				page: nextPage,
			});
			return reply.sendPaginatedResponse({ success: true, records, meta });
		}
	);
};

export default orderRoutes;
