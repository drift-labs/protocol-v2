import { Athena } from '../client';

export interface TakerFillVsOracleBpsResult {
	MarketIndex: string;
	TakerBuyBpsFromOracle_ALL: string | null;
	TakerSellBpsFromOracle_ALL: string | null;
	TakerBuyBpsFromOracle_1e0: string | null;
	TakerBuyBpsFromOracle_1e3: string | null;
	TakerBuyBpsFromOracle_1e4: string | null;
	TakerBuyBpsFromOracle_1e5: string | null;
	TakerBuyBpsFromOracle_1e6: string | null;
	TakerSellBpsFromOracle_1e0: string | null;
	TakerSellBpsFromOracle_1e3: string | null;
	TakerSellBpsFromOracle_1e4: string | null;
	TakerSellBpsFromOracle_1e5: string | null;
	TakerSellBpsFromOracle_1e6: string | null;
	Zero: string;
}

export type TakerFillVsOracleBpsRedisResult = {
	marketIndex: string;
	takerBuyBpsFromOracle: {
		all: string | null;
		'1e0': string | null;
		'1e3': string | null;
		'1e4': string | null;
		'1e5': string | null;
		'1e6': string | null;
	};
	takerSellBpsFromOracle: {
		all: string | null;
		'1e0': string | null;
		'1e3': string | null;
		'1e4': string | null;
		'1e5': string | null;
		'1e6': string | null;
	};
	updatedAtTs: number;
};

export const FillQualityAnalyticsRepository = () => {
	const { query } = Athena();

	/**
	 * Get taker fill vs oracle basis points, bucketed by order notional cohorts at place-time size.
	 * Returns a rolling average per cohort/direction, partitioned by market.
	 * This query returns data for ALL perp markets in a single result set.
	 *
	 * @param from - Unix timestamp in milliseconds
	 * @param to - Unix timestamp in milliseconds
	 * @param baseDecimals - Base decimals for the market (default: 9)
	 * @param smoothingMinutes - Minutes for rolling average (default: 60)
	 * @returns Array of time series data with taker fill vs oracle bps by cohort and market
	 */
	const getTakerFillVsOracleBps = async (
		fromMs: number,
		toMs: number,
		baseDecimals: number = 9,
		smoothingMinutes: number = 60
	): Promise<TakerFillVsOracleBpsResult[]> => {
		// Taker fill vs Oracle bps, bucketed by order notional cohorts at place-time size
		// Final output: latest non-null rolling average per cohort/direction, PARTITIONED BY market
		const queryString = `
WITH
from_dt AS (
  SELECT
    date_format(from_unixtime(CAST(${fromMs}/1000 AS BIGINT)) AT TIME ZONE 'UTC','%Y') AS yf,
    date_format(from_unixtime(CAST(${fromMs}/1000 AS BIGINT)) AT TIME ZONE 'UTC','%m') AS mf,
    date_format(from_unixtime(CAST(${fromMs}/1000 AS BIGINT)) AT TIME ZONE 'UTC','%d') AS df
),
to_dt AS (
  SELECT
    date_format(from_unixtime(CAST(${toMs}/1000 AS BIGINT)) AT TIME ZONE 'UTC','%Y') AS yt,
    date_format(from_unixtime(CAST(${toMs}/1000 AS BIGINT)) AT TIME ZONE 'UTC','%m') AS mt,
    date_format(from_unixtime(CAST(${toMs}/1000 AS BIGINT)) AT TIME ZONE 'UTC','%d') AS dt
),

-- Dedup to the earliest OrderRecord per (txsig,user,orderid,marketindex) to reflect "place" state
orders_dedup AS (
  SELECT *
  FROM (
    SELECT
      CAST(orx.ts AS BIGINT)                                        AS order_ts_epoch,
      orx.txsig                                                     AS txsig,
      orx.user                                                      AS user,
      orx."order".orderid                                           AS orderid,
      orx."order".marketindex                                       AS marketindex,
      CAST(orx."order".baseassetamount AS DOUBLE)                   AS base_asset_amount_raw,
      ROW_NUMBER() OVER (
        PARTITION BY orx.txsig, orx.user, orx."order".orderid, orx."order".marketindex
        ORDER BY CAST(orx.ts AS BIGINT) ASC
      ) AS rn
    FROM eventtype_orderrecord orx
    CROSS JOIN from_dt f
    CROSS JOIN to_dt t
    WHERE
      orx."order".markettype = 'perp'
      -- UTC-safe pruning on VARCHAR partitions
      AND orx.year BETWEEN f.yf AND t.yt
      AND (
            orx.year >  f.yf
         OR (orx.year = f.yf AND orx.month >  f.mf)
         OR (orx.year = f.yf AND orx.month = f.mf AND orx.day >= f.df)
      )
      AND (
            orx.year <  t.yt
         OR (orx.year = t.yt AND orx.month <  t.mt)
         OR (orx.year = t.yt AND orx.month = t.mt AND orx.day <= t.dt)
      )
      -- absolute time guardrails (ts is epoch seconds in table)
      AND CAST(orx.ts AS BIGINT) BETWEEN CAST(${fromMs}/1000 AS BIGINT) AND CAST(${toMs}/1000 AS BIGINT)
  ) t1
  WHERE rn = 1
),

-- Trade fills (taker perspective) within the window (all markets)
trades AS (
  SELECT
    CAST(tr.ts AS BIGINT)                               AS ts_epoch,
    tr.txsig                                            AS txsig,
    tr.taker                                            AS user,
    tr.takerorderid                                     AS orderid,
    tr.marketindex                                      AS marketindex,
    LOWER(tr.takerorderdirection)                       AS dir,
    CAST(tr.quoteassetamountfilled AS DOUBLE)           AS q_filled,
    CAST(tr.baseassetamountfilled  AS DOUBLE)           AS b_filled,
    CAST(tr.oracleprice            AS DOUBLE)           AS oracle_raw
  FROM eventtype_traderecord tr
  CROSS JOIN from_dt f
  CROSS JOIN to_dt t
  WHERE
    LOWER(tr.action) = 'fill'
    AND tr.markettype = 'perp'
    AND LOWER(tr.takerorderdirection) IN ('long','short')

    -- UTC-safe pruning on VARCHAR partitions
    AND tr.year BETWEEN f.yf AND t.yt
    AND (
          tr.year >  f.yf
       OR (tr.year = f.yf AND tr.month >  f.mf)
       OR (tr.year = f.yf AND tr.month = f.mf AND tr.day >= f.df)
    )
    AND (
          tr.year <  t.yt
       OR (tr.year = t.yt AND tr.month <  t.mt)
       OR (tr.year = t.yt AND tr.month = t.mt AND tr.day <= t.dt)
    )

    -- absolute time guardrails (ts is epoch seconds in table)
    AND CAST(tr.ts AS BIGINT) BETWEEN CAST(${fromMs}/1000 AS BIGINT) AND CAST(${toMs}/1000 AS BIGINT)
),

-- Join fills to the order's initial size; compute notional cohort and taker bps from oracle
joined AS (
  SELECT
    from_unixtime(tr.ts_epoch) AS Time,
    tr.marketindex             AS MarketIndex,
    tr.dir                     AS dir,
    (
      (
        (tr.q_filled / NULLIF(tr.b_filled, 0))
        * pow(10.0, (${baseDecimals} - 6))
      )
      / (tr.oracle_raw / 1e6) - 1.0
    ) * 10000.0 AS taker_bps_from_oracle,
    ( (od.base_asset_amount_raw * 1e-9) * (tr.oracle_raw * 1e-6) ) AS order_value
  FROM trades tr
  JOIN orders_dedup od
    ON  od.txsig       = tr.txsig
    AND od.user        = tr.user
    AND od.orderid     = tr.orderid
    AND od.marketindex = tr.marketindex
),

-- Bucket into cohorts
bucketed AS (
  SELECT
    Time,
    MarketIndex,
    dir,
    taker_bps_from_oracle,
    CASE
      WHEN order_value > 0      AND order_value < 1000       THEN '1e0'
      WHEN order_value >= 1000  AND order_value < 10000      THEN '1e3'
      WHEN order_value >= 10000 AND order_value < 100000     THEN '1e4'
      WHEN order_value >= 100000 AND order_value < 1000000   THEN '1e5'
      WHEN order_value >= 1000000                            THEN '1e6'
      ELSE 'other'
    END AS cohort
  FROM joined
),

-- Compute rolling averages
rolling_avgs AS (
  SELECT
    Time,
    MarketIndex,

    -- Non-cohort series (ALL fills regardless of cohort)
    AVG(CASE WHEN dir = 'long'  THEN taker_bps_from_oracle END)
      OVER (PARTITION BY MarketIndex ORDER BY Time RANGE BETWEEN INTERVAL '${smoothingMinutes}' MINUTE PRECEDING AND CURRENT ROW)
      AS "TakerBuyBpsFromOracle_ALL",

    AVG(CASE WHEN dir = 'short' THEN taker_bps_from_oracle END)
      OVER (PARTITION BY MarketIndex ORDER BY Time RANGE BETWEEN INTERVAL '${smoothingMinutes}' MINUTE PRECEDING AND CURRENT ROW)
      AS "TakerSellBpsFromOracle_ALL",

    -- rolling average by cohort/direction (NULLs ignored by AVG)
    AVG(CASE WHEN dir = 'long'  AND cohort = '1e0' THEN taker_bps_from_oracle END)
      OVER (PARTITION BY MarketIndex ORDER BY Time RANGE BETWEEN INTERVAL '${smoothingMinutes}' MINUTE PRECEDING AND CURRENT ROW)
      AS "TakerBuyBpsFromOracle_1e0",

    AVG(CASE WHEN dir = 'long'  AND cohort = '1e3' THEN taker_bps_from_oracle END)
      OVER (PARTITION BY MarketIndex ORDER BY Time RANGE BETWEEN INTERVAL '${smoothingMinutes}' MINUTE PRECEDING AND CURRENT ROW)
      AS "TakerBuyBpsFromOracle_1e3",

    AVG(CASE WHEN dir = 'long'  AND cohort = '1e4' THEN taker_bps_from_oracle END)
      OVER (PARTITION BY MarketIndex ORDER BY Time RANGE BETWEEN INTERVAL '${smoothingMinutes}' MINUTE PRECEDING AND CURRENT ROW)
      AS "TakerBuyBpsFromOracle_1e4",

    AVG(CASE WHEN dir = 'long'  AND cohort = '1e5' THEN taker_bps_from_oracle END)
      OVER (PARTITION BY MarketIndex ORDER BY Time RANGE BETWEEN INTERVAL '${smoothingMinutes}' MINUTE PRECEDING AND CURRENT ROW)
      AS "TakerBuyBpsFromOracle_1e5",

    AVG(CASE WHEN dir = 'long'  AND cohort = '1e6' THEN taker_bps_from_oracle END)
      OVER (PARTITION BY MarketIndex ORDER BY Time RANGE BETWEEN INTERVAL '${smoothingMinutes}' MINUTE PRECEDING AND CURRENT ROW)
      AS "TakerBuyBpsFromOracle_1e6",

    AVG(CASE WHEN dir = 'short' AND cohort = '1e0' THEN taker_bps_from_oracle END)
      OVER (PARTITION BY MarketIndex ORDER BY Time RANGE BETWEEN INTERVAL '${smoothingMinutes}' MINUTE PRECEDING AND CURRENT ROW)
      AS "TakerSellBpsFromOracle_1e0",

    AVG(CASE WHEN dir = 'short' AND cohort = '1e3' THEN taker_bps_from_oracle END)
      OVER (PARTITION BY MarketIndex ORDER BY Time RANGE BETWEEN INTERVAL '${smoothingMinutes}' MINUTE PRECEDING AND CURRENT ROW)
      AS "TakerSellBpsFromOracle_1e3",

    AVG(CASE WHEN dir = 'short' AND cohort = '1e4' THEN taker_bps_from_oracle END)
      OVER (PARTITION BY MarketIndex ORDER BY Time RANGE BETWEEN INTERVAL '${smoothingMinutes}' MINUTE PRECEDING AND CURRENT ROW)
      AS "TakerSellBpsFromOracle_1e4",

    AVG(CASE WHEN dir = 'short' AND cohort = '1e5' THEN taker_bps_from_oracle END)
      OVER (PARTITION BY MarketIndex ORDER BY Time RANGE BETWEEN INTERVAL '${smoothingMinutes}' MINUTE PRECEDING AND CURRENT ROW)
      AS "TakerSellBpsFromOracle_1e5",

    AVG(CASE WHEN dir = 'short' AND cohort = '1e6' THEN taker_bps_from_oracle END)
      OVER (PARTITION BY MarketIndex ORDER BY Time RANGE BETWEEN INTERVAL '${smoothingMinutes}' MINUTE PRECEDING AND CURRENT ROW)
      AS "TakerSellBpsFromOracle_1e6",
    
    ROW_NUMBER() OVER (PARTITION BY MarketIndex ORDER BY Time DESC) AS rn
  FROM bucketed
  WHERE taker_bps_from_oracle IS NOT NULL
)

-- Select only the latest row per market
SELECT
  Time,
  MarketIndex,
  "TakerBuyBpsFromOracle_ALL",
  "TakerSellBpsFromOracle_ALL",
  "TakerBuyBpsFromOracle_1e0",
  "TakerBuyBpsFromOracle_1e3",
  "TakerBuyBpsFromOracle_1e4",
  "TakerBuyBpsFromOracle_1e5",
  "TakerBuyBpsFromOracle_1e6",
  "TakerSellBpsFromOracle_1e0",
  "TakerSellBpsFromOracle_1e3",
  "TakerSellBpsFromOracle_1e4",
  "TakerSellBpsFromOracle_1e5",
  "TakerSellBpsFromOracle_1e6"
FROM rolling_avgs
WHERE rn = 1
ORDER BY MarketIndex;
		`;

		const results = await query(queryString);

		return results.map((result) => ({
			MarketIndex: result.MarketIndex || '',
			TakerBuyBpsFromOracle_ALL: result.TakerBuyBpsFromOracle_ALL,
			TakerSellBpsFromOracle_ALL: result.TakerSellBpsFromOracle_ALL,
			TakerBuyBpsFromOracle_1e0: result.TakerBuyBpsFromOracle_1e0,
			TakerBuyBpsFromOracle_1e3: result.TakerBuyBpsFromOracle_1e3,
			TakerBuyBpsFromOracle_1e4: result.TakerBuyBpsFromOracle_1e4,
			TakerBuyBpsFromOracle_1e5: result.TakerBuyBpsFromOracle_1e5,
			TakerBuyBpsFromOracle_1e6: result.TakerBuyBpsFromOracle_1e6,
			TakerSellBpsFromOracle_1e0: result.TakerSellBpsFromOracle_1e0,
			TakerSellBpsFromOracle_1e3: result.TakerSellBpsFromOracle_1e3,
			TakerSellBpsFromOracle_1e4: result.TakerSellBpsFromOracle_1e4,
			TakerSellBpsFromOracle_1e5: result.TakerSellBpsFromOracle_1e5,
			TakerSellBpsFromOracle_1e6: result.TakerSellBpsFromOracle_1e6,
			Zero: result.Zero || '0',
		}));
	};

	return {
		getTakerFillVsOracleBps,
	};
};
