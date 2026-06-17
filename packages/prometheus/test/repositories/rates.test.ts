import { getTimestamp } from '@backend/common';
import { RatesRepository } from '../../src/repositories/rates';

jest.mock('@backend/common', () => ({
	getTimestamp: jest.fn().mockImplementation(({ days = 0 } = {}) => {
		const now = 1682000000;
		return now + days * 86400;
	}),
}));

const mockFetchRange = jest.fn();
jest.mock('../../src/client', () => ({
	Prometheus: jest.fn().mockImplementation(() => ({
		fetchRangeData: mockFetchRange,
	})),
}));

describe('RatesRepository', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('fetchLpPerformance', () => {
		it('should return data for SOL-PERP market', async () => {
			const mockPerformanceData = [
				[1681913600, '0.05'],
				[1681927200, '0.06'],
				[1681940800, '0.055'],
			];

			mockFetchRange.mockResolvedValue(mockPerformanceData);

			const { fetchLpPerformance } = RatesRepository();
			const start = getTimestamp({ days: -1 });
			const end = getTimestamp();

			const result = await fetchLpPerformance({
				symbol: 'SOL-PERP',
				start,
				end,
			});

			expect(result).toBeDefined();
			expect(Array.isArray(result)).toBe(true);
			expect(result).toHaveLength(mockPerformanceData.length);

			expect(mockFetchRange).toHaveBeenCalledWith({
				end: 1682000000,
				query: '((((sum(amm_quote_asset_amount_per_lp{market="SOL-PERP"}) / ((sum(10 ^ amm_per_lp_base{market="SOL-PERP"}) or vector(1))) - sum(amm_quote_asset_amount_per_lp{market =~ "SOL-PERP"} @ start()) / (sum(10 ^ (amm_per_lp_base{market="SOL-PERP"} @ start())) or vector(1))+((sum(amm_base_asset_amount_per_lp{market="SOL-PERP"}) / ((sum(10 ^ amm_per_lp_base{market="SOL-PERP"}) or vector(1))) - sum(amm_base_asset_amount_per_lp{market =~ "SOL-PERP"} @ start()) / (sum(10 ^ (amm_per_lp_base{market="SOL-PERP"} @ start())) or vector(1))) * sum(oracle_price{market =~ "SOL-PERP"})))))/sum((((amm_ask_liquidity{market="SOL-PERP"} @ start() / amm_sqrt_k{market="SOL-PERP"} @ start()) * oracle_price{market="SOL-PERP"} @ start()) > ((amm_bid_liquidity{market="SOL-PERP"} @ start() / amm_sqrt_k{market="SOL-PERP"} @ start()) * oracle_price{market="SOL-PERP"} @ start()) and ((amm_ask_liquidity{market="SOL-PERP"} @ start() / amm_sqrt_k{market="SOL-PERP"} @ start()) * oracle_price{market="SOL-PERP"} @ start()) or ((amm_bid_liquidity{market="SOL-PERP"} @ start() / amm_sqrt_k{market="SOL-PERP"} @ start()) * oracle_price{market="SOL-PERP"} @ start())))) * 100',
				start: 1681913600,
				step: 10000,
			});

			expect(result[0]).toEqual(mockPerformanceData[0]);
		});
	});
});
