import { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

export interface FastifyPaginationOptions {
	key?: string;
}

declare module 'fastify' {
	interface FastifyRequest {
		getPaginationToken(): any;
	}
	interface FastifyReply {
		sendPaginatedResponse(payload: any): FastifyReply;
	}
}

function encodeNextPageToken(token: any): string {
	return Buffer.from(JSON.stringify(token)).toString('base64');
}

function decodeNextPageToken(token: string): any {
	try {
		return JSON.parse(Buffer.from(token, 'base64').toString());
	} catch (error) {
		const customError = error as FastifyError;
		customError.name = 'ValidationError';
		customError.statusCode = 400;
		customError.message = 'Invalid page token';
		throw customError;
	}
}

const pagination: FastifyPluginAsync = async (fastify) => {
	const paginationQueryKey = 'page';
	const paginationKey = 'nextPage';

	fastify.decorateRequest('getPaginationToken', function (this: FastifyRequest) {
		const query = this.query as Record<string, string>;
		const token = query[paginationQueryKey];
		return token ? decodeNextPageToken(token) : undefined;
	});

	fastify.decorateReply('sendPaginatedResponse', function (this: FastifyReply, payload: any) {
		if (payload.meta && payload.meta[paginationKey]) {
			payload.meta[paginationKey] = encodeNextPageToken(payload.meta[paginationKey]);
		}
		return this.send(payload);
	});
};

export default fp(pagination);
