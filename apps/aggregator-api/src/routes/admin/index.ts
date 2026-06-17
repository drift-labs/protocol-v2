import { FastifyPluginAsync } from 'fastify';
import notificationWorkflows from './notification-workflows';
import notifications from './notifications';
import params from './params';
import uploads from './uploads';
import vaults from './vaults';

const Admin: FastifyPluginAsync = async (fastify): Promise<void> => {
	const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET;

	fastify.addHook('onRequest', async (request, reply) => {
		if (!ADMIN_API_SECRET) {
			reply.code(503).send({ success: false, error: 'Admin API not configured' });
			return;
		}
		if (request.headers['x-admin-secret'] !== ADMIN_API_SECRET) {
			reply.code(401).send({ success: false, error: 'Unauthorized' });
			return;
		}
	});

	fastify.register(params, { prefix: '/params' });
	fastify.register(notifications, { prefix: '/notifications' });
	fastify.register(notificationWorkflows, { prefix: '/notification-workflows' });
	fastify.register(uploads, { prefix: '/uploads' });
	fastify.register(vaults, { prefix: '/vaults' });
};

export default Admin;
