import { DevicePlatform } from '@backend/common';
import { DeviceRepository } from '@backend/dynamodb';
import { FastifyPluginAsync } from 'fastify';
import { deviceSchema } from '../../schemas';

const deviceRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { upsertDevice, getDevices, removeDevice } = DeviceRepository();

	fastify.post<{
		Body: {
			deviceId: string;
			token: string;
			platform?: DevicePlatform;
		};
	}>(
		'',
		{
			schema: {
				description: 'Register or update a device for push notifications',
				tags: ['Notifications'],
				body: deviceSchema,
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							device: deviceSchema,
						},
					},
				},
			},
		},
		async function (request, reply) {
			const authorityId = request.walletAddress;

			if (!authorityId) {
				return reply.code(401).send({ success: false, error: 'Unauthorized' });
			}

			const { deviceId, token, platform } = request.body;

			const device = await upsertDevice({
				authorityId,
				deviceId,
				token,
				platform,
			});

			return reply.send({
				success: true,
				device,
			});
		}
	);

	fastify.get(
		'',
		{
			schema: {
				description: 'Get all registered devices for an account',
				tags: ['Notifications'],
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
							devices: {
								type: 'array',
								items: deviceSchema,
							},
						},
					},
				},
			},
		},
		async function (request, reply) {
			const authorityId = request.walletAddress;

			if (!authorityId) {
				return reply.code(401).send({ success: false, error: 'Unauthorized' });
			}

			const devices = await getDevices(authorityId);

			return reply.send({
				success: true,
				devices,
			});
		}
	);

	fastify.delete<{
		Params: {
			deviceId: string;
		};
	}>(
		'/:deviceId',
		{
			schema: {
				description: 'Delete a device registration',
				tags: ['Notifications'],
				params: {
					type: 'object',
					properties: {
						deviceId: { type: 'string' },
					},
				},
				response: {
					200: {
						type: 'object',
						properties: {
							success: { type: 'boolean' },
						},
					},
				},
			},
		},
		async function (request, reply) {
			const authorityId = request.walletAddress;

			if (!authorityId) {
				return reply.code(401).send({ success: false, error: 'Unauthorized' });
			}

			const { deviceId } = request.params;

			await removeDevice({
				authorityId,
				deviceId,
			});

			return reply.send({
				success: true,
			});
		}
	);
};

export default deviceRoutes;
