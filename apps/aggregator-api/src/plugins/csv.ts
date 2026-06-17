import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Parser } from 'json2csv';

interface FormatQuerystring {
	format?: 'csv' | 'json';
}

declare module 'fastify' {
	interface FastifyContextConfig {
		allowCsv?: boolean;
		objectName?: string;
	}
}

const formatPlugin: FastifyPluginAsync = async (fastify) => {
	const convertToCSV = (data: any): string => {
		try {
			if (Array.isArray(data)) {
				const parser = new Parser({
					fields: Object.keys(data[0] || {}),
				});
				return parser.parse(data);
			}

			const parser = new Parser({
				fields: Object.keys(data),
			});

			return parser.parse([data]);
		} catch (error) {
			fastify.log.error('Error converting to CSV:', error);
			throw new Error('Failed to convert data to CSV format');
		}
	};

	const generateFilename = (request: FastifyRequest): string => {
		const basePath = request.url.split('?')[0].slice(1).replace(/\//g, '-');
		const page = (request.query as any).page;
		const pageSegment = page ? `-page-${page}` : '';
		return `${basePath}${pageSegment}`.replace(/[^a-zA-Z0-9-]/g, '');
	};

	fastify.addHook(
		'onSend',
		async (
			request: FastifyRequest<{
				Querystring: FormatQuerystring;
				Params: {
					accountId: string;
					year: number;
					month: number;
				};
			}>,
			reply,
			payload: string
		) => {
			const format = request.query.format?.toLowerCase();
			const allow = request.routeOptions.config.allowCsv ?? false;
			const object = request.routeOptions.config.objectName ?? false;

			if (format !== 'csv' || !allow || !object) {
				return payload;
			}

			if (payload) {
				try {
					const csv = convertToCSV(JSON.parse(payload)[object]);
					const filename = generateFilename(request);
					reply
						.header('Content-Type', 'text/csv')
						.header('Content-Disposition', `attachment; filename=${filename}.csv`);

					return csv;
				} catch (error) {
					request.log.error('CSV conversion failed:', error);
					reply.header('Content-Type', 'application/json');
					return JSON.stringify({
						error: 'CSV conversion failed',
						message: (error as Error).message,
					});
				}
			}

			return payload;
		}
	);
};

export default fp(formatPlugin);
