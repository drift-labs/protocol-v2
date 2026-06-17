import { Athena, getTimePartition } from '@backend/athena';
import { getPerpMarketSymbol, getSpotMarketSymbol, getTimestamp, logger } from '@backend/common';
import { StatsCacheRepository } from '@backend/redis';
import {
	BigNum,
	VelocityClient,
	FUNDING_RATE_BUFFER_PRECISION,
	FUNDING_RATE_PRECISION_EXP,
	PERCENTAGE_PRECISION_EXP,
	PRICE_PRECISION,
	PRICE_PRECISION_EXP,
	QUOTE_PRECISION_EXP,
} from '@velocity-exchange/sdk';
import { Scheduler } from '../services/scheduler';

const { query } = Athena();
const { setFundingRateStats, setInsuranceFundStats } = StatsCacheRepository();

const FUNDING_RATE_RECORD_TABLE = 'eventtype_fundingraterecord';
const INSURANCE_FUND_RECORD_TABLE = 'eventtype_insurancefundrecord';
const LIQUIDATION_RECORD_TABLE = 'eventtype_liquidationrecord';

const getAverageFundingRates = async (marketIndices: number[]) => {
	const day365Ts = getTimestamp({ days: -365 });
	const currentTs = getTimestamp();

	const queryString = `
    ${getTimePartition(day365Ts, currentTs)},
	time_periods AS (
        SELECT ${getTimestamp({ days: -1 })} as day_1_ts,
            ${getTimestamp({ days: -7 })} as day_7_ts,
            ${getTimestamp({ days: -30 })} as day_30_ts,
            ${day365Ts} as day_365_ts
    ),
    funding_records AS (
        SELECT DISTINCT 
			marketindex,
            ts,
            fundingratelong,
            oraclepricetwap
        FROM ${FUNDING_RATE_RECORD_TABLE}
		CROSS JOIN time_range 
        WHERE
			marketindex IN (${marketIndices.join(',')})
            AND CAST(ts AS BIGINT) BETWEEN time_range.from_ts AND time_range.to_ts
            AND CONCAT(year, month, day) BETWEEN time_range.from_date AND time_range.to_date
    ),
    funding_calculations AS (
        SELECT marketindex,
            ts,
            (
                CAST(fundingratelong AS DOUBLE) * ${PRICE_PRECISION.toNumber() * 100}
            ) / CAST(oraclepricetwap AS DOUBLE) / ${PRICE_PRECISION.toNumber()} / ${FUNDING_RATE_BUFFER_PRECISION.toNumber()} as normalized_funding_rate
        FROM funding_records
		CROSS JOIN time_periods
    )
    SELECT marketindex,
        SUM(
            CASE
                WHEN CAST(ts AS BIGINT) >= (
                    SELECT day_1_ts
                    FROM time_periods
                ) THEN normalized_funding_rate
            END
        ) / NULLIF(
            COUNT(
                CASE
                    WHEN CAST(ts AS BIGINT) >= (
                        SELECT day_1_ts
                        FROM time_periods
                    ) THEN 1
                END
            ),
            0
        ) as avg_24h,
        SUM(
            CASE
                WHEN CAST(ts AS BIGINT) >= (
                    SELECT day_7_ts
                    FROM time_periods
                ) THEN normalized_funding_rate
            END
        ) / NULLIF(
            COUNT(
                CASE
                    WHEN CAST(ts AS BIGINT) >= (
                        SELECT day_7_ts
                        FROM time_periods
                    ) THEN 1
                END
            ),
            0
        ) as avg_7d,
        SUM(
            CASE
                WHEN CAST(ts AS BIGINT) >= (
                    SELECT day_30_ts
                    FROM time_periods
                ) THEN normalized_funding_rate
            END
        ) / NULLIF(
            COUNT(
                CASE
                    WHEN CAST(ts AS BIGINT) >= (
                        SELECT day_30_ts
                        FROM time_periods
                    ) THEN 1
                END
            ),
            0
        ) as avg_30d,
        SUM(normalized_funding_rate) / NULLIF(COUNT(*), 0) as avg_1y
    FROM funding_calculations
    GROUP BY marketindex`;

	const results = await query(queryString);

	const fundingRateStats = marketIndices.map((marketIndex) => {
		const result = results.find((row) => row.marketindex === marketIndex.toString());
		return {
			marketIndex,
			symbol: getPerpMarketSymbol(marketIndex),
			fundingRates: {
				'24h': result
					? Number(result.avg_24h).toFixed(FUNDING_RATE_PRECISION_EXP.toNumber()) || '0'
					: '0',
				'7d': result
					? Number(result.avg_7d).toFixed(FUNDING_RATE_PRECISION_EXP.toNumber()) || '0'
					: '0',
				'30d': result
					? Number(result.avg_30d).toFixed(FUNDING_RATE_PRECISION_EXP.toNumber()) || '0'
					: '0',
				'1y': result
					? Number(result.avg_1y).toFixed(FUNDING_RATE_PRECISION_EXP.toNumber()) || '0'
					: '0',
			},
		};
	});

	await setFundingRateStats(fundingRateStats);
};

const getInsuranceFundStats = async (driftClient: VelocityClient) => {
	const sevenDaysAgoTs = getTimestamp({ days: -7 });
	const currentTs = getTimestamp();

	const insuranceFundQuery = `
		${getTimePartition(sevenDaysAgoTs, currentTs)}
		SELECT DISTINCT
			spotmarketindex,
			ts,
			amount,
			insurancevaultamountbefore,
			totalifsharesbefore,
			totalifsharesafter
		FROM ${INSURANCE_FUND_RECORD_TABLE}
		CROSS JOIN time_range 
		WHERE 
			CAST(ts AS BIGINT) BETWEEN time_range.from_ts AND time_range.to_ts
			AND CONCAT(year, month, day) BETWEEN time_range.from_date AND time_range.to_date
		ORDER BY spotmarketindex, ts
	`;

	const liquidationQuery = `
		${getTimePartition(sevenDaysAgoTs, currentTs)}
		SELECT 
			SUM(CASE WHEN liquidationtype = 'liquidatePerp' THEN CAST(liquidateperp.ifFee AS DOUBLE) ELSE 0 END)  / ${PRICE_PRECISION.toNumber()} as perp_total,
			SUM(CASE WHEN liquidationtype = 'liquidateSpot' THEN CAST(liquidatespot.ifFee AS DOUBLE) ELSE 0 END)  / ${PRICE_PRECISION.toNumber()} as spot_total
		FROM (
			SELECT DISTINCT *
			FROM ${LIQUIDATION_RECORD_TABLE}
			CROSS JOIN time_range 
			WHERE
				CAST(ts as INT) BETWEEN time_range.from_ts AND time_range.to_ts
				AND CONCAT(year, month, day) BETWEEN time_range.from_date AND time_range.to_date
		) 
	`;

	const [ifRecords, liqResults] = await Promise.all([
		query(insuranceFundQuery),
		query(liquidationQuery),
	]);

	const spotMarkets = driftClient.getSpotMarketAccounts();

	const marketSharePriceData = spotMarkets.map((spotMarket) => {
		const marketIndex = spotMarket.marketIndex;
		const symbol = getSpotMarketSymbol(marketIndex);

		const marketRecords = ifRecords.filter((r) => r.spotmarketindex === marketIndex.toString());

		if (!marketRecords || marketRecords.length < 2) {
			return {
				marketIndex,
				totalRevenue: null,
				symbol,
				apy: null,
			};
		}

		if (!spotMarket) {
			return {
				marketIndex,
				totalRevenue: null,
				symbol,
				apy: null,
			};
		}

		const oraclePriceData = driftClient.getOracleDataForSpotMarket(marketIndex);
		const oraclePrice = BigNum.from(oraclePriceData.price, PRICE_PRECISION_EXP);
		const precision = spotMarket.decimals;

		const totalRevenue = marketRecords
			.map((record) =>
				BigNum.from(record.amount!, precision)
					.shiftTo(PRICE_PRECISION_EXP)
					.mul(oraclePrice)
					.toNum()
			)
			.reduce((a, b) => a + b, 0);

		const firstRecord = marketRecords[0];
		const lastRecord = marketRecords[marketRecords.length - 1];

		const startSharePrice = BigNum.from(firstRecord.insurancevaultamountbefore!, precision)
			.add(BigNum.from(firstRecord.amount!, precision))
			.scale(
				1000000,
				BigNum.from(firstRecord.totalifsharesafter!, QUOTE_PRECISION_EXP).toNum() * 1000000
			)
			.toNum();

		const endSharePrice = BigNum.from(lastRecord.insurancevaultamountbefore!, precision)
			.add(BigNum.from(lastRecord.amount!, precision))
			.scale(
				1000000,
				BigNum.from(lastRecord.totalifsharesafter!, QUOTE_PRECISION_EXP).toNum() * 1000000
			)
			.toNum();

		let apy = 0;
		if (startSharePrice > 0 && endSharePrice > 0) {
			const sevenDayReturn = (endSharePrice - startSharePrice) / startSharePrice;
			const periodsPerYear = 365 / 7;
			const apyDecimal = Math.pow(1 + sevenDayReturn, periodsPerYear) - 1;
			apy = apyDecimal * 100;
		}

		return {
			marketIndex,
			symbol,
			totalRevenue: totalRevenue.toFixed(QUOTE_PRECISION_EXP.toNumber()),
			apy: apy.toFixed(PERCENTAGE_PRECISION_EXP.toNumber()),
		};
	});

	// Calculate total revenue
	const totalRevenue = marketSharePriceData.reduce(
		(sum, market) => sum + parseFloat(market.totalRevenue || '0'),
		0
	);

	const insuranceFundStats = {
		totalRevenue: totalRevenue.toFixed(QUOTE_PRECISION_EXP.toNumber()),
		perpLiqsTotal: Number(liqResults[0]?.perp_total).toFixed(QUOTE_PRECISION_EXP.toNumber()),
		spotLiqsTotal: Number(liqResults[0]?.spot_total).toFixed(QUOTE_PRECISION_EXP.toNumber()),
		marketSharePriceData: marketSharePriceData
			.map(({ marketIndex, symbol, apy }) => ({
				marketIndex,
				symbol,
				apy,
			}))
			.sort((a, b) => a.marketIndex - b.marketIndex),
	};

	await setInsuranceFundStats(insuranceFundStats);
};

export const setupStatsTasks = ({
	driftClient,
	scheduler,
}: {
	driftClient: VelocityClient;
	scheduler: ReturnType<typeof Scheduler>;
}) => {
	const perpMarkets = driftClient.getPerpMarketAccounts();

	scheduler.scheduleTask('funding-rate-stats', '*/30 * * * *', async () => {
		const marketIndices = perpMarkets.map((m) => m.marketIndex);
		if (marketIndices.length === 0) {
			logger.warn('Skipping funding-rate-stats: no perp markets available');
			return;
		}
		await getAverageFundingRates(marketIndices);
		logger.info(`Stored funding rate stats for ${marketIndices.length} markets`);
	});

	scheduler.scheduleTask('insurance-fund-stats', '*/30 * * * *', async () => {
		await getInsuranceFundStats(driftClient);
		logger.info(`Stored insurance fund stats for spot markets`);
	});
};
