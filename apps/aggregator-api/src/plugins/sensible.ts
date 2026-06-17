import sensible, { FastifySensibleOptions } from '@fastify/sensible';
import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

const sensiblePlugin: FastifyPluginAsync = async (fastify) => {
	fastify.register(sensible);
};

export default fp<FastifySensibleOptions>(sensiblePlugin);
