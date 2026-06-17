import {
	CandleResolutions,
	LeaderboardSort,
	RateHistoryType,
	VolumeInterval,
} from '@backend/common';

export type CacheProxyAction =
	| {
			type: 'getCandlesForResolution';
			params: {
				symbol: string;
				resolution: CandleResolutions;
				limit: number;
			};
	  }
	| {
			type: 'getCandlesBetweenTimestampsForResolution';
			params: {
				symbol: string;
				resolution: CandleResolutions;
				startTs: number;
				endTs?: number;
				limit: number;
			};
	  }
	| {
			type: 'getLiquidationStats';
	  }
	| {
			type: 'getBankruptcyStats';
	  }
	| {
			type: 'getVaultStats';
	  }
	| {
			type: 'getFundingRateStats';
	  }
	| {
			type: 'getInsuranceFundStats';
	  }
	| {
			type: 'getRateHistory';
			params: {
				symbol: string;
				type: RateHistoryType;
			};
	  }
	| {
			type: 'getMarketsVolume';
			params: {
				interval: VolumeInterval;
			};
	  }
	| {
			type: 'getMarketSummary';
	  }
	| {
			type: 'getLeaderboard';
			params: {
				sort: LeaderboardSort;
				page: number;
				limit: number;
			};
	  }
	| {
			type: 'getLeaderboardRank';
			params: { authority: string };
	  }
	| {
			type: 'getUserVolumeAndFees';
			params: { user: string };
	  }
	| {
			type: 'getTokenStats';
	  };

export type TransformCondition = (record: any) => boolean;
export type TransformFunction = (value: any, record: any) => any;

export interface TransformRule {
	condition: TransformCondition;
	transform: TransformFunction;
	fields: string[];
}

export interface TransformConfig {
	name: string;
	description: string;
	rules: TransformRule[];
}
