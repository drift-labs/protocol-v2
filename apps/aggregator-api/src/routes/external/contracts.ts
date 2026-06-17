import { getPerpMarkets, SerializedMarketFilter } from '@backend/common';
import Decimal from 'decimal.js';
import { FastifyPluginAsync } from 'fastify';
import { CacheProxyClient } from '../../utils/cache-proxy-client';

type ContractResponse = {
	contract_index: number;
	ticker_id: string;
	base_currency: string;
	quote_currency: string;
	last_price: string;
	base_volume: string;
	quote_volume: string;
	high: string;
	low: string;
	product_type: string;
	open_interest: string;
	open_interest_usd: string;
	index_price: string;
	index_name: string;
	index_currency: string;
	funding_rate: string;
	next_funding_rate: string;
	next_funding_rate_timestamp: string;
	contract_type: string;
	contract_price_currency: string;
};

const PERP_PRODUCT_TYPE = 'PERP';
const VANILLA_CONTRACT_TYPE = 'Vanilla';

const contractsRoute: FastifyPluginAsync = async (fastify): Promise<void> => {
	const { getMarketSummary } = CacheProxyClient();
	const perpMarkets = getPerpMarkets();
	const perpConfigMap = new Map(perpMarkets.map((market) => [market.marketIndex, market]));

	fastify.get(
		'/coingecko/contracts',
		{
			schema: {
				description:
					'Retrieve CoinGecko-compatible derivative contract metadata for Velocity perpetual markets.',
				tags: ['External'],
				response: {
					200: {
						type: 'object',
						properties: {
							contracts: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										contract_index: { type: 'number' },
										ticker_id: { type: 'string' },
										base_currency: { type: 'string' },
										quote_currency: { type: 'string' },
										last_price: { type: 'string' },
										base_volume: { type: 'string' },
										quote_volume: { type: 'string' },
										high: { type: 'string' },
										low: { type: 'string' },
										product_type: { type: 'string' },
										open_interest: { type: 'string' },
										open_interest_usd: { type: 'string' },
										index_price: { type: 'string' },
										index_name: { type: 'string' },
										index_currency: { type: 'string' },
										funding_rate: { type: 'string' },
										next_funding_rate: { type: 'string' },
										next_funding_rate_timestamp: { type: 'string' },
										contract_type: { type: 'string' },
										contract_price_currency: { type: 'string' },
									},
								},
							},
						},
					},
				},
			},
		},
		async function (_, reply) {
			await fastify.ensureVelocityClientSubscribed();

			const marketSummary = await getMarketSummary();
			const contracts: ContractResponse[] = marketSummary
				.filter((market) => market.marketType === SerializedMarketFilter.PERP)
				.map((market) => {
					const config = perpConfigMap.get(market.marketIndex);
					const account = fastify.velocityClient.getPerpMarketAccount(market.marketIndex);
					const openInterest = market.openInterest
						? Decimal.max(market.openInterest.long || 0, market.openInterest.short || 0)
						: new Decimal(0);

					return {
						contract_index: market.marketIndex,
						ticker_id: market.symbol,
						base_currency:
							market.baseAsset ||
							config?.baseAssetSymbol ||
							market.symbol.split('-')[0],
						quote_currency: market.quoteAsset || 'USDC',
						last_price: new Decimal(market.price || market.markPrice || 0).toFixed(6),
						base_volume: new Decimal(market.baseVolume || 0).toFixed(9),
						quote_volume: new Decimal(market.quoteVolume || 0).toFixed(6),
						high: new Decimal(market.priceHigh?.fill || 0).toFixed(6),
						low: new Decimal(market.priceLow?.fill || 0).toFixed(6),
						product_type: PERP_PRODUCT_TYPE,
						open_interest: openInterest.toFixed(9),
						open_interest_usd: openInterest.mul(market.oraclePrice || 0).toFixed(6),
						index_price: new Decimal(market.oraclePrice || 0).toFixed(6),
						index_name:
							market.baseAsset ||
							config?.baseAssetSymbol ||
							market.symbol.split('-')[0],
						index_currency: market.quoteAsset || 'USDC',
						funding_rate: new Decimal(market.fundingRate24h || 0).toFixed(9),
						next_funding_rate: new Decimal(market.fundingRate?.short || 0).toFixed(6),
						next_funding_rate_timestamp:
							account?.amm.lastFundingRateTs && account?.amm.fundingPeriod
								? account.amm.lastFundingRateTs
										.add(account.amm.fundingPeriod)
										.muln(1000)
										.toString()
								: Date.now().toString(),
						contract_type: VANILLA_CONTRACT_TYPE,
						contract_price_currency: market.quoteAsset || 'USDC',
					};
				})
				.sort((a, b) => a.contract_index - b.contract_index);

			return reply.send({ contracts });
		}
	);
};

export default contractsRoute;
