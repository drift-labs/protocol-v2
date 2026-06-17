import {
	AuctionLatencyStats,
	BaseDynamoRecord,
	FillBitFlag,
	FillCohort,
	FillDirection,
	FillLiquiditySourceStats,
	FillTakerOrderType,
	TriggerOrderFillStats,
} from '@backend/common';
import {
	ANALYTICS_PK,
	AUCTION_LATENCY_ID,
	DynamoDB,
	getBaseRecordFields,
	LIQUIDITY_SOURCE_ID,
	TRIGGER_ORDER_FILL_ID,
} from '..';

// TODO: update this to have more filters for the new fields..
export function getAuctionLatencyPk(
	market: string,
	cohort: FillCohort,
	bitFlags: FillBitFlag,
	takerOrderType: FillTakerOrderType,
	takerOrderDirection: FillDirection
) {
	return `${ANALYTICS_PK}#${AUCTION_LATENCY_ID}#${market}#D#${cohort}#${bitFlags}#${takerOrderType}#${takerOrderDirection}`;
}

export function getTriggerOrderFillPk(
	market: string,
	orderType: 'triggerMarket' | 'triggerLimit' | 'all',
	cohort: string
) {
	return `${ANALYTICS_PK}#${TRIGGER_ORDER_FILL_ID}#${market}#${orderType}#${cohort}`;
}

export function getLiquiditySourcePk(
	market: string,
	cohort: FillCohort,
	takerOrderType: FillTakerOrderType,
	bitFlag: FillBitFlag
) {
	return `${ANALYTICS_PK}#${LIQUIDITY_SOURCE_ID}#${market}#${cohort}#${takerOrderType}#${bitFlag}`;
}

export const AnalyticsRepository = () => {
	const { batchWrite, query } = DynamoDB({ overrideTableName: process.env.ANALYTICS_TABLE });

	const createAuctionLatencyStats = async (unixTimeS: number, stats: AuctionLatencyStats[]) => {
		const records = stats.map((stat) => ({
			pk: getAuctionLatencyPk(
				stat.market,
				stat.cohort,
				stat.bitFlag,
				stat.takerOrderType,
				stat.takerOrderDirection
			),
			sk: unixTimeS.toString(),
			...stat,
			...getBaseRecordFields({ ts: unixTimeS * 1000 } as any),
		}));

		return batchWrite({ records });
	};

	const getAuctionLatencyStatsForMarket = async ({
		market,
		cohort = 'all',
		bitFlags,
		takerOrderType,
		takerOrderDirection,
		limit = 100,
	}: {
		market: string;
		cohort?: FillCohort;
		bitFlags: FillBitFlag;
		takerOrderType: FillTakerOrderType;
		takerOrderDirection: FillDirection;
		limit?: number;
	}): Promise<(AuctionLatencyStats & BaseDynamoRecord)[]> => {
		const pk = getAuctionLatencyPk(
			market,
			cohort,
			bitFlags,
			takerOrderType,
			takerOrderDirection
		);
		const queryParams = {
			pk,
			expression: 'pk = :pk',
			expressionValues: {
				':pk': pk,
			},
			limit,
		};

		const result = await query(queryParams);

		const { Items = [] } = result;
		return Items as (AuctionLatencyStats & BaseDynamoRecord)[];
	};

	const getAuctionLatencyStatsBetweenTimestamps = async ({
		market,
		cohort = '1000',
		startUnixTimeS,
		endUnixTimeS,
		bitFlags,
		takerOrderType,
		takerOrderDirection,
		limit = 20,
	}: {
		market: string;
		cohort?: FillCohort;
		startUnixTimeS: number;
		endUnixTimeS: number;
		bitFlags: FillBitFlag;
		takerOrderType: FillTakerOrderType;
		takerOrderDirection: FillDirection;
		limit?: number;
	}): Promise<(AuctionLatencyStats & BaseDynamoRecord)[]> => {
		const pk = getAuctionLatencyPk(
			market,
			cohort,
			bitFlags,
			takerOrderType,
			takerOrderDirection
		);
		const queryParams = {
			pk,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			limit,
			expressionValues: {
				':pk': pk,
				':startSk': startUnixTimeS.toString(),
				':endSk': endUnixTimeS.toString(),
			},
		};

		const result = await query(queryParams);

		const { Items = [] } = result;
		return Items as (AuctionLatencyStats & BaseDynamoRecord)[];
	};

	const getOldestAuctionLatencyStats = async (
		market: string
	): Promise<(AuctionLatencyStats & BaseDynamoRecord) | null> => {
		const pk = getAuctionLatencyPk(market, 'all', 'all', 'all', 'all');
		const { Items = [] } = await query({
			pk,
			expression: 'pk = :pk',
			expressionValues: {
				':pk': pk,
			},
			limit: 1,
			orderAsc: true,
		});

		return Items.length > 0 ? (Items[0] as AuctionLatencyStats & BaseDynamoRecord) : null;
	};

	const createTriggerOrderFillStats = async (
		unixTimeS: number,
		stats: TriggerOrderFillStats[]
	) => {
		const records = stats.map((stat) => ({
			pk: getTriggerOrderFillPk(stat.market, stat.orderType, stat.cohort),
			sk: unixTimeS.toString(),
			...stat,
			...getBaseRecordFields({ ts: unixTimeS * 1000 } as any),
		}));

		return batchWrite({ records });
	};

	const getTriggerOrderFillStatsForMarket = async ({
		market,
		orderType,
		cohort = '0',
		limit = 100,
	}: {
		market: string;
		orderType: 'triggerMarket' | 'triggerLimit' | 'all';
		cohort?: string;
		limit?: number;
	}): Promise<(TriggerOrderFillStats & BaseDynamoRecord)[]> => {
		const pk = getTriggerOrderFillPk(market, orderType, cohort);
		const { Items = [] } = await query({
			pk,
			expression: 'pk = :pk',
			expressionValues: {
				':pk': pk,
			},
			limit,
		});

		return Items as (TriggerOrderFillStats & BaseDynamoRecord)[];
	};

	const getTriggerOrderFillStatsBetweenTimestamps = async ({
		market,
		startUnixTimeS,
		endUnixTimeS,
		orderType,
		cohort = '0',
		limit = 100,
	}: {
		market: string;
		startUnixTimeS: number;
		endUnixTimeS: number;
		orderType: 'triggerMarket' | 'triggerLimit' | 'all';
		cohort?: string;
		limit?: number;
	}): Promise<(TriggerOrderFillStats & BaseDynamoRecord)[]> => {
		const pk = getTriggerOrderFillPk(market, orderType, cohort);
		const queryParams = {
			pk,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			limit,
			expressionValues: {
				':pk': pk,
				':startSk': startUnixTimeS.toString(),
				':endSk': endUnixTimeS.toString(),
			},
		};

		const result = await query(queryParams);

		const { Items = [] } = result;
		return Items as (TriggerOrderFillStats & BaseDynamoRecord)[];
	};

	const getOldestTriggerOrderFillStats = async (
		market: string,
		orderType: 'triggerMarket' | 'triggerLimit' | 'all',
		cohort = '0'
	): Promise<(TriggerOrderFillStats & BaseDynamoRecord) | null> => {
		const pk = getTriggerOrderFillPk(market, orderType, cohort);
		const { Items = [] } = await query({
			pk,
			expression: 'pk = :pk',
			expressionValues: {
				':pk': pk,
			},
			limit: 1,
			orderAsc: true,
		});

		return Items.length > 0 ? (Items[0] as TriggerOrderFillStats & BaseDynamoRecord) : null;
	};

	const createLiquiditySourceStats = async (
		unixTimeS: number,
		stats: FillLiquiditySourceStats[]
	) => {
		// Create individual records for each stat combination
		const records = stats.map((stat) => ({
			pk: getLiquiditySourcePk(
				stat.market || `${stat.marketType}-${stat.marketIndex}`,
				stat.cohort,
				stat.takerOrderType,
				stat.bitFlag
			),
			sk: unixTimeS.toString(),
			...stat,
			...getBaseRecordFields({ ts: unixTimeS * 1000 } as any),
		}));

		return batchWrite({ records });
	};

	const getLiquiditySourceStatsForMarket = async ({
		market,
		cohort = 'all',
		takerOrderType = 'all',
		bitFlag = 'all',
		limit = 100,
	}: {
		market: string;
		cohort: FillCohort;
		takerOrderType: FillTakerOrderType;
		bitFlag: FillBitFlag;
		limit?: number;
	}): Promise<(FillLiquiditySourceStats & BaseDynamoRecord)[]> => {
		const pk = getLiquiditySourcePk(market, cohort, takerOrderType, bitFlag);
		const { Items = [] } = await query({
			pk,
			expression: 'pk = :pk',
			expressionValues: {
				':pk': pk,
			},
			limit,
		});

		return Items as (FillLiquiditySourceStats & BaseDynamoRecord)[];
	};

	const getLiquiditySourceStatsBetweenTimestamps = async ({
		market,
		cohort = 'all',
		takerOrderType = 'all',
		bitFlag = 'all',
		startUnixTimeS,
		endUnixTimeS,
		limit = 100,
	}: {
		market: string;
		cohort: FillCohort;
		takerOrderType: FillTakerOrderType;
		bitFlag: FillBitFlag;
		startUnixTimeS: number;
		endUnixTimeS: number;
		limit?: number;
	}): Promise<(FillLiquiditySourceStats & BaseDynamoRecord)[]> => {
		const pk = getLiquiditySourcePk(market, cohort, takerOrderType, bitFlag);
		const queryParams = {
			pk,
			expression: 'pk = :pk AND sk BETWEEN :startSk AND :endSk',
			limit,
			expressionValues: {
				':pk': pk,
				':startSk': startUnixTimeS.toString(),
				':endSk': endUnixTimeS.toString(),
			},
		};

		const result = await query(queryParams);

		const { Items = [] } = result;
		return Items as (FillLiquiditySourceStats & BaseDynamoRecord)[];
	};

	const getOldestLiquiditySourceStats = async (
		market: string,
		cohort: FillCohort,
		takerOrderType: FillTakerOrderType,
		bitFlag: FillBitFlag
	): Promise<(FillLiquiditySourceStats & BaseDynamoRecord) | null> => {
		const pk = getLiquiditySourcePk(market, cohort, takerOrderType, bitFlag);
		const { Items = [] } = await query({
			pk,
			expression: 'pk = :pk',
			expressionValues: {
				':pk': pk,
			},
			limit: 1,
			orderAsc: true,
		});

		return Items.length > 0 ? (Items[0] as FillLiquiditySourceStats & BaseDynamoRecord) : null;
	};

	return {
		createAuctionLatencyStats,
		getAuctionLatencyStatsForMarket,
		getAuctionLatencyStatsBetweenTimestamps,
		getOldestAuctionLatencyStats,
		createTriggerOrderFillStats,
		getTriggerOrderFillStatsForMarket,
		getTriggerOrderFillStatsBetweenTimestamps,
		getOldestTriggerOrderFillStats,
		createLiquiditySourceStats,
		getLiquiditySourceStatsForMarket,
		getLiquiditySourceStatsBetweenTimestamps,
		getOldestLiquiditySourceStats,
	};
};
