import { BN } from '@velocity-exchange/sdk';
import Fastify, { FastifyInstance } from 'fastify';
import externalRoutes from '../../src/routes/external';

const mockGetMarketSummary = jest.fn();
const mockEnsureVelocityClientSubscribed = jest.fn();
const mockGetPerpMarketAccount = jest.fn();

jest.mock('../../src/utils/cache-proxy-client', () => ({
	CacheProxyClient: () => ({
		getMarketSummary: mockGetMarketSummary,
	}),
}));

jest.mock('@backend/common', () => {
	const actual = jest.requireActual('@backend/common');
	return {
		...actual,
		getPerpMarkets: jest.fn(() => [
			{
				symbol: 'SOL-PERP',
				baseAssetSymbol: 'SOL',
				marketIndex: 0,
				launchTs: 1667560505000,
			},
		]),
	};
});

describe('Contracts Route', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		jest.spyOn(Date, 'now').mockReturnValue(1774585403646);

		app = Fastify();
		app.decorate('ensureVelocityClientSubscribed', mockEnsureVelocityClientSubscribed);
		app.decorate('velocityClient', {
			getPerpMarketAccount: mockGetPerpMarketAccount,
		});

		await app.register(externalRoutes, { prefix: '/external' });
		await app.ready();
	});

	afterEach(async () => {
		jest.restoreAllMocks();
		jest.clearAllMocks();
		await app.close();
	});

	it('should return CoinGecko-compatible perpetual contracts', async () => {
		mockGetMarketSummary.mockResolvedValue([
			{
				symbol: 'SOL/USDC',
				marketIndex: 99,
				marketType: 'spot',
				price: '150.123456',
			},
			{
				symbol: 'SOL-PERP',
				marketIndex: 0,
				marketType: 'perp',
				baseAsset: 'SOL',
				quoteAsset: 'USDC',
				price: '86.088129',
				oraclePrice: '86.086408',
				baseVolume: '460197.33',
				quoteVolume: '39410346.585643',
				priceHigh: {
					fill: '90.886',
					oracle: '90.885',
				},
				priceLow: {
					fill: '85.3895',
					oracle: '85.3901',
				},
				openInterest: {
					long: '844581.260000000',
					short: '830000.000000000',
				},
				fundingRate24h: '0.000455642',
				fundingRate: {
					long: '-0.000581',
					short: '0.000581',
				},
			},
		]);

		mockGetPerpMarketAccount.mockReturnValue({
			contractType: { perpetual: {} },
			amm: {
				lastFundingRateTs: new BN(1774584011),
				fundingPeriod: new BN(3600),
			},
		});

		const response = await app.inject({
			method: 'GET',
			url: '/external/coingecko/contracts',
		});

		expect(response.statusCode).toBe(200);
		expect(mockEnsureVelocityClientSubscribed).toHaveBeenCalled();
		expect(mockGetPerpMarketAccount).toHaveBeenCalledWith(0);

		const payload = JSON.parse(response.payload);
		expect(payload).toEqual({
			contracts: [
				{
					contract_index: 0,
					ticker_id: 'SOL-PERP',
					base_currency: 'SOL',
					quote_currency: 'USDC',
					last_price: '86.088129',
					base_volume: '460197.330000000',
					quote_volume: '39410346.585643',
					high: '90.886000',
					low: '85.389500',
					product_type: 'PERP',
					open_interest: '844581.260000000',
					open_interest_usd: '72706966.937514',
					index_price: '86.086408',
					index_name: 'SOL',
					index_currency: 'USDC',
					funding_rate: '0.000455642',
					next_funding_rate: '0.000581',
					next_funding_rate_timestamp: '1774587611000',
					contract_type: 'Vanilla',
					contract_price_currency: 'USDC',
				},
			],
		});
	});
});
