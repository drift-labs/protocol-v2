import { getTimestamp } from '@backend/common';
import { Athena } from '../client';
import { getMarketPrecisions, getTimePartition } from '../utils';

const LIQUIDATION_TABLE = 'eventtype_liquidationrecord';

export const LiquidationAnalyticsRepository = () => {
	const { query } = Athena();

	const getLiquidationStats = async (days: number) => {
		const from = getTimestamp({ days: -days });
		const to = getTimestamp();

		const queryString = `
			${getTimePartition(from, to)},
			${getMarketPrecisions()},
			total_liquidations AS (
				SELECT COUNT(*) as total_count
				FROM (
					SELECT DISTINCT user, liquidationid
					FROM ${LIQUIDATION_TABLE}, time_range
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
		`;

		const results = await query(queryString);

		return {
			count: results[0]?.total_count || '0',
			amount: Number(results[0]?.total_amount || '0').toFixed(2),
		};
	};

	const getBankruptcyStats = async (days: number) => {
		const from = getTimestamp({ days: -days });
		const to = getTimestamp();

		const queryString = `
			${getTimePartition(from, to)},
			${getMarketPrecisions()},
			total_bankruptcies AS (
				SELECT COUNT(*) as total_count
				FROM (
					SELECT DISTINCT user, liquidationid
					FROM ${LIQUIDATION_TABLE}, time_range
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
		`;

		const results = await query(queryString);

		return {
			totalAmount: results[0]?.total_amount || '0',
			ifPayment: results[0]?.if_payment || '0',
			socialLoss: results[0]?.social_loss || '0',
			totalCount: results[0]?.total_count || '0',
		};
	};

	return {
		getBankruptcyStats,
		getLiquidationStats,
	};
};
