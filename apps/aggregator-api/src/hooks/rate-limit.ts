import { RateLimitMetric, RateLimitRepository } from '@backend/dynamodb';
import { FastifyReply, FastifyRequest } from 'fastify';

export interface RateLimitMiddlewareConfig<TRequest extends FastifyRequest = FastifyRequest> {
	limits: Array<{
		metric: RateLimitMetric;
		valueExtractor: (request: TRequest) => number | Promise<number>;
		limit: number;
	}>;
	getId: (request: TRequest) => string | null | Promise<string | null>;
	onRateLimitExceeded?: (
		request: TRequest,
		reply: FastifyReply,
		result: {
			metric: RateLimitMetric;
			currentUsage: number;
			limit: number;
		}
	) => void | Promise<void>;
}

export function createRateLimitHook<TRequest extends FastifyRequest = FastifyRequest>(
	config: RateLimitMiddlewareConfig<TRequest>
) {
	const { checkMultipleRateLimits } = RateLimitRepository();
	return async (request: TRequest, reply: FastifyReply) => {
		const id = await config.getId(request);
		if (!id) {
			return;
		}

		const values = await Promise.all(
			config.limits.map(async ({ metric, valueExtractor, limit }) => ({
				metric,
				value: await valueExtractor(request),
				limit,
			}))
		);

		const result = await checkMultipleRateLimits(id, values);

		if (!result.allowed) {
			if (config.onRateLimitExceeded) {
				await config.onRateLimitExceeded(request, reply, {
					metric: result.failedMetric!,
					currentUsage: result.currentUsage!,
					limit: result.limit!,
				});

				if (!reply.sent) {
					return reply.status(429).send({
						success: false,
						error: `Rate limit exceeded for ${result.failedMetric}`,
						metric: result.failedMetric,
						currentUsage: result.currentUsage,
						limit: result.limit,
					});
				}

				return;
			}

			return reply.status(429).send({
				success: false,
				error: `Rate limit exceeded for ${result.failedMetric}`,
				metric: result.failedMetric,
				currentUsage: result.currentUsage,
				limit: result.limit,
			});
		}
	};
}

interface RateLimitTrackingHookConfig<TRequest extends FastifyRequest = FastifyRequest> {
	metrics: Array<{
		metric: RateLimitMetric;
		valueExtractor: (request: TRequest, reply: FastifyReply) => number | Promise<number>;
	}>;
	getId: (request: TRequest) => string | null | Promise<string | null>;
}

export function createRateLimitTrackingHook<TRequest extends FastifyRequest = FastifyRequest>(
	config: RateLimitTrackingHookConfig<TRequest>
) {
	const { recordMultipleUsage } = RateLimitRepository();

	return async (request: TRequest, reply: FastifyReply) => {
		const id = await config.getId(request);
		if (!id) {
			return;
		}
		const values = await Promise.all(
			config.metrics.map(async ({ metric, valueExtractor }) => ({
				metric,
				value: await valueExtractor(request, reply),
			}))
		);

		recordMultipleUsage(id, values);
	};
}

export interface RateLimitRequestDecorator {
	rateLimit?: {
		[key: string]: any;
	};
}
