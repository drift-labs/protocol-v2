import { RateHistoryType } from '@backend/common';
import { Prometheus } from '../client';

const SMALL_STEP = 10000;
const LARGE_STEP = 86400;
const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;

export const RatesRepository = () => {
	const { fetchRangeData } = Prometheus();

	const fetchLpPerformance = async ({
		symbol,
		start,
		end,
		type = 'pct',
	}: {
		symbol: string;
		start: number;
		end: number;
		type?: 'raw' | 'pct';
	}) => {
		const rawQuery = `((sum(amm_quote_asset_amount_per_lp{market="${symbol}"}) / ((sum(10 ^ amm_per_lp_base{market="${symbol}"}) or vector(1))) - sum(amm_quote_asset_amount_per_lp{market =~ "${symbol}"} @ start()) / (sum(10 ^ (amm_per_lp_base{market="${symbol}"} @ start())) or vector(1))+((sum(amm_base_asset_amount_per_lp{market="${symbol}"}) / ((sum(10 ^ amm_per_lp_base{market="${symbol}"}) or vector(1))) - sum(amm_base_asset_amount_per_lp{market =~ "${symbol}"} @ start()) / (sum(10 ^ (amm_per_lp_base{market="${symbol}"} @ start())) or vector(1))) * sum(oracle_price{market =~ "${symbol}"})))) `;
		const pctQuery = `((((sum(amm_quote_asset_amount_per_lp{market="${symbol}"}) / ((sum(10 ^ amm_per_lp_base{market="${symbol}"}) or vector(1))) - sum(amm_quote_asset_amount_per_lp{market =~ "${symbol}"} @ start()) / (sum(10 ^ (amm_per_lp_base{market="${symbol}"} @ start())) or vector(1))+((sum(amm_base_asset_amount_per_lp{market="${symbol}"}) / ((sum(10 ^ amm_per_lp_base{market="${symbol}"}) or vector(1))) - sum(amm_base_asset_amount_per_lp{market =~ "${symbol}"} @ start()) / (sum(10 ^ (amm_per_lp_base{market="${symbol}"} @ start())) or vector(1))) * sum(oracle_price{market =~ "${symbol}"})))))/sum((((amm_ask_liquidity{market="${symbol}"} @ start() / amm_sqrt_k{market="${symbol}"} @ start()) * oracle_price{market="${symbol}"} @ start()) > ((amm_bid_liquidity{market="${symbol}"} @ start() / amm_sqrt_k{market="${symbol}"} @ start()) * oracle_price{market="${symbol}"} @ start()) and ((amm_ask_liquidity{market="${symbol}"} @ start() / amm_sqrt_k{market="${symbol}"} @ start()) * oracle_price{market="${symbol}"} @ start()) or ((amm_bid_liquidity{market="${symbol}"} @ start() / amm_sqrt_k{market="${symbol}"} @ start()) * oracle_price{market="${symbol}"} @ start())))) * 100`;
		const query = type === 'raw' ? rawQuery : pctQuery;

		const timeRange = end - start;
		const step = timeRange > SEVEN_DAYS_IN_SECONDS ? LARGE_STEP : SMALL_STEP;
		return fetchRangeData({ query, start, end, step });
	};

	const fetchRateHistory = async ({
		symbol,
		start,
		end,
		type = RateHistoryType.DEPOSIT,
	}: {
		symbol: string;
		start: number;
		end: number;
		type?: RateHistoryType;
	}) => {
		const metric = type.includes('balance') ? `spot_${type}` : `spot_${type}_rate`;
		const query = `avg(${metric}{market="${symbol}"})`;
		const timeRange = end - start;
		const step = timeRange > SEVEN_DAYS_IN_SECONDS ? LARGE_STEP : SMALL_STEP;
		return fetchRangeData({ query, start, end, step });
	};

	return {
		fetchLpPerformance,
		fetchRateHistory,
	};
};
