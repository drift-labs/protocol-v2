import { InsuranceFundSwapRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { insuranceFundSwapSchema, metadataSchema } from '../../schemas';

const insuranceFundSwapRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getInsuranceFundSwapRecords } = InsuranceFundSwapRepository();

	fastify.get(
		'',
		{
			schema: {
				description: ``,
				tags: ['Stats'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							records: {
								type: 'array',
								items: insuranceFundSwapSchema,
								maxItems: 20,
							},
							meta: metadataSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const nextPage = request.getPaginationToken();
			const { records, meta } = await getInsuranceFundSwapRecords({
				page: nextPage,
			});

			return reply.sendPaginatedResponse({ success: true, records, meta });
		}
	);
};

export default insuranceFundSwapRoutes;
