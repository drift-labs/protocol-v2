import awsLambdaFastify from '@fastify/aws-lambda';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import fastify from 'fastify';
import app from './app';

let requestId: string = crypto.randomUUID();
const server = fastify({
	logger: true,
	genReqId: () => {
		return requestId;
	},
});

server.register(app);
const proxy = awsLambdaFastify(server);

exports.handler = async (event: APIGatewayProxyEvent, context: Context) => {
	requestId = context.awsRequestId;
	return proxy(event, context);
};
