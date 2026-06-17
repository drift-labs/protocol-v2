import { getTimestamp } from '@backend/common';
import { BN } from '@velocity-exchange/sdk';
import { Athena } from '../../src/client';
import { LiquidationAnalyticsRepository } from '../../src/repositories/liquidations';

const mockSpotMarkets = jest.fn();
jest.mock('@backend/common', () => ({
	...jest.requireActual('@backend/common'),
	getTimestamp: jest.fn(),
	getSpotMarkets: () => mockSpotMarkets(),
}));

jest.mock('../../src/client', () => ({
	Athena: jest.fn(),
}));

describe('LiquidationAnalyticsRepository', () => {
	const mockQuery = jest.fn();
	const mockAthena = {
		query: mockQuery,
	};

	mockSpotMarkets.mockReturnValue([
		{ marketIndex: 0, precision: new BN(1000000) },
		{ marketIndex: 1, precision: new BN(1000000000) },
	]);

	beforeEach(() => {
		jest.clearAllMocks();

		(Athena as jest.Mock).mockReturnValue(mockAthena);

		(getTimestamp as jest.Mock).mockImplementation(({ days } = {}) => {
			const baseTime = 1714400000;
			if (days) {
				return baseTime + days * 86400;
			}
			return baseTime;
		});
	});

	describe('getLiquidationStats', () => {
		it('should query Athena with the correct parameters for 1 day', async () => {
			const now = 1714400000;
			const oneDayAgo = 1714313600;

			(getTimestamp as jest.Mock).mockReturnValueOnce(oneDayAgo).mockReturnValueOnce(now);

			mockQuery.mockResolvedValueOnce([{ total_count: '5' }]);

			const repository = LiquidationAnalyticsRepository();
			const result = await repository.getLiquidationStats(1);

			expect(mockQuery.mock.calls[0][0].replace(/\s/g, '')).toEqual(
				`
                       WITH time_range AS (
						SELECT 
							1714313600 as from_ts,
							1714400000 as to_ts,
							DATE_FORMAT(from_unixtime(1714313600), '%Y%m%d') as from_date,
							DATE_FORMAT(from_unixtime(1714400000), '%Y%m%d') as to_date
                        ),
                        market_precision AS (
							SELECT * FROM (
							VALUES 
								(0, 1000000),
								(1, 1000000000)
							) AS t(market_index, precision_factor)
                        ),
                        total_liquidations AS (
                                SELECT COUNT(*) as total_count
                                FROM (
									SELECT DISTINCT user, liquidationid
									FROM eventtype_liquidationrecord, time_range
									WHERE CAST(ts as INT) BETWEEN time_range.from_ts AND time_range.to_ts
									AND CONCAT(year, month, day) BETWEEN time_range.from_date AND time_range.to_date
                                )
                        ),
                        liquidation_amounts AS (
							SELECT DISTINCT
									SUM(CASE WHEN liquidationtype = 'liquidatePerp' THEN ABS(CAST(liquidateperp.quoteAssetAmount AS DOUBLE)) / 1e6 ELSE 0 END) as perp_total_amount,
									SUM(CASE WHEN liquidationtype = 'liquidateSpot' THEN 
									ABS(CAST(liquidateSpot.liabilityPrice AS DOUBLE)) / 1e6 * 
									ABS(CAST(liquidateSpot.liabilityTransfer AS DOUBLE)) / mp.precision_factor
									ELSE 0 END) as spot_total_amount
							FROM eventtype_liquidationrecord liq
							LEFT JOIN market_precision mp 
							ON liq.liquidateSpot.liabilityMarketIndex = mp.market_index
							CROSS JOIN time_range 
							WHERE CAST(ts as INT) BETWEEN time_range.from_ts AND time_range.to_ts
							AND CONCAT(year, month, day) BETWEEN time_range.from_date AND time_range.to_date
                        )
                        SELECT 
							totals.total_count, 
							amounts.perp_total_amount, 
							amounts.spot_total_amount, 
							(amounts.perp_total_amount + amounts.spot_total_amount) as total_amount
                        FROM total_liquidations totals, liquidation_amounts amounts
                `.replace(/\s/g, '')
			);

			expect(result).toEqual({ count: '5', amount: '0.00' });
		});

		it('should query Athena with the correct parameters for 30 days', async () => {
			const now = 1714400000;
			const thirtyDaysAgo = 1711808000;

			(getTimestamp as jest.Mock).mockReturnValueOnce(thirtyDaysAgo).mockReturnValueOnce(now);

			mockQuery.mockResolvedValueOnce([{ total_count: '15' }]);

			const repository = LiquidationAnalyticsRepository();
			const result = await repository.getLiquidationStats(30);

			expect(mockQuery).toHaveBeenCalledWith(
				expect.stringContaining(`${thirtyDaysAgo} as from_ts`)
			);
			expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining(`${now} as to_ts`));

			expect(result).toEqual({ count: '15', amount: '0.00' });
		});

		it('should handle empty query results', async () => {
			mockQuery.mockResolvedValueOnce([]);

			const repository = LiquidationAnalyticsRepository();
			const result = await repository.getLiquidationStats(7);

			expect(result).toEqual({ count: '0', amount: '0.00' });
		});
	});

	describe('getBankruptcyStats', () => {
		it('should query Athena with the correct parameters for 1 day', async () => {
			const now = 1714400000;
			const oneDayAgo = 1714313600;

			(getTimestamp as jest.Mock).mockReturnValueOnce(oneDayAgo).mockReturnValueOnce(now);

			mockQuery.mockResolvedValueOnce([
				{
					total_count: '3',
					total_amount: '10000',
					if_payment: '5000',
					social_loss: '5000',
				},
			]);
			const repository = LiquidationAnalyticsRepository();
			const result = await repository.getBankruptcyStats(1);

			expect(mockQuery.mock.calls[0][0].replace(/\s/g, '')).toEqual(
				`
			WITH time_range AS (
			  SELECT 
				1714313600 as from_ts,
				1714400000 as to_ts,
				DATE_FORMAT(from_unixtime(1714313600), '%Y%m%d') as from_date,
				DATE_FORMAT(from_unixtime(1714400000), '%Y%m%d') as to_date
			),
			market_precision AS (
			  SELECT * FROM (
			  VALUES 
				(0, 1000000),
				(1, 1000000000)
			  ) AS t(market_index, precision_factor)
			),
			total_bankruptcies AS (
			  SELECT COUNT(*) as total_count
			  FROM (
				SELECT DISTINCT user, liquidationid
				FROM eventtype_liquidationrecord, time_range
				WHERE
				  (liquidationtype = 'perpBankruptcy' OR liquidationtype='spotBankruptcy')
				  AND CAST(ts as INT) BETWEEN time_range.from_ts AND time_range.to_ts
				  AND CONCAT(year, month, day) BETWEEN time_range.from_date AND time_range.to_date
			  )
			),
			bankruptcy_amounts AS (
			  SELECT 
				SUM(CASE WHEN liquidationtype = 'perpBankruptcy' THEN ABS(CAST(perpBankruptcy.pnl AS DOUBLE)) / 1e6 ELSE 0 END) as perp_total_amount,
				SUM(CASE WHEN liquidationtype = 'perpBankruptcy' THEN ABS(CAST(perpBankruptcy.ifpayment AS DOUBLE)) / 1e6 ELSE 0 END) as perp_if_amount,
				SUM(CASE WHEN liquidationtype = 'spotBankruptcy' THEN ABS(CAST(spotBankruptcy.borrowamount AS DOUBLE)) / mp.precision_factor ELSE 0 END) as spot_total_amount,
				SUM(CASE WHEN liquidationtype = 'spotBankruptcy' THEN ABS(CAST(spotBankruptcy.ifpayment AS DOUBLE)) / mp.precision_factor ELSE 0 END) as spot_if_amount
			  FROM (
				SELECT DISTINCT *
				FROM eventtype_liquidationrecord
				CROSS JOIN time_range 
				WHERE
				  (liquidationtype = 'perpBankruptcy' OR liquidationtype='spotBankruptcy')
				  AND CAST(ts as INT) BETWEEN time_range.from_ts AND time_range.to_ts
				  AND CONCAT(year, month, day) BETWEEN time_range.from_date AND time_range.to_date
			  ) liq
			  LEFT JOIN market_precision mp 
			  ON liq.spotBankruptcy.marketIndex = mp.market_index
			),
			calculated_amounts AS (
			  SELECT 
				(amounts.perp_total_amount + amounts.spot_total_amount) as total_amount,
				(amounts.perp_if_amount + amounts.spot_if_amount) as if_payment,
				totals.total_count
			  FROM total_bankruptcies totals, bankruptcy_amounts amounts
			)
			SELECT 
			  total_amount,
			  if_payment,
			  (total_amount - if_payment) as social_loss,
			  total_count
			FROM calculated_amounts
			`.replace(/\s/g, '')
			);

			expect(result).toEqual({
				totalAmount: '10000',
				ifPayment: '5000',
				socialLoss: '5000',
				totalCount: '3',
			});
		});

		it('should handle empty query results', async () => {
			mockQuery.mockResolvedValueOnce([]);
			const repository = LiquidationAnalyticsRepository();
			const result = await repository.getBankruptcyStats(7);

			expect(result).toEqual({
				totalAmount: '0',
				ifPayment: '0',
				socialLoss: '0',
				totalCount: '0',
			});
		});
	});
});
