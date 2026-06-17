import { FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { initialize } from '../sdk';

const { SPOT_MARKETS, PERP_MARKETS } = initialize({ env: process.env.ENV ?? 'mainnet-beta' });
const SPOT_MARKETS_SYMBOLS = SPOT_MARKETS.map((market) => market.symbol);

const PERP_MARKETS_SYMBOLS = PERP_MARKETS.filter(
	(market) => !market.category?.includes('Prediction')
).map((market) => market.symbol);

const PREDICTION_MARKETS_SYMBOLS = PERP_MARKETS.filter((market) =>
	market.category?.includes('Prediction')
).map((market) => market.symbol);

function isValidMarket(symbol: string, type: 'spot' | 'perp' | 'prediction' | undefined): boolean {
	switch (type) {
		case 'spot':
			return SPOT_MARKETS_SYMBOLS.includes(symbol);
		case 'perp':
			return PERP_MARKETS_SYMBOLS.includes(symbol);
		case 'prediction':
			return PREDICTION_MARKETS_SYMBOLS.includes(symbol);
		default:
			return (
				SPOT_MARKETS_SYMBOLS.includes(symbol) ||
				PERP_MARKETS_SYMBOLS.includes(symbol) ||
				PREDICTION_MARKETS_SYMBOLS.includes(symbol)
			);
	}
}

export function marketValidation({
	type,
	paramType = 'params',
	required = true,
}: {
	type?: 'spot' | 'perp' | 'prediction';
	paramType?: 'params' | 'body' | 'query';
	required?: boolean;
}): RouteShorthandOptions['preValidation'] {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		const symbol = (request[paramType] as { symbol?: string })?.symbol;

		if (!symbol) {
			if (required) {
				return reply.code(400).send({
					error: 'ValidationError',
					message: `Missing required market symbol in ${paramType}`,
				});
			}
			return; // Skip if optional
		}

		if (!isValidMarket(symbol, type)) {
			return reply.code(400).send({
				error: 'ValidationError',
				message: `Invalid market symbol: ${symbol}${
					type ? ` for market type: ${type}` : ''
				}`,
			});
		}
	};
}
