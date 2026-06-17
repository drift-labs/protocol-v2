import { CandleResolutions, getTimestamp } from '@backend/common';
import { CandleRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { marketValidation } from '../../hooks/market-validation';
import { candleSchema } from '../../schemas';
import { CacheProxyClient } from '../../utils/cache-proxy-client';

const MIN_TIMESTAMP = new Date('2022-11-15').getTime() / 1000; // TODO update this to the last available candle in database

const candleRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.addHook('preValidation', async (request, reply) => {
		const { startTs, endTs } = request.query as { startTs?: number; endTs?: number };
		if (startTs && endTs && startTs <= endTs) {
			reply.status(400).send({
				error: 'ValidationError',
				message: 'Start timestamp must be after end timestamp',
			});
			return;
		}

		const currentTimestamp = getTimestamp();
		if ((startTs && startTs > currentTimestamp) || (endTs && endTs > currentTimestamp)) {
			reply.status(400).send({
				error: 'ValidationError',
				message: 'Timestamps cannot be in the future',
			});
			return;
		}
	});

	const {
		getCandlesForResolution: getCandlesFromCache,
		getCandlesBetweenTimestampsForResolution: getCandlesBetweenTimestampsFromCache,
	} = CacheProxyClient();
	const { getCandlesBetweenTimestampsForResolution: getCandlesFromDb } = CandleRepository();

	fastify.get<{
		Params: {
			symbol: string;
			resolution: CandleResolutions;
		};
		Querystring: {
			limit: number;
			startTs: number;
			endTs: number;
		};
	}>(
		'/:resolution',
		{
			preValidation: marketValidation({}),
			schema: {
				description: `<p>Retrieve OHLC records for a market and resolution.</p>`,
				tags: ['Market'],
				params: {
					type: 'object',
					properties: {
						symbol: { type: 'string' },
						resolution: {
							type: 'string',
							enum: ['1', '5', '15', '60', '240', 'D', 'W', 'M'],
							description: 'Candle resolution',
						},
					},
				},
				querystring: {
					type: 'object',
					properties: {
						endTs: {
							type: 'number',
							minimum: MIN_TIMESTAMP,
							description: 'End timestamp in seconds (must be >= 2020-01-01)',
						},
						startTs: {
							type: 'number',
							minimum: MIN_TIMESTAMP,
							description: 'Start timestamp in seconds (must be <= current time)',
						},
						limit: { type: 'number', minimum: 1, maximum: 1000, default: 100 },
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							records: {
								type: 'array',
								items: candleSchema,
								maxItems: 1000,
							},
						},
					},
				},
			},
		},
		async function (request, reply) {
			const symbol = request.params.symbol;
			const resolution = request.params.resolution;
			const limit = request.query.limit;

			const startTs = request.query.startTs;
			const endTs = request.query?.endTs ?? MIN_TIMESTAMP;

			if (startTs) {
				const records = await getCandlesBetweenTimestampsFromCache({
					symbol,
					resolution,
					limit,
					startTs,
					endTs,
				});

				const lastRecord = records.at(-1);
				const lastRecordTs = lastRecord?.ts ?? startTs;

				if (records.length < limit && lastRecordTs > endTs) {
					const newStartTs = lastRecordTs - (records.length > 0 ? 1 : 0);
					const recordsFromDb = await getCandlesFromDb({
						symbol,
						resolution,
						startTs: newStartTs,
						endTs,
						limit: limit - records.length,
					});

					records.push(...recordsFromDb);
				}

				return reply.send({ success: true, records });
			}

			const records = await getCandlesFromCache({ symbol, resolution, limit });
			return reply.send({ success: true, records });
		}
	);
};

export default candleRoutes;
