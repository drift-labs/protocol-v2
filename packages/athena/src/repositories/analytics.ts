import {
	AuctionLatencyStats,
	FillBitFlag,
	FillCohort,
	FillDirection,
	FillLiquiditySourceStats,
	FillTakerOrderType,
	TriggerOrderFillStats,
} from '@backend/common';
import { Athena } from '../client';
import { getTimeRangeAndPartitions } from '../utils';

export const FillQualityAnalyticsRepository = () => {
	const { query } = Athena();

	const getAuctionLatencyStats = async (
		from: number,
		to: number
	): Promise<AuctionLatencyStats[]> => {
		const queryString = `
			${getTimeRangeAndPartitions(from, to, 'vp')},

			filtered_action AS (
				SELECT *,
				CAST(et.oracleprice AS DOUBLE) / 1e6 AS oracle_price,
				(CAST(et.quoteassetamountfilled AS DOUBLE) / 1e6) / (CAST(et.baseassetamountfilled AS DOUBLE) / 1e9) AS fill_price
				FROM eventtype_traderecord et
				JOIN valid_partitions vp ON et.year = vp.year AND et.month = vp.month AND et.day = vp.day
				JOIN time_range tr ON CAST(et.ts AS INT) BETWEEN tr.from_ts AND tr.to_ts
				WHERE et.action = 'fill'
			),

			filtered_order AS (
				SELECT *
				FROM eventtype_orderrecord et
				JOIN valid_partitions vp ON et.year = vp.year AND et.month = vp.month AND et.day = vp.day
				JOIN time_range tr ON CAST(et.ts AS INT) BETWEEN tr.from_ts AND tr.to_ts
				WHERE et."order".auctionDuration > 0 AND et."order".orderType != 'limit'
			),

			joined_data AS (
				SELECT
					oa.slot - orc.slot AS fill_latency,
					(oa.slot - orc.slot) / CAST(orc."order".auctionDuration AS DOUBLE) AS auction_progress,
					CAST(orc."order".baseAssetAmount AS DOUBLE) / 1e9 * CAST(oa.oracleprice AS DOUBLE) / 1e6 AS order_notional_value,
					abs(fill_price - oracle_price) AS fill_vs_oracle_abs,
					abs((fill_price / oracle_price - 1) * 10000) AS fill_vs_oracle_abs_bps,
					oa.markettype AS market_type,
					oa.marketindex AS market_index,
					orc."order".orderType AS taker_order_type,
					oa.takerorderdirection AS taker_order_direction,
					CASE
						WHEN orc."order".bitFlags = 0 THEN '0'
						WHEN orc."order".bitFlags = 1 THEN '1'
						ELSE 'both'
					END AS bit_flag,
					CASE
						WHEN CAST(orc."order".baseAssetAmount AS DOUBLE) / 1e9 * CAST(oa.oracleprice AS DOUBLE) / 1e6 < 1000 THEN '0'
						WHEN CAST(orc."order".baseAssetAmount AS DOUBLE) / 1e9 * CAST(oa.oracleprice AS DOUBLE) / 1e6 < 10000 THEN '1000'
						WHEN CAST(orc."order".baseAssetAmount AS DOUBLE) / 1e9 * CAST(oa.oracleprice AS DOUBLE) / 1e6 < 100000 THEN '10000'
						WHEN CAST(orc."order".baseAssetAmount AS DOUBLE) / 1e9 * CAST(oa.oracleprice AS DOUBLE) / 1e6 < 500000 THEN '50000'
						ELSE '1000000'
					END AS cohort
				FROM filtered_action oa
				JOIN filtered_order orc
				  ON oa.taker = orc.user
				 AND oa.takerorderid = orc."order".orderid
				 AND oa.markettype = orc."order".marketType
				 AND oa.marketindex = orc."order".marketIndex
			)

			-- 1. Group by taker_order_type
			SELECT
				market_type,
				market_index,
				'all' AS cohort,
				taker_order_type,
				'all' AS taker_order_direction,
				'all' AS bit_flag,
				COUNT(auction_progress) AS auction_progress_count,
				MIN(auction_progress) AS auction_progress_min,
				MAX(auction_progress) AS auction_progress_max,
				AVG(auction_progress) AS auction_progress_avg,
				approx_percentile(auction_progress, 0.10) AS auction_progress_p10,
				approx_percentile(auction_progress, 0.25) AS auction_progress_p25,
				approx_percentile(auction_progress, 0.50) AS auction_progress_p50,
				approx_percentile(auction_progress, 0.75) AS auction_progress_p75,
				approx_percentile(auction_progress, 0.99) AS auction_progress_p99,
				MIN(fill_vs_oracle_abs) AS fill_vs_oracle_abs_min,
				MAX(fill_vs_oracle_abs) AS fill_vs_oracle_abs_max,
				AVG(fill_vs_oracle_abs) AS fill_vs_oracle_abs_avg,
				approx_percentile(fill_vs_oracle_abs, 0.10) AS fill_vs_oracle_abs_p10,
				approx_percentile(fill_vs_oracle_abs, 0.25) AS fill_vs_oracle_abs_p25,
				approx_percentile(fill_vs_oracle_abs, 0.50) AS fill_vs_oracle_abs_p50,
				approx_percentile(fill_vs_oracle_abs, 0.75) AS fill_vs_oracle_abs_p75,
				approx_percentile(fill_vs_oracle_abs, 0.99) AS fill_vs_oracle_abs_p99,
				MIN(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_min,
				MAX(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_max,
				AVG(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_avg,
				approx_percentile(fill_vs_oracle_abs_bps, 0.10) AS fill_vs_oracle_abs_bps_p10,
				approx_percentile(fill_vs_oracle_abs_bps, 0.25) AS fill_vs_oracle_abs_bps_p25,
				approx_percentile(fill_vs_oracle_abs_bps, 0.50) AS fill_vs_oracle_abs_bps_p50,
				approx_percentile(fill_vs_oracle_abs_bps, 0.75) AS fill_vs_oracle_abs_bps_p75,
				approx_percentile(fill_vs_oracle_abs_bps, 0.99) AS fill_vs_oracle_abs_bps_p99
			FROM joined_data
			GROUP BY market_type, market_index, taker_order_type

			UNION ALL

			-- 2. Group by cohort
			SELECT
				market_type,
				market_index,
				cohort,
				'all' AS taker_order_type,
				'all' AS taker_order_direction,
				'all' AS bit_flag,
				COUNT(auction_progress) AS auction_progress_count,
				MIN(auction_progress) AS auction_progress_min,
				MAX(auction_progress) AS auction_progress_max,
				AVG(auction_progress) AS auction_progress_avg,
				approx_percentile(auction_progress, 0.10) AS auction_progress_p10,
				approx_percentile(auction_progress, 0.25) AS auction_progress_p25,
				approx_percentile(auction_progress, 0.50) AS auction_progress_p50,
				approx_percentile(auction_progress, 0.75) AS auction_progress_p75,
				approx_percentile(auction_progress, 0.99) AS auction_progress_p99,
				MIN(fill_vs_oracle_abs) AS fill_vs_oracle_abs_min,
				MAX(fill_vs_oracle_abs) AS fill_vs_oracle_abs_max,
				AVG(fill_vs_oracle_abs) AS fill_vs_oracle_abs_avg,
				approx_percentile(fill_vs_oracle_abs, 0.10) AS fill_vs_oracle_abs_p10,
				approx_percentile(fill_vs_oracle_abs, 0.25) AS fill_vs_oracle_abs_p25,
				approx_percentile(fill_vs_oracle_abs, 0.50) AS fill_vs_oracle_abs_p50,
				approx_percentile(fill_vs_oracle_abs, 0.75) AS fill_vs_oracle_abs_p75,
				approx_percentile(fill_vs_oracle_abs, 0.99) AS fill_vs_oracle_abs_p99,
				MIN(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_min,
				MAX(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_max,
				AVG(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_avg,
				approx_percentile(fill_vs_oracle_abs_bps, 0.10) AS fill_vs_oracle_abs_bps_p10,
				approx_percentile(fill_vs_oracle_abs_bps, 0.25) AS fill_vs_oracle_abs_bps_p25,
				approx_percentile(fill_vs_oracle_abs_bps, 0.50) AS fill_vs_oracle_abs_bps_p50,
				approx_percentile(fill_vs_oracle_abs_bps, 0.75) AS fill_vs_oracle_abs_bps_p75,
				approx_percentile(fill_vs_oracle_abs_bps, 0.99) AS fill_vs_oracle_abs_bps_p99
			FROM joined_data
			GROUP BY market_type, market_index, cohort

			UNION ALL

			-- 3. Group by bit_flag
			SELECT
				market_type,
				market_index,
				'all' AS cohort,
				'all' AS taker_order_type,
				'all' AS taker_order_direction,
				bit_flag,
				COUNT(auction_progress) AS auction_progress_count,
				MIN(auction_progress) AS auction_progress_min,
				MAX(auction_progress) AS auction_progress_max,
				AVG(auction_progress) AS auction_progress_avg,
				approx_percentile(auction_progress, 0.10) AS auction_progress_p10,
				approx_percentile(auction_progress, 0.25) AS auction_progress_p25,
				approx_percentile(auction_progress, 0.50) AS auction_progress_p50,
				approx_percentile(auction_progress, 0.75) AS auction_progress_p75,
				approx_percentile(auction_progress, 0.99) AS auction_progress_p99,
				MIN(fill_vs_oracle_abs) AS fill_vs_oracle_abs_min,
				MAX(fill_vs_oracle_abs) AS fill_vs_oracle_abs_max,
				AVG(fill_vs_oracle_abs) AS fill_vs_oracle_abs_avg,
				approx_percentile(fill_vs_oracle_abs, 0.10) AS fill_vs_oracle_abs_p10,
				approx_percentile(fill_vs_oracle_abs, 0.25) AS fill_vs_oracle_abs_p25,
				approx_percentile(fill_vs_oracle_abs, 0.50) AS fill_vs_oracle_abs_p50,
				approx_percentile(fill_vs_oracle_abs, 0.75) AS fill_vs_oracle_abs_p75,
				approx_percentile(fill_vs_oracle_abs, 0.99) AS fill_vs_oracle_abs_p99,
				MIN(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_min,
				MAX(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_max,
				AVG(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_avg,
				approx_percentile(fill_vs_oracle_abs_bps, 0.10) AS fill_vs_oracle_abs_bps_p10,
				approx_percentile(fill_vs_oracle_abs_bps, 0.25) AS fill_vs_oracle_abs_bps_p25,
				approx_percentile(fill_vs_oracle_abs_bps, 0.50) AS fill_vs_oracle_abs_bps_p50,
				approx_percentile(fill_vs_oracle_abs_bps, 0.75) AS fill_vs_oracle_abs_bps_p75,
				approx_percentile(fill_vs_oracle_abs_bps, 0.99) AS fill_vs_oracle_abs_bps_p99
			FROM joined_data
			GROUP BY market_type, market_index, bit_flag

			UNION ALL

			-- 4. Group by taker_order_direction
			SELECT
				market_type,
				market_index,
				'all' AS cohort,
				'all' AS taker_order_type,
				taker_order_direction,
				'all' AS bit_flag,
				COUNT(auction_progress) AS auction_progress_count,
				MIN(auction_progress) AS auction_progress_min,
				MAX(auction_progress) AS auction_progress_max,
				AVG(auction_progress) AS auction_progress_avg,
				approx_percentile(auction_progress, 0.10) AS auction_progress_p10,
				approx_percentile(auction_progress, 0.25) AS auction_progress_p25,
				approx_percentile(auction_progress, 0.50) AS auction_progress_p50,
				approx_percentile(auction_progress, 0.75) AS auction_progress_p75,
				approx_percentile(auction_progress, 0.99) AS auction_progress_p99,
				MIN(fill_vs_oracle_abs) AS fill_vs_oracle_abs_min,
				MAX(fill_vs_oracle_abs) AS fill_vs_oracle_abs_max,
				AVG(fill_vs_oracle_abs) AS fill_vs_oracle_abs_avg,
				approx_percentile(fill_vs_oracle_abs, 0.10) AS fill_vs_oracle_abs_p10,
				approx_percentile(fill_vs_oracle_abs, 0.25) AS fill_vs_oracle_abs_p25,
				approx_percentile(fill_vs_oracle_abs, 0.50) AS fill_vs_oracle_abs_p50,
				approx_percentile(fill_vs_oracle_abs, 0.75) AS fill_vs_oracle_abs_p75,
				approx_percentile(fill_vs_oracle_abs, 0.99) AS fill_vs_oracle_abs_p99,
				MIN(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_min,
				MAX(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_max,
				AVG(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_avg,
				approx_percentile(fill_vs_oracle_abs_bps, 0.10) AS fill_vs_oracle_abs_bps_p10,
				approx_percentile(fill_vs_oracle_abs_bps, 0.25) AS fill_vs_oracle_abs_bps_p25,
				approx_percentile(fill_vs_oracle_abs_bps, 0.50) AS fill_vs_oracle_abs_bps_p50,
				approx_percentile(fill_vs_oracle_abs_bps, 0.75) AS fill_vs_oracle_abs_bps_p75,
				approx_percentile(fill_vs_oracle_abs_bps, 0.99) AS fill_vs_oracle_abs_bps_p99
			FROM joined_data
			GROUP BY market_type, market_index, taker_order_direction

			UNION ALL

			-- 5. Full rollup
			SELECT
				market_type,
				market_index,
				'all' AS cohort,
				'all' AS taker_order_type,
				'all' AS taker_order_direction,
				'all' AS bit_flag,
				COUNT(auction_progress) AS auction_progress_count,
				MIN(auction_progress) AS auction_progress_min,
				MAX(auction_progress) AS auction_progress_max,
				AVG(auction_progress) AS auction_progress_avg,
				approx_percentile(auction_progress, 0.10) AS auction_progress_p10,
				approx_percentile(auction_progress, 0.25) AS auction_progress_p25,
				approx_percentile(auction_progress, 0.50) AS auction_progress_p50,
				approx_percentile(auction_progress, 0.75) AS auction_progress_p75,
				approx_percentile(auction_progress, 0.99) AS auction_progress_p99,
				MIN(fill_vs_oracle_abs) AS fill_vs_oracle_abs_min,
				MAX(fill_vs_oracle_abs) AS fill_vs_oracle_abs_max,
				AVG(fill_vs_oracle_abs) AS fill_vs_oracle_abs_avg,
				approx_percentile(fill_vs_oracle_abs, 0.10) AS fill_vs_oracle_abs_p10,
				approx_percentile(fill_vs_oracle_abs, 0.25) AS fill_vs_oracle_abs_p25,
				approx_percentile(fill_vs_oracle_abs, 0.50) AS fill_vs_oracle_abs_p50,
				approx_percentile(fill_vs_oracle_abs, 0.75) AS fill_vs_oracle_abs_p75,
				approx_percentile(fill_vs_oracle_abs, 0.99) AS fill_vs_oracle_abs_p99,
				MIN(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_min,
				MAX(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_max,
				AVG(fill_vs_oracle_abs_bps) AS fill_vs_oracle_abs_bps_avg,
				approx_percentile(fill_vs_oracle_abs_bps, 0.10) AS fill_vs_oracle_abs_bps_p10,
				approx_percentile(fill_vs_oracle_abs_bps, 0.25) AS fill_vs_oracle_abs_bps_p25,
				approx_percentile(fill_vs_oracle_abs_bps, 0.50) AS fill_vs_oracle_abs_bps_p50,
				approx_percentile(fill_vs_oracle_abs_bps, 0.75) AS fill_vs_oracle_abs_bps_p75,
				approx_percentile(fill_vs_oracle_abs_bps, 0.99) AS fill_vs_oracle_abs_bps_p99
			FROM joined_data
			GROUP BY market_type, market_index
		`;

		const results = await query(queryString);

		return results.map((result) => ({
			marketType: result.market_type || '',
			marketIndex: result.market_index ?? '',
			market: '',
			cohort: result.cohort as FillCohort,
			takerOrderType: result.taker_order_type as FillTakerOrderType,
			takerOrderDirection: result.taker_order_direction as FillDirection,
			bitFlag: result.bit_flag as FillBitFlag,
			auctionProgressCount: result.auction_progress_count ?? '0',
			auctionProgressMin: result.auction_progress_min ?? '0',
			auctionProgressMax: result.auction_progress_max ?? '0',
			auctionProgressAvg: result.auction_progress_avg ?? '0',
			auctionProgressP10: result.auction_progress_p10 ?? '0',
			auctionProgressP25: result.auction_progress_p25 ?? '0',
			auctionProgressP50: result.auction_progress_p50 ?? '0',
			auctionProgressP75: result.auction_progress_p75 ?? '0',
			auctionProgressP99: result.auction_progress_p99 ?? '0',
			fillVsOracleAbsMin: result.fill_vs_oracle_abs_min ?? '0',
			fillVsOracleAbsMax: result.fill_vs_oracle_abs_max ?? '0',
			fillVsOracleAbsAvg: result.fill_vs_oracle_abs_avg ?? '0',
			fillVsOracleAbsP10: result.fill_vs_oracle_abs_p10 ?? '0',
			fillVsOracleAbsP25: result.fill_vs_oracle_abs_p25 ?? '0',
			fillVsOracleAbsP50: result.fill_vs_oracle_abs_p50 ?? '0',
			fillVsOracleAbsP75: result.fill_vs_oracle_abs_p75 ?? '0',
			fillVsOracleAbsP99: result.fill_vs_oracle_abs_p99 ?? '0',
			fillVsOracleAbsBpsMin: result.fill_vs_oracle_abs_bps_min ?? '0',
			fillVsOracleAbsBpsMax: result.fill_vs_oracle_abs_bps_max ?? '0',
			fillVsOracleAbsBpsAvg: result.fill_vs_oracle_abs_bps_avg ?? '0',
			fillVsOracleAbsBpsP10: result.fill_vs_oracle_abs_bps_p10 ?? '0',
			fillVsOracleAbsBpsP25: result.fill_vs_oracle_abs_bps_p25 ?? '0',
			fillVsOracleAbsBpsP50: result.fill_vs_oracle_abs_bps_p50 ?? '0',
			fillVsOracleAbsBpsP75: result.fill_vs_oracle_abs_bps_p75 ?? '0',
			fillVsOracleAbsBpsP99: result.fill_vs_oracle_abs_bps_p99 ?? '0',
		}));
	};

	return {
		getAuctionLatencyStats,
	};
};

export const TriggerOrderAnalyticsRepository = () => {
	const { query } = Athena();

	const getTriggerOrderFillAnalytics = async (
		from: number,
		to: number,
		orderType?: 'triggerMarket' | 'triggerLimit' | 'all'
	): Promise<TriggerOrderFillStats[]> => {
		if (orderType === 'all') {
			orderType = undefined;
		}

		const queryString = `
			${getTimeRangeAndPartitions(from, to, 'v')},

			trigger_order_actions AS (
				SELECT
					*,
					CAST(oart.oracleprice as double) / 1e6 as "actual_trigger_price"
				FROM
					eventtype_orderactionrecord oart
				JOIN valid_partitions vp
					ON oart.year = vp.year AND oart.month = vp.month AND oart.day = vp.day
				JOIN time_range tr
					ON CAST(oart.ts AS INT) BETWEEN tr.from_ts AND tr.to_ts
				WHERE
					oart.action = 'trigger'
			),
			trigger_order_actions_with_orders AS (
				SELECT
					*,
					CAST(o."order".baseAssetAmount AS double) / 1e9 * CAST(oart.oracleprice as double) / 1e6 AS "order_notional_value"
				FROM
					eventtype_orderrecord o
				JOIN valid_partitions vp
					ON o.year = vp.year AND o.month = vp.month AND o.day = vp.day
				JOIN time_range tr
					ON CAST(o.ts AS INT) BETWEEN tr.from_ts AND tr.to_ts
				JOIN trigger_order_actions oart
					-- triggered user is always taker in the event
					ON o.user = oart.taker AND o."order".orderid = oart.takerorderid
				WHERE 1=1
				${orderType ? `AND o."order".ordertype = '${orderType}'` : ''}
			),
			fill_events_for_trigger_orders AS (
				SELECT
					oart.taker as "trigger-taker",
					oart.takerorderid as "trigger_orderid",
					oart.slot as "trigger_slot",
					tor."order".slot as "order_slot",
					CAST(oart.slot as int) - CAST(tor."order".slot as int) as "slot_age_at_initial_trigger",
					tor."order".ordertype as "order_type",
					tor."order".reduceonly as "reduce_only",
					t.slot - oart.slot as "slots_from_trigger_to_fully_fill",
					t.markettype as "market_type",
					t.marketindex as "market_index",
					CASE oart.taker -- the triggered user avg fill price
					WHEN t.taker THEN 1000.0 * CAST(t.takerordercumulativequoteassetamountfilled AS double) / CAST(t.takerordercumulativebaseassetamountfilled AS double)
					WHEN t.maker THEN 1000.0 * CAST(t.makerordercumulativequoteassetamountfilled AS double) / CAST(t.makerordercumulativebaseassetamountfilled AS double)
					END as triggeree_avg_fill_price,
					oart.actual_trigger_price as "actual_trigger_price",
					cast(t.oracleprice as DOUBLE) / 1e6 as "oracle_price",
					oart.action,
					CASE oart.taker -- the triggered user was fully filled
					WHEN t.taker THEN t.takerorderbaseassetamount = t.takerordercumulativebaseassetamountfilled
					WHEN t.maker THEN t.makerorderbaseassetamount = t.makerordercumulativebaseassetamountfilled
					END as trigger_filled,
					tor.order_notional_value,
					CASE
						WHEN tor.order_notional_value < 1000 THEN '0'
						WHEN tor.order_notional_value < 10000 THEN '1000'
						WHEN tor.order_notional_value < 100000 THEN '10000'
						WHEN tor.order_notional_value < 500000 THEN '50000'
						ELSE '1000000'
					END AS cohort,
					t.taker as "t_taker",
					t.takerorderid as "t_takerorderid",
					t.maker as "t_maker",
					t.makerorderid as "t_makerorderid",
					t.actionexplanation as "t_actionexplanation",
					t.txsig as "t_txsig",
					oart.txsig
				FROM
					eventtype_traderecord t
				JOIN valid_partitions vp
					ON t.year = vp.year AND t.month = vp.month AND t.day = vp.day
				JOIN time_range tr
					ON CAST(t.ts AS INT) BETWEEN tr.from_ts AND tr.to_ts
				JOIN trigger_order_actions oart
					-- triggered user is always taker in the oart trigger event
					ON (
						(t.taker = oart.taker AND t.takerorderid = oart.takerorderid)
						OR
						(t.maker = oart.taker AND t.makerorderid = oart.takerorderid)
					)
				JOIN trigger_order_actions_with_orders tor
					-- triggered user is always taker in the event
					ON tor.user = oart.taker AND tor."order".orderid = oart.takerorderid
			)

			SELECT
				market_type,
				market_index,
				cohort,

				approx_percentile(slots_from_trigger_to_fully_fill, 0.10) AS slots_to_fill_p10,
				approx_percentile(slots_from_trigger_to_fully_fill, 0.25) AS slots_to_fill_p25,
				approx_percentile(slots_from_trigger_to_fully_fill, 0.50) AS slots_to_fill_p50,
				approx_percentile(slots_from_trigger_to_fully_fill, 0.75) AS slots_to_fill_p75,
				approx_percentile(slots_from_trigger_to_fully_fill, 0.99) AS slots_to_fill_p99,
				max(slots_from_trigger_to_fully_fill) AS slots_to_fill_max,
				avg(slots_from_trigger_to_fully_fill) AS slots_to_fill_avg,
				
				min(abs(triggeree_avg_fill_price / actual_trigger_price - 1)) AS fill_vs_trigger_min,
				max(abs(triggeree_avg_fill_price / actual_trigger_price - 1)) AS fill_vs_trigger_max,
				avg(abs(triggeree_avg_fill_price / actual_trigger_price - 1)) AS fill_vs_trigger_avg,
				approx_percentile(abs(triggeree_avg_fill_price / actual_trigger_price - 1), 0.10) AS fill_vs_trigger_p10,
				approx_percentile(abs(triggeree_avg_fill_price / actual_trigger_price - 1), 0.25) AS fill_vs_trigger_p25,
				approx_percentile(abs(triggeree_avg_fill_price / actual_trigger_price - 1), 0.50) AS fill_vs_trigger_p50,
				approx_percentile(abs(triggeree_avg_fill_price / actual_trigger_price - 1), 0.75) AS fill_vs_trigger_p75,
				approx_percentile(abs(triggeree_avg_fill_price / actual_trigger_price - 1), 0.99) AS fill_vs_trigger_p99,

				COUNT_IF(order_type = 'triggerMarket') AS trigger_market_count,
				COUNT_IF(order_type = 'triggerLimit') AS trigger_limit_count,
				COUNT(*) AS total_triggered_orders,
				
				COUNT_IF(reduce_only = true) AS reduce_only_count,
				COUNT_IF(reduce_only = false) AS non_reduce_only_count

			FROM
				fill_events_for_trigger_orders
			WHERE
				trigger_filled = true
				AND slot_age_at_initial_trigger > 10
			GROUP BY
				market_type, market_index, cohort
			ORDER BY 
				market_type,
				CAST(market_index AS INTEGER),
				CASE 
					WHEN cohort = '0' THEN 1
					WHEN cohort = '1000' THEN 2
					WHEN cohort = '10000' THEN 3
					WHEN cohort = '100000' THEN 4
					WHEN cohort = '500000' THEN 5
					WHEN cohort = '1000000' THEN 6
					ELSE 7
				END
		`;

		const results = await query(queryString);

		return results.map((result) => ({
			marketType: result.market_type || '',
			marketIndex: result.market_index ?? '',
			market: '',
			cohort: result.cohort ?? '',
			orderType: orderType ?? 'all',
			slotsToFillP10: result.slots_to_fill_p10 ?? '0',
			slotsToFillP25: result.slots_to_fill_p25 ?? '0',
			slotsToFillP50: result.slots_to_fill_p50 ?? '0',
			slotsToFillP75: result.slots_to_fill_p75 ?? '0',
			slotsToFillP99: result.slots_to_fill_p99 ?? '0',
			slotsToFillMax: result.slots_to_fill_max ?? '0',
			slotsToFillAvg: result.slots_to_fill_avg ?? '0',
			fillVsTriggerMin: result.fill_vs_trigger_min ?? '0',
			fillVsTriggerMax: result.fill_vs_trigger_max ?? '0',
			fillVsTriggerAvg: result.fill_vs_trigger_avg ?? '0',
			fillVsTriggerP10: result.fill_vs_trigger_p10 ?? '0',
			fillVsTriggerP25: result.fill_vs_trigger_p25 ?? '0',
			fillVsTriggerP50: result.fill_vs_trigger_p50 ?? '0',
			fillVsTriggerP75: result.fill_vs_trigger_p75 ?? '0',
			fillVsTriggerP99: result.fill_vs_trigger_p99 ?? '0',
			triggerMarketCount: result.trigger_market_count ?? '0',
			triggerLimitCount: result.trigger_limit_count ?? '0',
			totalTriggeredOrders: result.total_triggered_orders ?? '0',
			reduceOnlyCount: result.reduce_only_count ?? '0',
			nonReduceOnlyCount: result.non_reduce_only_count ?? '0',
		}));
	};

	return {
		getTriggerOrderFillAnalytics,
	};
};

export const LiquiditySourceAnalyticsRepository = () => {
	const { query } = Athena();

	const getLiquiditySourceAnalytics = async (
		from: number,
		to: number
	): Promise<FillLiquiditySourceStats[]> => {
		const queryString = `
			${getTimeRangeAndPartitions(from, to, 'v')},

			order_actions AS (
			    SELECT
			        *,
			        CAST(et.baseassetamountfilled AS double) / 1e9 * CAST(et.oracleprice as double) / 1e6 AS fill_notional
			    FROM eventtype_traderecord et
			    JOIN valid_partitions vp ON et.year = vp.year AND et.month = vp.month AND et.day = vp.day
			    JOIN time_range tr ON CAST(et.ts AS INT) BETWEEN tr.from_ts AND tr.to_ts
			    WHERE et.action = 'fill'
			),

			orders AS (
			    SELECT *
			    FROM eventtype_orderrecord et
			    JOIN valid_partitions vp ON et.year = vp.year AND et.month = vp.month AND et.day = vp.day
			    JOIN time_range tr ON CAST(et.ts AS INT) BETWEEN tr.from_ts AND tr.to_ts
			),

			joined_data AS (
				SELECT
				    oa.ts as ts,
				    oa.markettype as market_type,
				    oa.marketindex as market_index,
				    CASE
				        WHEN orct."order".bitFlags = 0 THEN '0'
				        WHEN orct."order".bitFlags = 1 THEN '1'
				        ELSE 'both'
				    END AS bit_flag,
					orct."order".orderType as taker_order_type,
					orct."order".orderId as taker_order_id,
					orct.user as taker_user,
					oa.actionexplanation as action_explanation,
					CAST(oa.baseassetamountfilled AS double) / 1e9 * CAST(oa.oracleprice as double) / 1e6 AS fill_notional,
					CASE
						WHEN CAST(oa.baseassetamountfilled AS double) / 1e9 * CAST(oa.oracleprice as double) / 1e6 < 1000 THEN '0'
						WHEN CAST(oa.baseassetamountfilled AS double) / 1e9 * CAST(oa.oracleprice as double) / 1e6 < 10000 THEN '1000'
						WHEN CAST(oa.baseassetamountfilled AS double) / 1e9 * CAST(oa.oracleprice as double) / 1e6 < 100000 THEN '10000'
						WHEN CAST(oa.baseassetamountfilled AS double) / 1e9 * CAST(oa.oracleprice as double) / 1e6 < 500000 THEN '50000'
						ELSE '1000000'
					END AS cohort
				FROM order_actions oa
				JOIN orders orct
				  ON oa.taker = orct.user AND oa.takerorderid = orct."order".orderid
			)

			-- 1. Group by taker_order_type
			SELECT
			    market_type,
			    market_index,
				CAST('all' AS VARCHAR) AS cohort,
			    taker_order_type,
			    'all' AS bit_flag,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithMatch') AS total_match,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithMatchJit') AS total_match_jit,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithAmm') AS total_amm,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithAmmJit') AS total_amm_jit,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithAmmJitLpSplit') AS total_amm_jit_lp_split,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithLpJit') AS total_lp_jit,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFillWithSerum') AS total_serum,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFillWithPhoenix') AS total_phoenix,
			    COUNT_IF( action_explanation = 'orderFilledWithMatch' ) AS count_match,
			    COUNT_IF( action_explanation = 'orderFilledWithMatchJit') AS count_match_jit,
			    COUNT_IF( action_explanation = 'orderFilledWithAmm') AS count_amm,
			    COUNT_IF( action_explanation = 'orderFilledWithAmmJit') AS count_amm_jit,
			    COUNT_IF( action_explanation = 'orderFilledWithAmmJitLpSplit') AS count_amm_jit_lp_split,
			    COUNT_IF( action_explanation = 'orderFilledWithLpJit') AS count_lp_jit,
			    COUNT_IF( action_explanation = 'orderFillWithSerum') AS count_serum,
			    COUNT_IF( action_explanation = 'orderFillWithPhoenix') AS count_phoenix
			FROM joined_data
			GROUP BY market_type, market_index, taker_order_type

			UNION ALL

			-- 2. Group by cohort
			SELECT
			    market_type,
			    market_index,
			    cohort,
			    'all' AS taker_order_type,
			    'all' AS bit_flag,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithMatch') AS total_match,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithMatchJit') AS total_match_jit,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithAmm') AS total_amm,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithAmmJit') AS total_amm_jit,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithAmmJitLpSplit') AS total_amm_jit_lp_split,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithLpJit') AS total_lp_jit,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFillWithSerum') AS total_serum,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFillWithPhoenix') AS total_phoenix,
			    COUNT_IF( action_explanation = 'orderFilledWithMatch' ) AS count_match,
			    COUNT_IF( action_explanation = 'orderFilledWithMatchJit') AS count_match_jit,
			    COUNT_IF( action_explanation = 'orderFilledWithAmm') AS count_amm,
			    COUNT_IF( action_explanation = 'orderFilledWithAmmJit') AS count_amm_jit,
			    COUNT_IF( action_explanation = 'orderFilledWithAmmJitLpSplit') AS count_amm_jit_lp_split,
			    COUNT_IF( action_explanation = 'orderFilledWithLpJit') AS count_lp_jit,
			    COUNT_IF( action_explanation = 'orderFillWithSerum') AS count_serum,
			    COUNT_IF( action_explanation = 'orderFillWithPhoenix') AS count_phoenix
			FROM joined_data
			GROUP BY market_type, market_index, cohort

			UNION ALL

			-- 3. Group by bit_flag
			SELECT
			    market_type,
			    market_index,
				CAST('all' AS VARCHAR) AS cohort,
			    'all' AS taker_order_type,
			    bit_flag,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithMatch') AS total_match,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithMatchJit') AS total_match_jit,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithAmm') AS total_amm,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithAmmJit') AS total_amm_jit,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithAmmJitLpSplit') AS total_amm_jit_lp_split,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithLpJit') AS total_lp_jit,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFillWithSerum') AS total_serum,
			    SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFillWithPhoenix') AS total_phoenix,
			    COUNT_IF( action_explanation = 'orderFilledWithMatch' ) AS count_match,
			    COUNT_IF( action_explanation = 'orderFilledWithMatchJit') AS count_match_jit,
			    COUNT_IF( action_explanation = 'orderFilledWithAmm') AS count_amm,
			    COUNT_IF( action_explanation = 'orderFilledWithAmmJit') AS count_amm_jit,
			    COUNT_IF( action_explanation = 'orderFilledWithAmmJitLpSplit') AS count_amm_jit_lp_split,
			    COUNT_IF( action_explanation = 'orderFilledWithLpJit') AS count_lp_jit,
			    COUNT_IF( action_explanation = 'orderFillWithSerum') AS count_serum,
			    COUNT_IF( action_explanation = 'orderFillWithPhoenix') AS count_phoenix
			FROM joined_data
			GROUP BY market_type, market_index, bit_flag

			-- 4. Group by full rollup (all 'all')
			UNION ALL

			SELECT
				market_type,
				market_index,
				CAST('all' AS VARCHAR) AS cohort,
				'all' AS taker_order_type,
				'all' AS bit_flag,
				SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithMatch') AS total_match,
				SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithMatchJit') AS total_match_jit,
				SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithAmm') AS total_amm,
				SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithAmmJit') AS total_amm_jit,
				SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithAmmJitLpSplit') AS total_amm_jit_lp_split,
				SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFilledWithLpJit') AS total_lp_jit,
				SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFillWithSerum') AS total_serum,
				SUM(fill_notional) FILTER (WHERE action_explanation = 'orderFillWithPhoenix') AS total_phoenix,
				COUNT_IF( action_explanation = 'orderFilledWithMatch' ) AS count_match,
				COUNT_IF( action_explanation = 'orderFilledWithMatchJit') AS count_match_jit,
				COUNT_IF( action_explanation = 'orderFilledWithAmm') AS count_amm,
				COUNT_IF( action_explanation = 'orderFilledWithAmmJit') AS count_amm_jit,
				COUNT_IF( action_explanation = 'orderFilledWithAmmJitLpSplit') AS count_amm_jit_lp_split,
				COUNT_IF( action_explanation = 'orderFilledWithLpJit') AS count_lp_jit,
				COUNT_IF( action_explanation = 'orderFillWithSerum') AS count_serum,
				COUNT_IF( action_explanation = 'orderFillWithPhoenix') AS count_phoenix
			FROM joined_data
			GROUP BY market_type, market_index
		`;

		const results = await query(queryString);

		return results.map((result) => ({
			marketType: result.market_type || '',
			marketIndex: result.market_index ?? '',
			bitFlag: (result.bit_flag as FillBitFlag) || '',
			market: '',
			cohort: (result.cohort as FillCohort) || '0',
			takerOrderType: (result.taker_order_type as FillTakerOrderType) || '',
			totalMatch: result.total_match ?? '0',
			totalMatchJit: result.total_match_jit ?? '0',
			totalAmm: result.total_amm ?? '0',
			totalAmmJit: result.total_amm_jit ?? '0',
			totalAmmJitLpSplit: result.total_amm_jit_lp_split ?? '0',
			totalLpJit: result.total_lp_jit ?? '0',
			totalSerum: result.total_serum ?? '0',
			totalPhoenix: result.total_phoenix ?? '0',
			countMatch: result.count_match ?? '0',
			countMatchJit: result.count_match_jit ?? '0',
			countAmm: result.count_amm ?? '0',
			countAmmJit: result.count_amm_jit ?? '0',
			countAmmJitLpSplit: result.count_amm_jit_lp_split ?? '0',
			countLpJit: result.count_lp_jit ?? '0',
			countSerum: result.count_serum ?? '0',
			countPhoenix: result.count_phoenix ?? '0',
		}));
	};

	return {
		getLiquiditySourceAnalytics,
	};
};
