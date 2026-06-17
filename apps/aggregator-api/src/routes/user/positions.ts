import { TradeRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { metadataSchema, positionHistorySchema } from '../../schemas';

const positionRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getPositionRecords } = TradeRepository();

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
                Retrieve position closing trade records accumulated by orderId for a specific account, with optional pagination. Results are ordered from newest to oldest, with up to 20 unique orders per request.
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
								items: positionHistorySchema,
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
			const { records, meta } = await getPositionRecords({ id: accountId, page: nextPage });
			return reply.sendPaginatedResponse({ success: true, records, meta });
		}
	);
};

export default positionRoutes;
