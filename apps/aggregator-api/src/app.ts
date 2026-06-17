import { logger } from '@backend/common';
import { AutoloadPluginOptions } from '@fastify/autoload';
import fastifyCompress from '@fastify/compress';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import { FastifyPluginAsync, FastifyServerOptions } from 'fastify';
import * as plugins from './plugins';
import * as routes from './routes';
import { SDK_MODE } from './sdk';
import { swaggerConfig } from './swagger';

/**
 * SDK_MODE=drift serves frozen historical Drift data only. It skips:
 *
 *   - plugins that wire live RPC clients or write helpers
 *     (central-server-*, tx-simulator)
 *   - any route tree that builds transactions or accepts mutations
 *     (tx, admin, claim, notifications, vaults, whitelist)
 *
 * Nested gates inside the kept route trees (onchain routes under
 * /user and /authority, the /external/coingecko/contracts route)
 * are applied in their respective index files.
 */
const DRIFT_DISABLED_PLUGINS = new Set<string>(['centralServerVelocity', 'txSimulator']);

// `stats` is fully cache-proxy backed and returns aggregations that imply
// liveness — a frozen exchange has none of those. The other gated trees
// build/accept mutations. Nested cache-proxy consumers (market/candles,
// user/snapshots, authority/snapshots) are gated in their parent indexes.
// `/external/token` stays — it returns DRIFT token supply which is still
// the relevant token until Velocity ships its own.
const DRIFT_DISABLED_ROUTES = new Set<string>([
	'tx',
	'admin',
	'claim',
	'notifications',
	'vaults',
	'whitelist',
	'stats',
]);

export interface AppOptions extends FastifyServerOptions, Partial<AutoloadPluginOptions> {}

export const options: AppOptions = {};

const app: FastifyPluginAsync<AppOptions> = async (fastify, opts): Promise<void> => {
	fastify.setErrorHandler(async (error, request, reply) => {
		const statusCode = error.statusCode ?? 500;

		if (statusCode >= 500) {
			const logMessage = `
			[${request.method}] ${request.url}
			Status Code: ${statusCode}
			Error Name: ${error.name}
			Error Message: ${error.message}
			Stack Trace: ${error.stack}
			Error Details: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}
			Request Body: ${JSON.stringify(request.body)}
			Request Query: ${JSON.stringify(request.query)}
			Request Params: ${JSON.stringify(request.params)}
		  `.trim();

			await logger.error(logMessage);
		}

		return reply.status(statusCode).send({
			error: error.name,
			message:
				statusCode >= 500
					? 'Internal Server Error'
					: error.message ?? 'Internal Server Error',
		});
	});

	fastify.register(swagger, { openapi: swaggerConfig });

	// @fastify/swagger-ui serves static assets resolved from its package
	// directory at runtime — that path doesn't survive the single-file esbuild
	// bundle used for the Lambda build, so it's kept external (see
	// esbuild.lambda.config.js) and loaded only outside Lambda. The OpenAPI spec
	// at /openapi.json (from @fastify/swagger, which bundles fine) still works in
	// Lambda; only the /playground UI is unavailable there.
	if (process.env.LAMBDA !== '1') {
		const swaggerUi = (await import('@fastify/swagger-ui')).default;
		await fastify.register(swaggerUi, {
			routePrefix: '/playground',
			theme: {
				title: 'Velocity Data API',
			},
			uiConfig: {
				deepLinking: false,
				layout: 'BaseLayout',
			},
		});
	}

	await fastify.register(cors, {
		origin: '*',
		methods: '*',
	});

	await fastify.register(fastifyCompress, {
		encodings: ['br', 'gzip', 'deflate'],
	});

	fastify.get('/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
		return reply.send(fastify.swagger());
	});

	for (const [name, plugin] of Object.entries(plugins)) {
		if (SDK_MODE === 'drift' && DRIFT_DISABLED_PLUGINS.has(name)) continue;
		await fastify.register(plugin);
	}

	for (const [prefix, route] of Object.entries(routes)) {
		if (SDK_MODE === 'drift' && DRIFT_DISABLED_ROUTES.has(prefix)) continue;
		await fastify.register(route, { ...opts, prefix });
	}
};

export default app;
