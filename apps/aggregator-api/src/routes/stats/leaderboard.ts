import { LeaderboardSort } from '@backend/common';
import { FastifyPluginAsync } from 'fastify';
import { marketValidation } from '../../hooks/market-validation';
import { CacheProxyClient } from '../../utils/cache-proxy-client';

const leaderboardRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getLeaderboard, getLeaderboardRank } = CacheProxyClient();

	fastify.addHook('preValidation', async (request, reply) => {
		const { start, end } = request.query as {
			start?: string;
			end?: string;
		};

		if (end && !start) {
			return reply.status(400).send({
				error: 'ValidationError',
				message: 'Must specify a start date when specifying an end date',
			});
		}

		if (start && end && start > end) {
			return reply.status(400).send({
				error: 'ValidationError',
				message: '`start` must be less than or equal to `end`',
			});
		}

		const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
		if (start && !dateRegex.test(start)) {
			return reply.status(400).send({
				error: 'ValidationError',
				message: '`start` must be of format YYYY-MM-DD',
			});
		}

		if (end && !dateRegex.test(end)) {
			return reply.status(400).send({
				error: 'ValidationError',
				message: '`end` must be of format YYYY-MM-DD',
			});
		}
	});

	fastify.get<{
		Querystring: {
			page?: number;
			limit?: number;
			sort?: LeaderboardSort;
			start?: string;
			end?: string;
			symbol?: string;
		};
	}>(
		'',
		{
			preValidation: marketValidation({
				type: undefined,
				paramType: 'query',
				required: false,
			}),
			schema: {
				description: 'Get leaderboard entries with optional date and market filters.',
				tags: ['Stats'],
				querystring: {
					type: 'object',
					properties: {
						page: { type: 'integer', minimum: 1, default: 1 },
						limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
						sort: {
							type: 'string',
							enum: Object.values(LeaderboardSort),
							default: LeaderboardSort.PNL,
						},
						start: { type: 'string', description: 'UTC date string YYYY-MM-DD' },
						end: { type: 'string', description: 'UTC date string YYYY-MM-DD' },
						symbol: { type: 'string' },
					},
				},
			},
		},
		async (request, reply) => {
			const {
				page = 1,
				limit = 100,
				sort = LeaderboardSort.PNL,
				start,
				end,
				symbol,
			} = request.query;

			const leaderboard = await getLeaderboard({
				sort,
				page,
				limit,
				start,
				end,
				symbol,
			});
			return reply.send({ success: true, data: { leaderboard } });
		}
	);

	fastify.get<{
		Params: { authority: string };
		Querystring: {
			start?: string;
			end?: string;
			symbol?: string;
		};
	}>(
		'/:authority',
		{
			preValidation: marketValidation({
				type: undefined,
				paramType: 'query',
				required: false,
			}),
			schema: {
				description: 'Get leaderboard rank and stats for a specific user.',
				tags: ['Stats'],
				querystring: {
					type: 'object',
					properties: {
						start: {
							type: 'string',
							description: 'UTC date string YYYY-MM-DD. Defaults to 7 Days prior',
						},
						end: {
							type: 'string',
							description: 'UTC date string YYYY-MM-DD. Defaults to today',
						},
						symbol: { type: 'string' },
					},
				},
			},
		},
		async (request, reply) => {
			const { authority } = request.params;
			const { start, end, symbol } = request.query;

			const data = await getLeaderboardRank({
				authority,
				start,
				end,
				symbol,
			});
			return reply.send({ success: true, data });
		}
	);
};

export default leaderboardRoutes;
