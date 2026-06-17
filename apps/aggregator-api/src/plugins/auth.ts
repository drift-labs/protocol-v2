// plugins/auth.ts
import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

const auth: FastifyPluginAsync = async (fastify) => {
	const CLOUDFRONT = process.env.RUNNING_LOCAL === 'false';
	const AGGREGATOR_API_SECRET = process.env.AGGREGATOR_API_SECRET;

	fastify.addHook('onRequest', async (request, reply) => {
		const originVerifyHeader = request.headers['x-origin-verify'];
		if (
			CLOUDFRONT &&
			(!AGGREGATOR_API_SECRET || originVerifyHeader !== AGGREGATOR_API_SECRET)
		) {
			reply.code(401).send({ message: 'Unauthorized' });
			return;
		}
	});
};

export default fp(auth);
