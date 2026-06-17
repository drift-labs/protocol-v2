import { AlertDirection } from '@backend/common';
import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

type ValidationErrorMap = {
	[key: string]: {
		[errorType: string]: string | ((params: any) => string);
	};
};

const errorMessages: ValidationErrorMap = {
	'/year': {
		type: 'Year must be a valid 4-digit number',
		minimum: (params) => `Year must be >= to ${params.limit}`,
		maximum: (params) => `Year must be <= to ${params.limit}`,
	},
	'/month': {
		type: 'Month must be a number between 1 and 12',
		minimum: (params) => `Month must be >= to ${params.limit}`,
		maximum: (params) => `Month must be <= to ${params.limit}`,
	},
	'/limit': {
		type: 'Limit must be a number',
		minimum: (params) => `Limit must be >= to ${params.limit}`,
		maximum: (params) => `Maximum allowed limit: ${params.limit}`,
	},
	'/days': {
		type: 'Days must be a number',
		minimum: (params) => `Days must be >= to ${params.limit}`,
		maximum: (params) => `Maximum allowed days: ${params.limit}`,
	},
	'/startTs': {
		type: 'startTs must be a number',
		minimum: (params) => `startTs must be >= to ${params.limit}`,
		maximum: (params) => `Maximum allowed startTs: ${params.limit}`,
	},
	'/endTs': {
		type: 'endTs must be a number',
		minimum: (params) => `endTs must be >= to ${params.limit}`,
		maximum: (params) => `Maximum allowed endTs: ${params.limit}`,
	},
	'/direction': {
		enum: `direction must be a valid value: ${Object.keys(AlertDirection).join(',')}`,
	},
};

const defaultErrorMessages: Record<string, string> = {
	type: 'Invalid type provided',
	minimum: 'Value is below minimum allowed',
	maximum: 'Value exceeds maximum allowed',
	required: 'This field is required',
	enum: 'Invalid value provided',
};

export const validationErrorMessages = (
	error: FastifyError,
	_: FastifyRequest,
	reply: FastifyReply
) => {
	if (error.validation?.length) {
		const validationErrors = error.validation.map((err) => {
			const fieldErrors = errorMessages[err.instancePath];
			if (fieldErrors) {
				const errorHandler = fieldErrors[err.keyword];
				if (errorHandler) {
					return typeof errorHandler === 'string'
						? errorHandler
						: errorHandler(err.params);
				}
			}

			const fieldName =
				err.instancePath.replace('/', '') || err.params?.missingProperty || 'field';
			const defaultMsg = defaultErrorMessages[err.keyword] || err.message;
			return `${defaultMsg}: ${fieldName}`;
		});

		reply.status(400).send({
			error: 'ValidationError',
			message: validationErrors.join('. '),
		});
	} else {
		reply.send(error);
	}
};
